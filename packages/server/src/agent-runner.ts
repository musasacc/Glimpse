/**
 * The built-in agent: when the human sends a request, edits or a variants job and no external agent
 * (`glimpse wait`, the MCP server) is listening, Glimpse runs the AI itself — the Claude Code CLI, the Codex CLI
 * or a model's API (Anthropic through its SDK; OpenAI, Gemini, OpenRouter and Ollama through the OpenAI SDK's
 * Chat Completions) — in the project folder, one run at a time, and streams its progress to the editor.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { KEY_PROVIDERS, PROVIDERS, API_PROVIDERS, type ApiProvider, type KeyProvider, type Quality } from "./agent-providers.js";
import {
  clearOllamaCache,
  detectAgents,
  detectOllama,
  effectiveModel,
  envApiKey,
  findAgentBinary,
  loadAgentSettings,
  ollamaUrl,
  resolveApiKey,
  type AgentEngine,
  type AgentSettings,
  type DetectedAgents,
  type OllamaStatus,
} from "./agent-settings.js";
import type { Handoff } from "./server.js";
import { baseEnv, killProcessTree, killProcessTreeSync, settled } from "./terminal.js";
import type { AgentApiInfo, AgentInfo, AgentRunEvent, AgentRunState, BuiltInEngine, ResolvedEngine } from "./agent-types.js";

export type { AgentApiInfo, AgentInfo, AgentRunEvent, AgentRunState, BuiltInEngine, ResolvedEngine };

export interface AgentRunnerDeps {
  /** The project folder: where the agent runs and the only place it writes. */
  dir: string;
  broadcast(msg: object): void;
  /** An external agent is listening right now (it takes precedence). */
  externalWaiting(): boolean;
  /**
   * An external agent (MCP, `glimpse wait`) is attached to this session, though perhaps busy with a request between
   * two waits: "auto" then leaves new requests to it instead of starting a second agent in the same folder.
   */
  externalAttached?(): boolean;
  /** Handoffs no agent has received yet (run when an engine becomes available). */
  pending?(): Handoff[];
  /** A run failed or was stopped: give the handoff back (not delivered), with why, so it can be retried or taken by an external agent. */
  release?(h: Handoff, error: string): void;
  /** The current state of a handoff (it may have been delivered to an external agent or withdrawn meanwhile). */
  handoff(seq: number): Handoff | undefined;
  /** Mark it delivered (to the built-in agent). */
  claim(h: Handoff): void;
  /** The agent's round of saves starts or ends (record what's pending as a version). */
  roundEnd(): void;
  /** The full instructions for the built-in agent. */
  prompt(h: Handoff): string;
  /** Absolute path of the handoff's screenshot, if it has one. */
  screenshot(h: Handoff): string | undefined;
  /** Absolute path of the screenshot of the UI before the human's edits, if it has one. */
  screenshotBefore?(h: Handoff): string | undefined;
  /** How long detected engines are cached (ms); tests shorten it. */
  detectTtlMs?: number;
}

const DETECT_TTL_MS = 30_000;
const KEEP_OUTPUT_LINES = 40;
const MAX_LINE = 300;
const STOP_GRACE_MS = 3000;
const API_MAX_TOKENS = 64_000;
/** Anthropic's effort for each quality setting (Opus 5.5 defaults to medium, so it is always sent). */
const ANTHROPIC_EFFORT: Record<Quality, "low" | "medium" | "high"> = { fast: "low", balanced: "medium", best: "high" };
/** OpenAI-style reasoning effort for each quality setting (sent to OpenAI and Gemini reasoning models only). */
const REASONING_EFFORT: Record<Quality, "low" | "medium" | "high"> = { fast: "low", balanced: "medium", best: "high" };
const CODEX_LINES_PER_SEC = 10;
/** How long an engine that failed to sign in is skipped by "auto". */
const SIGNED_OUT_MS = 10 * 60_000;
const ENGINE_NAMES: Record<BuiltInEngine, string> = { claude: "Claude Code", codex: "Codex", api: "Claude (API)" };

/** What a run is called in the activity feed ("Claude Code", "OpenAI · gpt-5", "Ollama · llama3.2"). */
function engineLabel(engine: BuiltInEngine, settings: AgentSettings, model?: string): string {
  if (engine !== "api") return ENGINE_NAMES[engine];
  const p = settings.api.provider;
  if (p === "anthropic") return model ? `Claude API · ${model}` : ENGINE_NAMES.api;
  return model ? `${PROVIDERS[p].name} · ${model}` : PROVIDERS[p].name;
}

