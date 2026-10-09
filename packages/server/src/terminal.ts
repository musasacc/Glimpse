import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Scrollback } from "@glimpse/core";

/** Re-exported: the terminal's scrollback is cut with it (see Scrollback). */
export { trimOutput } from "@glimpse/core";

/**
 * Runs the real terminal app inside Glimpse, next to its scene mock.
 *
 * - "pty": a real pseudo-terminal through node-pty (an optional dependency; ConPTY on Windows).
 *   Full-screen apps (Textual, Ink, Ratatui, Bubble Tea, curses) work, keys and resizes included.
 * - "pipe": the fallback when node-pty isn't installed or can't start: the command runs with piped
 *   stdio and FORCE_COLOR/COLUMNS/LINES set. Output streams fine; full-screen apps may refuse to run
 *   or ignore input, since there is no terminal. Newlines are sent as "\r\n" so xterm.js shows them
 *   right, and an Enter ("\r") typed in the terminal reaches the app as "\n". There is no echo.
 */

export type TerminalMode = "pty" | "pipe";

export interface TerminalStartOptions {
  /** Shell command line, run with /bin/sh -c on macOS and Linux and cmd.exe /d /s /c on Windows. */
  command: string;
  cwd: string;
  /** Terminal size in cells (default 80×24). */
  cols?: number;
  rows?: number;
  /** Added to (and overriding) the server's own environment. */
  env?: Record<string, string | undefined>;
  /** "auto" (default) uses a pty when node-pty works and pipes otherwise; "pty" fails without node-pty. */
  mode?: "auto" | TerminalMode;
}

export interface TerminalStartInfo {
  mode: TerminalMode;
  pid: number;
  command: string;
  cols: number;
  rows: number;
}

export interface TerminalEvents {
  start: [info: TerminalStartInfo];
  data: [data: string];
  /** `code` is null when the process was killed by a signal (`signal` names it). */
  exit: [code: number | null, signal: string | null];
}

/** The part of node-pty's IPty that Glimpse uses. */
interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(file: string, args: string[] | string, options: Record<string, unknown>): Pty;
}

let ptyLoad: Promise<PtyModule | null> | undefined;

/**
 * node-pty, or null when it isn't installed or its native part didn't build.
 * Loaded on first use, so Glimpse works without it.
 */
export function loadPty(): Promise<PtyModule | null> {
  ptyLoad ??= (async () => {
    try {
      const name = "node-pty";
      const mod = (await import(name)) as Partial<PtyModule> & { default?: Partial<PtyModule> };
      const pty = typeof mod.spawn === "function" ? mod : mod.default;
      if (!pty || typeof pty.spawn !== "function") return null;
      fixSpawnHelper();
      return pty as PtyModule;
    } catch {
      return null;
    }
  })();
  return ptyLoad;
}

/** Whether a real pseudo-terminal is available. */
export async function ptyAvailable(): Promise<boolean> {
  return (await loadPty()) !== null;
}

/**
 * node-pty's prebuilt macOS helper can come out of the package without its
 * executable bit, and then every spawn fails ("posix_spawnp failed").
 */
