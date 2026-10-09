/**
 * The built-in agent: when the human sends a request, edits or a variants job and no external agent
 * (`glimpse wait`, the MCP server) is listening, Glimpse runs the AI itself — the Claude Code CLI, the Codex CLI
 * or the Anthropic API — in the project folder, one run at a time, and streams its progress to the editor.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  detectAgents,
  findAgentBinary,
  loadAgentSettings,
  resolveAnthropicKey,
  type AgentEngine,
  type AgentSettings,
  type DetectedAgents,
} from "./agent-settings.js";
import type { Handoff } from "./server.js";
import { baseEnv, killProcessTree, killProcessTreeSync, settled } from "./terminal.js";
import type { AgentInfo, AgentRunEvent, AgentRunState, BuiltInEngine, ResolvedEngine } from "./agent-types.js";

export type { AgentInfo, AgentRunEvent, AgentRunState, BuiltInEngine, ResolvedEngine };

export interface AgentRunnerDeps {
  /** The project folder: where the agent runs and the only place it writes. */
  dir: string;
  broadcast(msg: object): void;
  /** An external agent is listening (it takes precedence). */
  externalWaiting(): boolean;
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
}

const DETECT_TTL_MS = 30_000;
const KEEP_OUTPUT_LINES = 40;
const MAX_LINE = 300;
const STOP_GRACE_MS = 3000;
const API_MODEL = "claude-opus-5-5";
const API_MAX_TOKENS = 64_000;
const API_MAX_ITERATIONS = 40;
const CODEX_LINES_PER_SEC = 10;
/** How long an engine that failed to sign in is skipped by "auto". */
const SIGNED_OUT_MS = 10 * 60_000;
const ENGINE_NAMES: Record<BuiltInEngine, string> = { claude: "Claude Code", codex: "Codex", api: "Claude (API)" };
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

/** The options this Codex accepts, from `codex exec --help` (they changed between versions). */
const codexHelp = new Map<string, Promise<string>>();
function readCodexHelp(bin: string): Promise<string> {
  let help = codexHelp.get(bin);
  if (!help) {
    help = new Promise((resolve) => {
      execFile(bin, ["exec", "--help"], { timeout: 5000, shell: process.platform === "win32", windowsHide: true }, (_err, stdout, stderr) =>
        resolve(`${String(stdout)}\n${String(stderr)}`),
      );
    });
    codexHelp.set(bin, help);
  }
  return help;
}

/** `codex exec` arguments for this Codex, and whether the prompt goes on stdin (Windows: no user text on a shell command line). */
export async function codexArgs(bin: string, prompt: string, windows = process.platform === "win32"): Promise<{ args: string[]; stdin: boolean }> {
  const help = await readCodexHelp(bin);
  const args = ["exec"];
  for (const flag of ["--full-auto", "--skip-git-repo-check"]) if (help.includes(flag)) args.push(flag);
  if (!windows) return { args: [...args, prompt], stdin: false };
  // Without a prompt argument (or with "-"), codex exec reads the instructions from stdin.
  if (/stdin/i.test(help) && /\B-\B|`-`|'-'/.test(help)) args.push("-");
  return { args, stdin: true };
}