/** The request plus the human's standing instructions (AI settings → Behavior). */
export function withInstructions(prompt: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return extra ? `${prompt}\n\n## Standing instructions from the human (AI settings)\n\n${extra}\n` : prompt;
}
const SIGN_IN_RE = /oauth|authenticat|not logged in|log ?in\b|unauthori[sz]ed|\b401\b/i;
/** What a CLI prints for a bad command line: noise in the activity feed. */
const USAGE_RE = /^(usage:|for more information|\s+codex exec\b|\s*codex exec \[)/i;

/** The CLI's sign-in is missing or expired: what to do about it. */
class SignInError extends Error {
  constructor(readonly engine: "claude" | "codex") {
    super(
      engine === "claude"
        ? "Claude Code isn't signed in (or the sign-in expired). Open Terminal, run `claude` and type /login, then send again."
        : "Codex isn't signed in. Open Terminal and run `codex login`, then send again.",
    );
  }
}

/** The options this Codex accepts, from `codex exec --help` (they changed between versions). Only answers are cached. */
const codexHelp = new Map<string, Promise<string>>();
function readCodexHelp(bin: string): Promise<string> {
  let help = codexHelp.get(bin);
  if (!help) {
    const windows = process.platform === "win32";
    const probe = new Promise<string>((resolve) => {
      // On Windows the .cmd shim runs through the shell: quote it, or a path with a space ("C:\Users\Jane Doe\…") splits.
      execFile(windows ? `"${bin}"` : bin, ["exec", "--help"], { timeout: 10_000, shell: windows, windowsHide: true }, (err, stdout, stderr) => {
        const text = `${String(stdout)}\n${String(stderr)}`;
        // A failure or a timeout (a cold start) isn't this Codex's answer: ask again next time.
        if (err || !/--/.test(text)) codexHelp.delete(bin);
        resolve(text);
      });
    });
    help = probe;
    codexHelp.set(bin, help);
  }
  return help;
}

/** Above this the prompt goes on stdin on every platform (Linux caps one argument at 128 KiB; argv also shows in `ps`). */
const MAX_PROMPT_ARG_BYTES = 100 * 1024;

/**
 * `codex exec` arguments for this Codex, and whether the prompt goes on stdin (Windows: no user text on a shell
 * command line; elsewhere when the prompt is large).
 */
export async function codexArgs(bin: string, prompt: string, windows = process.platform === "win32"): Promise<{ args: string[]; stdin: boolean }> {
  const help = await readCodexHelp(bin);
  const args = ["exec"];
  for (const flag of ["--full-auto", "--skip-git-repo-check"]) if (help.includes(flag)) args.push(flag);
  if (!windows && Buffer.byteLength(prompt) <= MAX_PROMPT_ARG_BYTES) return { args: [...args, prompt], stdin: false };
  // Without a prompt argument (or with "-"), codex exec reads the instructions from stdin.
  if (/stdin/i.test(help) && /\B-\B|`-`|'-'/.test(help)) args.push("-");
  return { args, stdin: true };
}

/** Who handles a request, given the settings, what's installed and whether an external agent is listening. */
export function resolveEngine(preferred: AgentEngine, available: DetectedAgents, externalWaiting: boolean, externalAttached = false): ResolvedEngine {
  // An agent that is listening always gets the request first (it is handed over before Glimpse would start anything).
  if (externalWaiting || preferred === "external") return "external";
  // One attached to the session but busy (between two waits) gets it on its next wait: "auto" never starts a second agent next to it.
  if (preferred === "auto" && externalAttached) return "external";
  if (preferred === "auto") return available.claude ? "claude" : available.codex ? "codex" : available.api ? "api" : "none";
  return available[preferred] ? preferred : "none";
}

const isBuiltIn = (e: ResolvedEngine): e is BuiltInEngine => e === "claude" || e === "codex" || e === "api";

class StoppedError extends Error {
  constructor() {
    super("Stopped");
  }
}

interface Run extends AgentRunState {
  abort: AbortController;
  stopped: boolean;
  child?: ChildProcess;
  exited?: Promise<void>;
  done: Promise<void>;
}

export class AgentRunner {
  private queue: number[] = [];
  private current: Run | undefined;
  private closing = false;
  private detected: Detected | undefined;
  private detecting: Promise<Detected> | undefined;
  /** Engines whose sign-in failed lately: "auto" skips them for a while. */
  private signedOut = new Map<"claude" | "codex", number>();
  private readonly ttl: number;
  /** Looks again for an engine while requests wait for one (a CLI installed, the login shell's PATH adopted). */
  private readonly recheck: ReturnType<typeof setInterval>;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.ttl = deps.detectTtlMs ?? DETECT_TTL_MS;
    this.recheck = setInterval(() => {
      const pending = this.deps.pending?.() ?? [];
      if (!this.closing && !this.current && pending.some((h) => this.runnable(h))) void this.enqueue(pending).catch(() => undefined);
    }, this.ttl);
    this.recheck.unref();
  }

  /** Settings and detected engines, cached for a while (a CLI installed meanwhile shows up within 30 s). */
  private async detect(): Promise<Detected> {
    if (this.detected && Date.now() - this.detected.at < this.ttl) return this.detected;
    this.detecting ??= (async () => {
      try {
        const before = this.detected;
        const settings = await loadAgentSettings();
        const [agents, ollama] = await Promise.all([detectAgents(settings), detectOllama(ollamaUrl(settings))]);
        this.detected = { at: Date.now(), settings, agents, ollama };
        // An engine became available (or another one): requests that waited for one start now, and the editors hear of it.
        if (before && !this.closing) {
          const was = this.resolve(before.settings, before.agents);
          const now = this.resolve(settings, agents);
          if (was !== now) {
            this.infoChanged();
            if (isBuiltIn(now)) setTimeout(() => void this.enqueue(this.deps.pending?.() ?? []).catch(() => undefined), 0);
          }
        }
        return this.detected;
      } finally {
        this.detecting = undefined;
      }
    })();
    return this.detecting;
  }

  /** Forget the cached settings and detection (the settings changed). */
  refresh(): void {
    this.detected = undefined;
    clearOllamaCache();
    this.signedOut.clear();
  }

  /** Who'd run a handoff now: like resolveEngine, but "auto" skips engines that just failed to sign in. */
  private resolve(settings: AgentSettings, agents: DetectedAgents): ResolvedEngine {
    let usable = agents;
    if (settings.engine === "auto") {
      usable = { ...agents };
      for (const [engine, at] of this.signedOut) {
        if (Date.now() - at < SIGNED_OUT_MS) usable[engine] = false;
        else this.signedOut.delete(engine);
      }
    }
    return resolveEngine(settings.engine, usable, this.deps.externalWaiting(), this.deps.externalAttached?.() ?? false);
  }

  async info(): Promise<AgentInfo> {
    const { settings, agents, ollama } = await this.detect();
    const external = this.deps.externalWaiting() || (this.deps.externalAttached?.() ?? false);
    const run = this.current;
    return {
      engine: this.resolve(settings, agents),
      preferred: settings.engine,
      available: { ...agents, external },
      running: run ? { seq: run.seq, engine: run.engine, startedAt: run.startedAt } : null,
      queued: this.queue.length,
      api: apiInfo(settings, ollama),
      quality: settings.quality,
      allowCommands: settings.allowCommands,
      maxSteps: settings.maxSteps,
      customInstructions: settings.customInstructions ?? "",
    };
  }

  /** Tell the editors what changed (who'd get the next request, what runs, what's queued). */
  infoChanged(): void {
    if (this.closing) return;
    this.info().then(
      (info) => this.deps.broadcast({ type: "agent-info", info }),
      () => undefined,
    );
  }

  state(): AgentRunState | null {
    const r = this.current;
    return r ? { seq: r.seq, engine: r.engine, startedAt: r.startedAt, output: [...r.output] } : null;
  }

  /**
   * A new handoff: run it with the built-in agent, unless an external agent took it or nothing can run it (it then
   * waits). One whose run failed or was stopped only runs again when retried (`retry`).
   */
  async enqueue(handoffs: Handoff | Handoff[]): Promise<void> {
    const list = (Array.isArray(handoffs) ? handoffs : [handoffs]).filter((h) => this.runnable(h) && !this.queue.includes(h.seq) && this.current?.seq !== h.seq);
    if (list.length === 0 || this.closing) return;
    const { settings, agents } = await this.detect();
    if (!isBuiltIn(this.resolve(settings, agents))) return;
    for (const h of list) if (!this.queue.includes(h.seq)) this.queue.push(h.seq);
    this.infoChanged();
    this.pump();
  }

  private runnable(h: Handoff): boolean {
    return !h.delivered && !h.cancelled && h.kind !== "source" && h.runError === undefined;
  }

  /** Stop the run in progress (the next queued one starts). False when nothing runs. */
  stop(): boolean {
    const run = this.current;
    if (!run) return false;
    void this.kill(run);
    return true;
  }

  /** Glimpse is closing: drop the queue, stop the run and wait for it to end. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.recheck);
    this.queue = [];
    const run = this.current;
    if (run) {
      await this.kill(run);
      await settled(run.done, STOP_GRACE_MS + 2000);
    }
  }

  private async kill(run: Run): Promise<void> {
    if (run.stopped) return;
    run.stopped = true;
    run.abort.abort();
    const pid = run.child?.pid;
    if (pid && run.exited) {
      await killProcessTree(pid, "SIGTERM");
      if (!(await settled(run.exited, STOP_GRACE_MS))) await killProcessTree(pid, "SIGKILL");
    }
  }

  private pump(): void {
    if (this.current || this.closing) return;
    void (async () => {
      while (!this.current && !this.closing && this.queue.length > 0) {
        const seq = this.queue.shift()!;
        const h = this.deps.handoff(seq);
        // An external agent took it meanwhile, or it was withdrawn.
        if (!h || !this.runnable(h)) continue;
        const { settings, agents } = await this.detect();
        const engine = this.resolve(settings, agents);
        if (this.current || this.closing) {
          this.queue.unshift(seq);
          return;
        }
        if (!isBuiltIn(engine) || !this.runnable(h)) continue; // it stays queued for an external agent
        this.start(h, engine, settings);
      }
      this.infoChanged();
    })();
  }

  private start(h: Handoff, engine: BuiltInEngine, settings: AgentSettings): void {
    this.deps.claim(h);
    let finish!: () => void;
    const run: Run = {
      seq: h.seq,
      engine,
      startedAt: Date.now(),
      output: [],
      abort: new AbortController(),
      stopped: false,
      done: new Promise<void>((r) => (finish = r)),
    };
    this.current = run;
    this.deps.roundEnd();
    const model = engine === "api" ? effectiveModel(settings, this.detected?.ollama.models) : undefined;
    this.emit(run, "start", engineLabel(engine, settings, model));
    this.infoChanged();
    const prompt = withInstructions(this.deps.prompt(h), settings.customInstructions);
    const work =
      engine === "claude" ? this.runClaude(run, prompt, settings)
      : engine === "codex" ? this.runCodex(run, prompt)
      : settings.api.provider === "anthropic" ? this.runAnthropic(run, h, prompt, settings, model!)
      : this.runOpenAiCompatible(run, h, prompt, settings, model!);
    let fallback: BuiltInEngine | undefined;
    /** Why the run didn't finish: the handoff then goes back to waiting, so the human's edits aren't lost. */
    let failed: string | undefined;
    work
      .then((summary) => {
        if (run.stopped) throw new StoppedError();
        this.emit(run, "done", summary ? oneLine(summary) : undefined);
      })
      .catch(async (err: unknown) => {
        if (run.stopped || err instanceof StoppedError) {
          failed = "Stopped";
          return this.emit(run, "error", "Stopped");
        }
        if (err instanceof SignInError) {
          this.signedOut.set(err.engine, Date.now());
          // "Auto" picked an engine that isn't signed in: hand the same request to the next one.
          if (settings.engine === "auto" && !this.closing) {
            const { agents } = await this.detect();
            const next = this.resolve(settings, agents);
            if (isBuiltIn(next) && next !== engine) {
              fallback = next;
              return this.output(run, `${ENGINE_NAMES[engine]} isn't signed in, trying ${ENGINE_NAMES[next]}…`);
            }
          }
        }
        failed = describeError(err);
        this.emit(run, "error", failed);
      })
      .finally(() => {
        this.deps.roundEnd();
        this.current = undefined;
        finish();
        if (fallback && !this.closing) return this.start(h, fallback, settings);
        if (failed !== undefined && !this.closing) this.deps.release?.(h, failed);
        this.infoChanged();
        this.pump();
      });
  }

  private emit(run: Run, event: AgentRunEvent["event"], text?: string): void {
    const msg: AgentRunEvent = { type: "agent-run", event, seq: run.seq, engine: run.engine, ...(text !== undefined && { text }), at: Date.now() };
    this.deps.broadcast(msg);
  }

  private output(run: Run, text: string): void {
    const line = oneLine(text);
    if (!line || run.stopped) return;
    run.output.push(line);
    if (run.output.length > KEEP_OUTPUT_LINES) run.output.splice(0, run.output.length - KEEP_OUTPUT_LINES);
    this.emit(run, "output", line);
  }

  /* ── CLI engines ─────────────────────────────────────────────────────── */

  /** Run a CLI in the project folder with the prompt on stdin; resolves with its exit code. */
  private spawnCli(run: Run, bin: string, args: string[], prompt: string | undefined, onLine: (line: string, stream: "out" | "err") => void): Promise<number | null> {
    // Stopped while getting ready (Codex's option probe takes seconds): nothing may start after that.
    if (run.stopped) return Promise.reject(new StoppedError());
    const isWindows = process.platform === "win32";
    const env = baseEnv();
    // Started from inside a Claude Code session (MCP glimpse_open): the nested CLI is a session of its own.
    delete env.CLAUDECODE;
    // On Windows the CLIs are .cmd shims, which only run through the shell. The arguments are fixed literals.
    const child = spawn(isWindows ? `"${bin}"` : bin, args, {
      cwd: this.deps.dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      shell: isWindows,
      windowsHide: true,
    });
    run.child = child;
    const onExit = () => child.pid && killProcessTreeSync(child.pid);
    process.once("exit", onExit);
    const result = new Promise<number | null>((resolve, reject) => {
      child.once("error", (err) => reject(new Error(`Couldn't start ${bin}: ${err.message}`)));
      child.once("close", (code) => resolve(code));
    }).finally(() => process.off("exit", onExit));
    run.exited = result.then(
      () => undefined,
      () => undefined,
    );
    for (const [stream, name] of [
      [child.stdout, "out"],
      [child.stderr, "err"],
    ] as const) {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line, name);
        }
      });
      stream.on("end", () => {
        if (buf.trim()) onLine(buf, name);
        buf = "";
      });
    }
    child.stdin.on("error", () => undefined); // the CLI may exit before reading it all
    child.stdin.end(prompt ?? "");
    return result;
  }

  private async runClaude(run: Run, prompt: string, settings: AgentSettings): Promise<string | undefined> {
    const bin = findAgentBinary("claude");
    if (!bin) throw new Error("Claude Code (the claude command) isn't installed");
    let result: { text: string; isError: boolean } | undefined;
    let lastErr = "";
    const code = await this.spawnCli(run, bin, claudeArgs(settings), prompt, (line, stream) => {
      if (stream === "err") {
        lastErr = line;
        return;
      }
      let msg: { type?: unknown; message?: { content?: unknown }; result?: unknown; is_error?: unknown; subtype?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        this.output(run, line);
        return;
      }
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }[]) {
          if (block.type === "text" && typeof block.text === "string") this.output(run, block.text);
          else if (block.type === "tool_use" && typeof block.name === "string") this.output(run, this.describeClaudeTool(block.name, block.input));
        }
      } else if (msg.type === "result") {
        result = { text: typeof msg.result === "string" ? msg.result : "", isError: msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error")) };
      }
    });
    if (run.stopped) throw new StoppedError();
    if ((result?.isError || (!result && code !== 0)) && SIGN_IN_RE.test(`${result?.text ?? ""} ${lastErr}`)) throw new SignInError("claude");
    if (result?.isError) throw new Error(result.text ? oneLine(result.text) : "Claude Code reported an error");
    if (result) return result.text;
    if (code !== 0) throw new Error(lastErr ? oneLine(lastErr) : `claude exited with code ${code}`);
    return undefined;
  }

  private describeClaudeTool(name: string, input: unknown): string {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const file = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : undefined;
    const shown = file ? this.relPath(file) : undefined;
    if (shown && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return `Editing ${shown}`;
    if (shown && name === "Read") return `Reading ${shown}`;
    if (name === "Bash" && typeof args.command === "string") return `Running ${args.command}`;
    return name;
  }

  private realDir?: string;

  /** A path the agent reported, relative to the project. Agents report real paths, so try the folder's realpath too
   *  (on macOS /var is a symlink to /private/var). */
  private relPath(p: string): string {
    if (!isAbsolute(p)) return p.split(sep).join("/");
    if (this.realDir === undefined) {
      try {
        this.realDir = realpathSync(this.deps.dir);
      } catch {
        this.realDir = this.deps.dir;
      }
    }
    for (const root of [this.deps.dir, this.realDir]) {
      const rel = relative(root, p);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
    }
    return p;
  }

  private async runCodex(run: Run, prompt: string): Promise<string | undefined> {
    const bin = findAgentBinary("codex");
    if (!bin) throw new Error("Codex (the codex command) isn't installed");
    const { args, stdin } = await codexArgs(bin, prompt);
    if (run.stopped) throw new StoppedError();
    let windowStart = 0;
    let inWindow = 0;
    let dropped = false;
    let last = "";
    let firstError = "";
    let signIn = false;
    const code = await this.spawnCli(run, bin, args, stdin ? prompt : undefined, (line) => {
      if (SIGN_IN_RE.test(line) && /fail|expired|error|not|invalid|please|required/i.test(line)) signIn = true;
      if (!firstError && /^\s*error\b/i.test(line)) firstError = line;
      if (USAGE_RE.test(line)) return;
      last = line;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
        dropped = false;
      }
      if (inWindow++ < CODEX_LINES_PER_SEC) this.output(run, line);
      else if (!dropped) {
        dropped = true;
        this.output(run, "…");
      }
    });
    if (run.stopped) throw new StoppedError();
    if (code !== 0) {
      if (signIn) throw new SignInError("codex");
      const why = firstError || last;
      throw new Error(why ? `Codex: ${oneLine(why)}` : `codex exited with code ${code}`);
    }
    return undefined;
  }

  /* ── API engine ──────────────────────────────────────────────────────── */

  /** Model text as activity lines: whole lines as they complete, a long unfinished one in pieces. */
  private textFeed(run: Run): { push(delta: string): void; flush(): void } {
    let pending = "";
    const drain = (all: boolean) => {
      let k: number;
      while ((k = pending.indexOf("\n")) >= 0) {
        this.output(run, pending.slice(0, k));
        pending = pending.slice(k + 1);
      }
      if (all || pending.length > MAX_LINE) {
        this.output(run, pending);
        pending = "";
      }
    };
    return {
      push: (delta) => {
        pending += delta;
        drain(false);
      },
      flush: () => drain(true),
    };
  }

  private projectTools(h: Handoff): ProjectTools {
    return createProjectTools(this.deps.dir, h.kind === "variants" && h.variants ? { variantsDir: `.glimpse/variants/${h.variants.id}` } : {});
  }

  private async screenshotPng(h: Handoff): Promise<Buffer | null> {
    const shot = this.deps.screenshot(h);
    return shot ? await readFile(shot).catch(() => null) : null;
  }

  /** The handoff's pictures for an API engine: the edited version, and the one before the edits when there is one. */
  private async screenshots(h: Handoff): Promise<{ after: Buffer; before: Buffer | null } | null> {
    const after = await this.screenshotPng(h);
    if (!after) return null;
    const shot = this.deps.screenshotBefore?.(h);
    const before = shot ? await readFile(shot).catch(() => null) : null;
    return { after, before };
  }

  private async runAnthropic(run: Run, h: Handoff, prompt: string, settings: AgentSettings, model: string): Promise<string | undefined> {
    const apiKey = resolveApiKey(settings, "anthropic");
    if (!apiKey) throw new Error("No Anthropic API key: add one in Glimpse's AI settings");
    const client = new Anthropic({ apiKey });
    const tools = this.projectTools(h);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const image = (png: Buffer): Anthropic.Beta.BetaContentBlockParam => ({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    const shots = await this.screenshots(h);
    if (shots?.before) {
      content.push({ type: "text", text: BEFORE_LABEL }, image(shots.before), { type: "text", text: AFTER_LABEL }, image(shots.after));
    } else if (shots) {
      content.push(image(shots.after));
    }
    content.push({ type: "text", text: prompt });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
    // Haiku takes adaptive thinking but no effort setting.
    const effort = /haiku/i.test(model) ? undefined : ANTHROPIC_EFFORT[settings.quality];
    let jsonRetries = 0;
    let lastText = "";

    for (let i = 0; i < settings.maxSteps; i++) {
      if (run.stopped) throw new StoppedError();
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: API_MAX_TOKENS,
          thinking: { type: "adaptive" },
          ...(effort && { output_config: { effort } }),
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: API_SYSTEM_PROMPT,
          tools: tools.definitions,
          messages,
        },
        { signal: run.abort.signal },
      );
      const feed = this.textFeed(run);
      stream.on("text", (delta) => feed.push(delta));
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0; // the cap is on consecutive failures of one turn
      } catch (err) {
        feed.flush();
        if (run.stopped || err instanceof Anthropic.APIUserAbortError) throw new StoppedError();
        // With eager input streaming, a tool input that isn't parseable JSON rejects here: re-issue the turn (twice at most).
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw anthropicError(err, model);
        continue;
      }
      feed.flush();
      const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) lastText = text;

      if (message.stop_reason === "end_turn") return lastText || undefined;
      // A refusal can cut a tool_use off mid-input: never run that turn's tools.
      if (message.stop_reason === "refusal") throw new Error("The model declined this request");
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") throw new Error("The model's reply hit the output limit");
        return lastText || undefined;
      }
      // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
      if (message.stop_reason === "max_tokens") throw new Error("The model's reply hit the output limit while writing a file");

      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tool of toolUses) {
        if (run.stopped) throw new StoppedError();
        const r = await tools.run(tool.name, tool.input);
        if (r.activity) this.output(run, r.activity);
        results.push({ type: "tool_result", tool_use_id: tool.id, content: r.content, ...(r.isError && { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`Stopped after ${settings.maxSteps} steps without finishing`);
  }

  /** OpenAI, Gemini, OpenRouter and Ollama: the same tool loop over Chat Completions (streamed). */
  private async runOpenAiCompatible(run: Run, h: Handoff, prompt: string, settings: AgentSettings, model: string): Promise<string | undefined> {
    const provider = settings.api.provider as Exclude<ApiProvider, "anthropic">;
    const name = PROVIDERS[provider].name;
    const apiKey = provider === "ollama" ? "ollama" : resolveApiKey(settings, provider);
    if (!apiKey) throw new Error(`No ${name} API key: add one in Glimpse's AI settings`);
    const baseURL = provider === "ollama" ? `${ollamaUrl(settings)}/v1` : PROVIDERS[provider].baseURL;
    const client = new OpenAI({
      apiKey,
      ...(baseURL && { baseURL }),
      ...(provider === "ollama" && { maxRetries: 0 }),
      ...(provider === "openrouter" && { defaultHeaders: { "HTTP-Referer": "https://github.com/musasacc/Glimpse", "X-Title": "Glimpse" } }),
    });
    const tools = this.projectTools(h);
    const fnTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.specs.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
    // Most local models can't see images: Ollama gets the text only.
    const shots = provider === "ollama" ? null : await this.screenshots(h);
    const image = (png: Buffer): OpenAI.Chat.Completions.ChatCompletionContentPart => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } });
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] | string =
      shots?.before ? [{ type: "text", text: prompt }, { type: "text", text: BEFORE_LABEL }, image(shots.before), { type: "text", text: AFTER_LABEL }, image(shots.after)]
      : shots ? [{ type: "text", text: prompt }, image(shots.after)]
      : prompt;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: API_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
    const reasoning = (provider === "openai" && /^(o\d|gpt-5)/i.test(model)) || (provider === "gemini" && /gemini-(2\.5|[3-9])/i.test(model));
    let lastText = "";

    for (let i = 0; i < settings.maxSteps; i++) {
      if (run.stopped) throw new StoppedError();
      const feed = this.textFeed(run);
      let text = "";
      let finish: string | null = null;
      const calls: { id: string; name: string; args: string }[] = [];
      try {
        const stream = await client.chat.completions.create(
          { model, messages, tools: fnTools, stream: true, ...(reasoning && { reasoning_effort: REASONING_EFFORT[settings.quality] }) },
          { signal: run.abort.signal },
        );
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (typeof delta?.content === "string" && delta.content) {
            text += delta.content;
            feed.push(delta.content);
          }
          for (const [k, tc] of (delta?.tool_calls ?? []).entries()) {
            const index = typeof tc.index === "number" ? tc.index : k;
            const call = (calls[index] ??= { id: "", name: "", args: "" });
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            if (tc.function?.arguments) call.args += tc.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (err) {
        feed.flush();
        if (run.stopped || err instanceof OpenAI.APIUserAbortError) throw new StoppedError();
        throw openAiError(err, provider, model, settings);
      }
      feed.flush();
      if (run.stopped) throw new StoppedError();
      if (text.trim()) lastText = text.trim();
      const toolCalls = calls.filter(Boolean).map((c, k) => ({ ...c, id: c.id || `call_${i}_${k}` }));

      if (toolCalls.length === 0) {
        if (finish === "length") throw new Error("The model's reply hit the output limit");
        if (finish === "content_filter") throw new Error("The model declined this request");
        return lastText || undefined;
      }
      // Arguments cut off at the output limit can't be trusted: never run them.
      if (finish === "length") throw new Error("The model's reply hit the output limit while writing a file");

      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
      });
      for (const call of toolCalls) {
        if (run.stopped) throw new StoppedError();
        let input: unknown;
        try {
          input = JSON.parse(call.args || "{}");
        } catch {
          input = undefined;
        }
        const r = input === undefined ? invalid(call.args) : await tools.run(call.name, input);
        if (r.activity) this.output(run, r.activity);
        messages.push({ role: "tool", tool_call_id: call.id, content: r.isError ? `Error: ${r.content}` : r.content });
      }
    }
    throw new Error(`Stopped after ${settings.maxSteps} steps without finishing`);
  }
}