function fixSpawnHelper(): void {
  if (process.platform !== "darwin") return;
  try {
    // Inside the desktop app the package resolves into app.asar, but its helpers run from app.asar.unpacked
    // (as node-pty itself maps them): fix the real file, not the archive's.
    const root = dirname(dirname(createRequire(import.meta.url).resolve("node-pty"))).replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
    for (const helper of [join(root, "build", "Release", "spawn-helper"), join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper")]) {
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch {
    // Not fatal: spawning falls back to pipes if the helper can't run.
  }
}

interface Run {
  mode: TerminalMode;
  pid: number;
  pty?: Pty;
  child?: ChildProcess;
  done: boolean;
  exited: Promise<void>;
  /** Kills the tree if Glimpse exits while the app still runs. */
  onProcessExit?: () => void;
}

const SCROLLBACK_BYTES = 256 * 1024;
const FLUSH_MS = 16;
const isWindows = process.platform === "win32";

export class TerminalSession extends EventEmitter<TerminalEvents> {
  private current: Run | undefined;
  private last: Run | undefined;
  private startSeq = 0;
  private starting = 0;
  private options: TerminalStartOptions | undefined;
  private size = { cols: 80, rows: 24 };
  private buffer: Scrollback;
  /** Output not passed on yet: a busy app's output goes out about once a frame, not once per chunk. */
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Why the last start used pipes although a pty was wanted, if it did. */
  fallbackReason: string | undefined;

  constructor(scrollback = SCROLLBACK_BYTES) {
    super();
    this.buffer = new Scrollback(scrollback);
  }

  /** How the current (or last) process runs. */
  get mode(): TerminalMode {
    return (this.current ?? this.last)?.mode ?? "pipe";
  }

  get running(): boolean {
    return this.current !== undefined && !this.current.done;
  }

  get pid(): number | undefined {
    return this.running ? this.current!.pid : undefined;
  }

  get command(): string | undefined {
    return this.options?.command;
  }

  get cols(): number {
    return this.size.cols;
  }

  get rows(): number {
    return this.size.rows;
  }

  /** Recent output of the current (or last) run, for a client that connects late. */
  get output(): string {
    return this.buffer.text();
  }

  /**
   * Start the command. A running process is stopped first, so this also restarts.
   * Resolves null when a newer start() or a stop() came in while it was getting ready.
   */
  async start(opts: TerminalStartOptions): Promise<TerminalStartInfo | null> {
    const seq = ++this.startSeq;
    this.starting = seq;
    await this.stopRun();
    if (this.starting !== seq) return null;
    const cols = clampSize(opts.cols ?? this.size.cols);
    const rows = clampSize(opts.rows ?? this.size.rows);
    this.options = { ...opts, cols, rows };
    this.size = { cols, rows };
    this.fallbackReason = undefined;

    let pty: PtyModule | null = null;
    if (opts.mode !== "pipe") {
      pty = await loadPty();
      if (!pty) {
        if (opts.mode === "pty") throw new Error("node-pty isn't available (it's an optional dependency that may have failed to build)");
        this.fallbackReason = "node-pty isn't installed";
      }
    }
    if (this.starting !== seq) return null;

    let run: Run | undefined;
    if (pty) {
      try {
        run = this.spawnPty(pty, opts.command, opts.cwd, cols, rows, opts.env);
      } catch (err) {
        if (opts.mode === "pty") throw err;
        this.fallbackReason = `node-pty couldn't start the command: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    run ??= this.spawnPipe(opts.command, opts.cwd, cols, rows, opts.env);
    this.starting = 0;
    const info: TerminalStartInfo = { mode: run.mode, pid: run.pid, command: opts.command, cols, rows };
    this.emit("start", info);
    return info;
  }

  /** Stop and start again with the same command and the current size. */
  async restart(): Promise<TerminalStartInfo | null> {
    if (!this.options) throw new Error("Nothing to restart: the terminal was never started");
    return this.start({ ...this.options, ...this.size });
  }

  /** Send keystrokes or text to the app. Returns false when nothing is running. */
  write(data: string): boolean {
    const run = this.current;
    if (!run || run.done) return false;
    if (run.pty) {
      run.pty.write(data);
      return true;
    }
    const stdin = run.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    // No terminal line discipline here: Enter arrives as "\r" from xterm.js but line readers want "\n".
    stdin.write(data.replace(/\r(?!\n)/g, "\n"));
    return true;
  }

  /** Resize the terminal. Pipes can't be resized; the size applies from the next start. */
  resize(cols: number, rows: number): void {
    this.size = { cols: clampSize(cols), rows: clampSize(rows) };
    const run = this.current;
    if (run?.pty && !run.done) {
      try {
        run.pty.resize(this.size.cols, this.size.rows);
      } catch {
        // The process exited between the check and the resize.
      }
    }
  }

  /**
   * Make a full-screen app draw its whole screen again, for an editor that just caught up from the scrollback
   * (which may hold only the latest updates of the screen): the pty is resized by a row and back, so the app
   * gets SIGWINCH and repaints. Nothing happens for pipes.
   */
  redraw(): void {
    const run = this.current;
    if (!run?.pty || run.done) return;
    const { cols, rows } = this.size;
    try {
      run.pty.resize(cols, rows > 2 ? rows - 1 : rows + 1);
    } catch {
      return; // the process exited between the check and the resize
    }
    setTimeout(() => {
      if (this.current !== run || run.done) return;
      try {
        run.pty?.resize(this.size.cols, this.size.rows);
      } catch {
        // The process exited meanwhile.
      }
    }, 50).unref();
  }

  /**
   * Stop the app and everything it started: SIGTERM to its process group (taskkill /T /F on Windows),
   * then SIGKILL after `graceMs`. Resolves once it's gone, and never hangs.
   */
  async stop(graceMs = 1500): Promise<void> {
    this.starting = 0; // cancels a start() that is still getting ready
    await this.stopRun(graceMs);
  }

  private async stopRun(graceMs = 1500): Promise<void> {
    const run = this.current;
    if (!run || run.done) return;
    await killTree(run, "SIGTERM");
    if (await settled(run.exited, graceMs)) return;
    await killTree(run, "SIGKILL");
    if (await settled(run.exited, 1500)) return;
    // Still no exit event (a stuck pty or pipe): give up on it so a restart can go ahead.
    this.finish(run, null, "SIGKILL");
  }

  private spawnPty(pty: PtyModule, command: string, cwd: string, cols: number, rows: number, env: TerminalStartOptions["env"]): Run {
    const shell = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    // On Windows a string is passed through as the command line, exactly like child_process does with shell: true.
    const args = isWindows ? `/d /s /c "${command}"` : ["-c", command];
    const vars = baseEnv(env);
    // A real terminal reports its size itself; stale COLUMNS/LINES would override it in curses apps.
    delete vars.COLUMNS;
    delete vars.LINES;
    const p = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd, env: { ...vars, TERM: "xterm-256color" } });
    let resolveExit!: () => void;
    const run: Run = { mode: "pty", pid: p.pid, pty: p, done: false, exited: new Promise((r) => (resolveExit = r)) };
    this.begin(run);
    p.onData((data) => this.push(run, data));
    p.onExit(({ exitCode, signal }) => {
      this.finish(run, signal ? null : exitCode, signal ? signalName(signal) : null);
      resolveExit();
    });
    return run;
  }

  private spawnPipe(command: string, cwd: string, cols: number, rows: number, env: TerminalStartOptions["env"]): Run {
    const vars: Record<string, string> = {
      ...baseEnv(env),
      FORCE_COLOR: "1",
      COLUMNS: String(cols),
      LINES: String(rows),
      TERM: "xterm-256color",
      PYTHONUNBUFFERED: "1",
    };
    vars.PYTHONIOENCODING ??= "utf-8";
    const child = spawn(command, {
      shell: true,
      cwd,
      env: vars,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group on POSIX, so stop() can signal the whole tree; Windows uses taskkill /T.
      detached: !isWindows,
      windowsHide: true,
    });
    let resolveExit!: () => void;
    const run: Run = { mode: "pipe", pid: child.pid ?? -1, child, done: false, exited: new Promise((r) => (resolveExit = r)) };
    this.begin(run);
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => this.push(run, crlf(decoder.write(chunk))));
      stream.on("end", () => {
        const rest = decoder.end();
        if (rest) this.push(run, crlf(rest));
      });
    }
    child.stdin!.on("error", () => undefined); // EPIPE after the app exited
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(exitTimer);
      this.finish(run, code, signal);
      resolveExit();
    };
    // "close" waits for the output to drain; a grandchild holding the pipes open mustn't keep it from ending.
    child.on("close", done);
    child.on("exit", (code, signal) => {
      exitTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(code, signal);
      }, 1000);
      exitTimer.unref();
    });
    child.on("error", (err) => {
      this.push(run, `\r\n[glimpse] couldn't run ${JSON.stringify(command)}: ${err.message}\r\n`);
      done(null, null);
    });
    return run;
  }

  private begin(run: Run): void {
    this.flush();
    this.current = run;
    this.last = run;
    this.buffer.clear();
    // The app runs in its own process group, so it wouldn't go down with Glimpse: take it along on exit.
    if (run.pid > 0) {
      run.onProcessExit = () => killProcessTreeSync(run.pid);
      process.once("exit", run.onProcessExit);
    }
  }

  private push(run: Run, data: string): void {
    // Late output of a run that was already replaced belongs to nobody.
    if (run !== this.last || data === "") return;
    this.pending += data;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
      this.flushTimer.unref();
    }
  }

  /** Pass on the pending output. Before any other event, so the order stays. */
  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const data = this.pending;
    if (!data) return;
    this.pending = "";
    // Scrollback and listeners see the same output at the same time, so a late client's catch-up never repeats it.
    this.buffer.push(data);
    this.emit("data", data);
  }

  private finish(run: Run, code: number | null, signal: string | null): void {
    if (run.done) return;
    run.done = true;
    if (run.onProcessExit) process.off("exit", run.onProcessExit);
    if (this.current === run) this.current = undefined;
    this.flush();
    this.emit("exit", code, signal);
  }
}

/** Last-moment cleanup while Glimpse itself exits (only synchronous work is possible then). */
export function killProcessTreeSync(pid: number): void {
  try {
    if (isWindows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** The environment for a child process: Glimpse's own plus `env`, without undefined values. */
export function baseEnv(env?: TerminalStartOptions["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) out[k] = v;
  return out;
}

function clampSize(n: number): number {
  return Number.isFinite(n) ? Math.min(1000, Math.max(2, Math.round(n))) : 80;
}

function crlf(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

function signalName(signal: number): string {
  return Object.entries(constants.signals).find(([, n]) => n === signal)?.[0] ?? String(signal);
}

/** Resolves true when `p` settles within `ms`, false otherwise. */
export async function settled(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Signal the run's whole process tree. Only ever the pid Glimpse started (and its group). */
async function killTree(run: Run, signal: NodeJS.Signals): Promise<void> {
  if (run.pid <= 0) return;
  await killProcessTree(run.pid, signal);
  if (isWindows) {
    try {
      run.pty?.kill();
    } catch {
      // already gone
    }
  }
}

/**
 * Signal a process Glimpse started and everything it started: its process group on POSIX (so it must have
 * been spawned detached), `taskkill /T /F` on Windows.
 */
export async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (pid <= 0) return;
  if (isWindows) {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
    return;
  }
  try {
    // Negative pid: the process group. The pty's shell is a session leader, and pipes run detached.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/* ── WebSocket protocol ───────────────────────────────────────────────── */

/** Server → editor. */
export type TerminalServerMessage =
  | ({ type: "term-start" } & TerminalStartInfo)
  | { type: "term-data"; data: string }
  | { type: "term-exit"; code: number | null; signal: string | null }
  | { type: "term-error"; message: string };

/** Editor → server. The command itself never comes from the browser. */
export type TerminalClientMessage =
  | { type: "term-input"; data: string }
  | { type: "term-resize"; cols: number; rows: number }
  | { type: "term-restart" }
  | { type: "term-stop" };

const MAX_INPUT = 64 * 1024;

/** Forward a session's events as protocol messages (e.g. to every editor socket). Returns an unsubscribe function. */
export function bridgeTerminal(session: TerminalSession, send: (msg: TerminalServerMessage) => void): () => void {
  const onStart = (info: TerminalStartInfo) => send({ type: "term-start", ...info });
  const onData = (data: string) => send({ type: "term-data", data });
  const onExit = (code: number | null, signal: string | null) => send({ type: "term-exit", code, signal });
  session.on("start", onStart);
  session.on("data", onData);
  session.on("exit", onExit);
  return () => {
    session.off("start", onStart);
    session.off("data", onData);
    session.off("exit", onExit);
  };
}

/** What a newly connected editor needs to catch up: the current run and its recent output. */
export function terminalSnapshot(session: TerminalSession): TerminalServerMessage[] {
  if (session.command === undefined) return [];
  const out: TerminalServerMessage[] = [
    { type: "term-start", mode: session.mode, pid: session.pid ?? -1, command: session.command, cols: session.cols, rows: session.rows },
  ];
  if (session.output) out.push({ type: "term-data", data: session.output });
  if (!session.running) out.push({ type: "term-exit", code: null, signal: null });
  return out;
}

/**
 * Handle one message from the editor. Returns false when it isn't a terminal
 * message (so the caller can try other handlers); invalid terminal messages are ignored.
 */
export async function handleTerminalMessage(session: TerminalSession, msg: unknown, reply?: (m: TerminalServerMessage) => void): Promise<boolean> {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "term-input":
      if (typeof m.data === "string" && m.data.length <= MAX_INPUT) session.write(m.data);
      return true;
    case "term-resize":
      if (Number.isInteger(m.cols) && Number.isInteger(m.rows)) session.resize(m.cols as number, m.rows as number);
      return true;
    case "term-restart":
      try {
        await session.restart();
      } catch (err) {
        reply?.({ type: "term-error", message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    case "term-stop":
      await session.stop();
      return true;
    default:
      return false;
  }
}