/** Who handles a request, given the settings, what's installed and whether an external agent is listening. */
export function resolveEngine(preferred: AgentEngine, available: DetectedAgents, externalWaiting: boolean): ResolvedEngine {
  // An agent that is listening always gets the request first (it is handed over before Glimpse would start anything).
  if (externalWaiting || preferred === "external") return "external";
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
  private detected: { at: number; settings: AgentSettings; agents: DetectedAgents } | undefined;
  private detecting: Promise<{ settings: AgentSettings; agents: DetectedAgents }> | undefined;
  /** Engines whose sign-in failed lately: "auto" skips them for a while. */
  private signedOut = new Map<"claude" | "codex", number>();

  constructor(private readonly deps: AgentRunnerDeps) {}

  /** Settings and detected engines, cached for a while (a CLI installed meanwhile shows up within 30 s). */
  private async detect(): Promise<{ settings: AgentSettings; agents: DetectedAgents }> {
    if (this.detected && Date.now() - this.detected.at < DETECT_TTL_MS) return this.detected;
    this.detecting ??= (async () => {
      try {
        const settings = await loadAgentSettings();
        const agents = await detectAgents(settings);
        this.detected = { at: Date.now(), settings, agents };
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
    return resolveEngine(settings.engine, usable, this.deps.externalWaiting());
  }

  async info(): Promise<AgentInfo> {
    const { settings, agents } = await this.detect();
    const external = this.deps.externalWaiting();
    const run = this.current;
    return {
      engine: this.resolve(settings, agents),
      preferred: settings.engine,
      available: { ...agents, external },
      running: run ? { seq: run.seq, engine: run.engine, startedAt: run.startedAt } : null,
      queued: this.queue.length,
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

  /** A new handoff: run it with the built-in agent, unless an external agent took it or nothing can run it (it then waits). */
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
    return !h.delivered && !h.cancelled && h.kind !== "source";
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
    this.emit(run, "start", ENGINE_NAMES[engine]);
    this.infoChanged();
    const prompt = this.deps.prompt(h);
    const work =
      engine === "claude" ? this.runClaude(run, prompt)
      : engine === "codex" ? this.runCodex(run, prompt)
      : this.runApi(run, h, prompt, settings);
    let fallback: BuiltInEngine | undefined;
    work
      .then((summary) => {
        if (run.stopped) throw new StoppedError();
        this.emit(run, "done", summary ? oneLine(summary) : undefined);
      })
      .catch(async (err: unknown) => {
        if (run.stopped || err instanceof StoppedError) return this.emit(run, "error", "Stopped");
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
        this.emit(run, "error", describeError(err));
      })
      .finally(() => {
        this.deps.roundEnd();
        this.current = undefined;
        finish();
        if (fallback && !this.closing) return this.start(h, fallback, settings);
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

  private async runClaude(run: Run, prompt: string): Promise<string | undefined> {
    const bin = findAgentBinary("claude");
    if (!bin) throw new Error("Claude Code (the claude command) isn't installed");
    let result: { text: string; isError: boolean } | undefined;
    let lastErr = "";
    const code = await this.spawnCli(run, bin, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"], prompt, (line, stream) => {
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

  private async runApi(run: Run, h: Handoff, prompt: string, settings: AgentSettings): Promise<string | undefined> {
    const apiKey = resolveAnthropicKey(settings);
    if (!apiKey) throw new Error("No Anthropic API key: add one in Glimpse's settings");
    const client = new Anthropic({ apiKey });
    const tools = createProjectTools(this.deps.dir, h.kind === "variants" && h.variants ? { variantsDir: `.glimpse/variants/${h.variants.id}` } : {});
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const shot = this.deps.screenshot(h);
    const png = shot ? await readFile(shot).catch(() => null) : null;
    if (png) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    content.push({ type: "text", text: prompt });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
    let jsonRetries = 0;
    let lastText = "";

    for (let i = 0; i < API_MAX_ITERATIONS; i++) {
      if (run.stopped) throw new StoppedError();
      const stream = client.beta.messages.stream(
        {
          model: API_MODEL,
          max_tokens: API_MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: API_SYSTEM_PROMPT,
          tools: tools.definitions,
          messages,
        },
        { signal: run.abort.signal },
      );
      let pending = "";
      const flush = (all: boolean) => {
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
      stream.on("text", (delta) => {
        pending += delta;
        flush(false);
      });
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0; // the cap is on consecutive failures of one turn
      } catch (err) {
        flush(true);
        if (run.stopped || err instanceof Anthropic.APIUserAbortError) throw new StoppedError();
        // With eager input streaming, a tool input that isn't parseable JSON rejects here: re-issue the turn (twice at most).
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
      flush(true);
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
    throw new Error(`Stopped after ${API_MAX_ITERATIONS} steps without finishing`);
  }
}

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

export interface ProjectTools {
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
  const definitions: Anthropic.Beta.BetaTool[] = [
    {
      name: "list_files",
      description: "List the project's files (recursively, without dot folders and node_modules).",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { dir: { type: "string", description: "Folder relative to the project folder (default: the whole project)" } } },
    },
    {
      name: "read_file",
      description: "Read a text file of the project.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { path: fileProp }, required: ["path"] },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file of the project with the complete new contents.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { path: fileProp, contents: { type: "string", description: "The whole file" } }, required: ["path", "contents"] },
    },
    {
      name: "delete_file",
      description: "Delete a file of the project.",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: { path: fileProp }, required: ["path"] },
    },
  ];

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

  return { definitions, run };
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