interface Detected {
  at: number;
  settings: AgentSettings;
  agents: DetectedAgents;
  ollama: OllamaStatus;
}

/** Claude Code's command line: edits only by default; with "allow commands" it may run shell commands too. */
export function claudeArgs(settings: Pick<AgentSettings, "allowCommands">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  if (settings.allowCommands) args.push("--allowedTools", "Bash");
  return args;
}

/** What the editor may know about the API settings: never a key, only whether one is saved or in the environment. */
export function apiInfo(settings: AgentSettings, ollama: OllamaStatus): AgentApiInfo {
  const flags = (f: (p: KeyProvider) => boolean) => Object.fromEntries(KEY_PROVIDERS.map((p) => [p, f(p)])) as Record<KeyProvider, boolean>;
  return {
    provider: settings.api.provider,
    model: effectiveModel(settings, ollama.models),
    chosenModel: settings.api.model ?? "",
    providers: Object.fromEntries(
      API_PROVIDERS.map((p) => [
        p,
        { name: PROVIDERS[p].name, defaultModel: p === "ollama" ? (ollama.models[0] ?? PROVIDERS.ollama.defaultModel) : PROVIDERS[p].defaultModel, models: p === "ollama" ? [...ollama.models] : [...PROVIDERS[p].models] },
      ]),
    ) as AgentApiInfo["providers"],
    keysSaved: flags((p) => !!settings.api.keys[p]),
    envKeys: flags((p) => !!envApiKey(p)),
    ollama: { baseUrl: ollamaUrl(settings), running: ollama.running, models: [...ollama.models] },
  };
}

const BEFORE_LABEL = "Before: the UI before the human's edits (screenshot):";
const AFTER_LABEL = "After: the human's edited version (screenshot; numbered markers, if any, match the change list):";

const API_SYSTEM_PROMPT = [
  "You build and change user interfaces for Glimpse, a visual editor that previews the project folder live.",
  "You work only through the tools: list_files, read_file, write_file and delete_file, with paths relative to the project folder.",
  "Read the files you change first. Write complete files with write_file (never diffs). Every save appears live for the human.",
  "For a web page, prefer a single self-contained index.html, with separate .css/.js files only when they help; use no build step.",
  "Follow the target and entry file named in the request, and keep the entry file as the page Glimpse previews.",
  "When the work is done, reply with one or two sentences saying what you changed.",
].join("\n");

/* ── Tools of the API engine ───────────────────────────────────────────── */

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;

const ListInput = z.object({ dir: z.string().optional() });
const ReadInput = z.object({ path: z.string().min(1) });
const WriteInput = z.object({ path: z.string().min(1), contents: z.string() });
const DeleteInput = z.object({ path: z.string().min(1) });

export interface ToolResult {
  content: string;
  isError: boolean;
  /** One line for the editor's activity feed ("Editing index.html"). */
  activity?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the input. */
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ProjectTools {
  /** Provider-neutral: name, description, input schema. */
  specs: ToolSpec[];
  /** The same tools for the Anthropic API. */
  definitions: Anthropic.Beta.BetaTool[];
  run(name: string, input: unknown): Promise<ToolResult>;
}

class PathError extends Error {}

/**
 * The file tools the API engine gets, confined to the project folder: no absolute paths, no `..`, no dotfiles or
 * dot folders (.git, .env, Glimpse's own .glimpse), no writes into node_modules, nothing through a symlink that
 * leads out of the project. A variants run may also use its own `.glimpse/variants/<id>/` folder (`variantsDir`).
 */
export function createProjectTools(dir: string, opts: { variantsDir?: string } = {}): ProjectTools {
  const allowed = opts.variantsDir?.split("\\").join("/").replace(/\/+$/, "");
  const fileProp = { type: "string", description: "Path relative to the project folder, e.g. index.html or src/app.js" };
  const specs: ToolSpec[] = [
    {
      name: "list_files",
      description: "List the project's files (recursively, without dot folders and node_modules).",
      schema: { type: "object", properties: { dir: { type: "string", description: "Folder relative to the project folder (default: the whole project)" } } },
    },
    { name: "read_file", description: "Read a text file of the project.", schema: { type: "object", properties: { path: fileProp }, required: ["path"] } },
    {
      name: "write_file",
      description: "Create or overwrite a file of the project with the complete new contents.",
      schema: { type: "object", properties: { path: fileProp, contents: { type: "string", description: "The whole file" } }, required: ["path", "contents"] },
    },
    { name: "delete_file", description: "Delete a file of the project.", schema: { type: "object", properties: { path: fileProp }, required: ["path"] } },
  ];
  const definitions: Anthropic.Beta.BetaTool[] = specs.map((t) => ({ name: t.name, description: t.description, eager_input_streaming: true, input_schema: t.schema }));

  /** The project-relative path (forward slashes) and absolute path for `p`, or a PathError. */
  async function confine(p: string, mode: "read" | "write"): Promise<{ rel: string; abs: string }> {
    const slashed = p.trim().split("\\").join("/");
    if (!slashed || slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed) || isAbsolute(slashed)) throw new PathError("Use a path relative to the project folder");
    const rel = posix.normalize(slashed).replace(/\/+$/, "");
    if (rel === ".." || rel.startsWith("../")) throw new PathError("That path is outside the project folder");
    const inAllowed = !!allowed && (rel === allowed || rel.startsWith(`${allowed}/`));
    const segments = rel === "." ? [] : rel.split("/");
    if (!inAllowed && segments.some((s) => s.startsWith("."))) throw new PathError("Dotfiles and dot folders (.git, .env, .glimpse) are off limits");
    if (mode === "write" && segments.includes("node_modules")) throw new PathError("node_modules is off limits");
    const abs = rel === "." ? dir : join(dir, ...segments);
    // Symlinks: the deepest part of the path that exists must really be inside the project.
    const root = await realpath(dir);
    let probe = abs;
    for (;;) {
      const st = await lstat(probe).catch(() => null);
      if (st) {
        if (mode === "write" && probe === abs && st.isSymbolicLink()) throw new PathError("That path is a symlink");
        const real = await realpath(probe).catch(() => null);
        const back = real === null ? ".." : relative(root, real);
        if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new PathError("That path leads outside the project folder");
        break;
      }
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return { rel, abs };
  }

  async function list(start: string): Promise<string[]> {
    const { rel, abs } = await confine(start, "read");
    const out: string[] = [];
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        const childRel = relDir === "." ? e.name : `${relDir}/${e.name}`;
        const inAllowed = !!allowed && (childRel === allowed || childRel.startsWith(`${allowed}/`) || allowed.startsWith(`${childRel}/`));
        if ((e.name.startsWith(".") && !inAllowed) || e.name === "node_modules") continue;
        if (e.isDirectory()) await walk(join(absDir, e.name), childRel);
        else if (e.isFile()) out.push(childRel);
      }
    };
    await walk(abs, rel);
    return out;
  }

  async function run(name: string, input: unknown): Promise<ToolResult> {
    try {
      switch (name) {
        case "list_files": {
          const args = ListInput.safeParse(input ?? {});
          if (!args.success) return invalid(input);
          const files = await list(args.data.dir ?? ".");
          const more = files.length >= MAX_LIST_ENTRIES ? `\n(only the first ${MAX_LIST_ENTRIES} files are listed)` : "";
          return { content: files.length ? files.join("\n") + more : "(no files)", isError: false };
        }
        case "read_file": {
          const args = ReadInput.safeParse(input);
          if (!args.success) return invalid(input);
          const { rel, abs } = await confine(args.data.path, "read");
          const st = await stat(abs).catch(() => null);
          if (!st?.isFile()) return { content: `${rel} doesn't exist`, isError: true };
          if (st.size > MAX_READ_BYTES) return { content: `${rel} is too big to read (${st.size} bytes)`, isError: true };
          return { content: await readFile(abs, "utf8"), isError: false, activity: `Reading ${rel}` };
        }
        case "write_file": {
          const args = WriteInput.safeParse(input);
          if (!args.success) return invalid(input);
          const { rel, abs } = await confine(args.data.path, "write");
          const st = await stat(abs).catch(() => null);
          if (st?.isDirectory()) return { content: `${rel} is a folder`, isError: true };
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, args.data.contents);
          return { content: `Wrote ${rel}`, isError: false, activity: `Editing ${rel}` };
        }
        case "delete_file": {
          const args = DeleteInput.safeParse(input);
          if (!args.success) return invalid(input);
          const { rel, abs } = await confine(args.data.path, "write");
          const st = await lstat(abs).catch(() => null);
          if (!st) return { content: `${rel} doesn't exist`, isError: true };
          if (!st.isFile()) return { content: `${rel} isn't a file`, isError: true };
          await rm(abs);
          return { content: `Deleted ${rel}`, isError: false, activity: `Deleting ${rel}` };
        }
        default:
          return { content: `Unknown tool: ${name}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  return { specs, definitions, run };
}

/** The SDK's tolerant parser can hand over a silently truncated input: say so, so the model sends it again. */
function invalid(input: unknown): ToolResult {
  return { content: JSON.stringify({ INVALID_INPUT: JSON.stringify(input ?? null).slice(0, 2000) }), isError: true };
}

function oneLine(s: string): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API — try again in a minute";
  if (err instanceof Anthropic.APIError) return oneLine(`API error ${err.status ?? ""}: ${err.message}`.replace(/ +:/, ":"));
  return oneLine(err instanceof Error ? err.message : String(err)) || "The agent failed";
}

/** An Anthropic error the runner explains itself (an unknown model); the rest describeError words. */
function anthropicError(err: unknown, model: string): unknown {
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic doesn't know the model "${model}": pick another in the AI settings`);
  return err;
}

/** An error of an OpenAI-compatible provider, in words: a rejected key, a rate limit, an unknown model, Ollama not running. */
export function openAiError(err: unknown, provider: Exclude<ApiProvider, "anthropic">, model: string, settings: AgentSettings): Error {
  const name = PROVIDERS[provider].name;
  if (provider === "ollama" && err instanceof OpenAI.APIConnectionError)
    return new Error(`Ollama isn't running at ${ollamaUrl(settings)}: start it (open the Ollama app, or run \`ollama serve\`), then send again`);
  if (err instanceof OpenAI.APIConnectionError) return new Error(`Couldn't reach ${name}: check the connection and try again`);
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return new Error(`The ${name} API key was rejected`);
  if (err instanceof OpenAI.RateLimitError) return new Error(`Rate limited by ${name} — try again in a minute`);
  if (err instanceof OpenAI.NotFoundError || (err instanceof OpenAI.APIError && /model.*(not found|does not exist)|unknown model/i.test(err.message)))
    return new Error(provider === "ollama" ? `Ollama doesn't have the model "${model}": run \`ollama pull ${model}\`, or pick another` : `${name} doesn't know the model "${model}": pick another in the AI settings`);
  if (err instanceof OpenAI.APIError) return new Error(oneLine(`${name} API error ${err.status ?? ""}: ${err.message}`.replace(/ +:/, ":")));
  return err instanceof Error ? err : new Error(String(err));
}
