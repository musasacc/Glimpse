/**
 * The AI that builds the UI. Newer Glimpse servers run it themselves (Claude Code, Codex, or the Claude API with
 * the user's key); an external agent can still connect over MCP. Older servers know none of this: the editor then
 * behaves as before ("your agent"), which `normalizeAgentInfo` returning null stands for.
 */

export type Engine = "claude" | "codex" | "api" | "external" | "none";
export type Preferred = "auto" | "claude" | "codex" | "api" | "external";

export interface AgentRun {
  seq: number;
  engine: Engine;
  startedAt: string;
}

export interface AgentInfo {
  /** What runs the next request ("none": nothing is set up). */
  engine: Engine;
  preferred: Preferred;
  available: { claude: boolean; codex: boolean; api: boolean; external: boolean };
  running: AgentRun | null;
  queued: number;
}

export interface AgentRunMessage {
  event: "start" | "output" | "done" | "error";
  seq: number;
  engine: Engine;
  text?: string;
  at?: string;
}

const ENGINES: readonly Engine[] = ["claude", "codex", "api", "external", "none"];
const PREFERRED: readonly Preferred[] = ["auto", "claude", "codex", "api", "external"];

export const ENGINE_NAMES: Record<Engine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  api: "Claude API",
  external: "Your agent",
  none: "Set up AI",
};

export function engineName(engine: Engine | null | undefined): string {
  return ENGINE_NAMES[engine ?? "external"] ?? ENGINE_NAMES.external;
}

/** Glimpse runs it itself (as opposed to an external agent, or nothing). */
export function isBuiltIn(engine: Engine | null | undefined): boolean {
  return engine === "claude" || engine === "codex" || engine === "api";
}

/**
 * For a dialog that sends something to the AI: a note when it won't start on it right away (an external agent that
 * isn't listening), else "". Glimpse's own AI starts by itself, or queues behind the current run.
 */
export function queuedNote(engine: Engine, agentWaiting: boolean): string {
  return engine === "external" && !agentWaiting ? " It's queued until your agent picks it up." : "";
}

function isEngine(x: unknown): x is Engine {
  return typeof x === "string" && (ENGINES as readonly string[]).includes(x);
}

function normalizeRun(x: unknown): AgentRun | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.seq !== "number" || !isEngine(r.engine)) return null;
  return { seq: r.seq, engine: r.engine, startedAt: typeof r.startedAt === "string" ? r.startedAt : new Date().toISOString() };
}

/** A server's agent info, checked; null when it has none (an older server) or it doesn't make sense. */
export function normalizeAgentInfo(x: unknown): AgentInfo | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!isEngine(o.engine)) return null;
  const a = (o.available && typeof o.available === "object" ? o.available : {}) as Record<string, unknown>;
  return {
    engine: o.engine,
    preferred: typeof o.preferred === "string" && (PREFERRED as readonly string[]).includes(o.preferred) ? (o.preferred as Preferred) : "auto",
    available: { claude: a.claude === true, codex: a.codex === true, api: a.api === true, external: a.external === true },
    running: normalizeRun(o.running),
    queued: typeof o.queued === "number" && o.queued > 0 ? o.queued : 0,
  };
}

/** The run in a hello / session message: `{seq, engine, startedAt, output}` (output: its last lines, to catch up). */
export function normalizeAgentRun(x: unknown): (AgentRun & { output: string[] }) | null {
  const run = normalizeRun(x);
  if (!run) return null;
  const out = (x as { output?: unknown }).output;
  return { ...run, output: Array.isArray(out) ? out.filter((l): l is string => typeof l === "string") : [] };
}

/** A run message from the websocket, checked. */
export function normalizeRunMessage(x: unknown): AgentRunMessage | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  if (m.event !== "start" && m.event !== "output" && m.event !== "done" && m.event !== "error") return null;
  if (typeof m.seq !== "number") return null;
  return {
    event: m.event,
    seq: m.seq,
    engine: isEngine(m.engine) ? m.engine : "external",
    ...(typeof m.text === "string" && { text: m.text }),
    ...(typeof m.at === "string" && { at: m.at }),
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One output chunk as display lines: escapes and control characters gone, blank lines dropped, long ones cut. */
export function outputLines(text: string, max = MAX_LINE): string[] {
  return text
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((l) => l.replace(CONTROL, "").trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > max ? `${l.slice(0, max - 1)}…` : l));
}

const MAX_LINE = 160;
/** Rows one flush adds at most (the latest ones). */
const PER_FLUSH = 3;
/** Output rows one run adds at most; the rest stays in the agent's own log. */
const PER_RUN = 40;
const FLUSH_MS = 300;

export const MORE_HIDDEN = "…more output hidden";

/**
 * What a running AI prints, as activity rows. It may print hundreds of lines a second: they are gathered and added
 * every 300 ms as one batch of at most the latest 3 (one re-render), and a run adds at most 40 such rows.
 */
export class RunFeed {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown = 0;
  private capped = false;

  constructor(private emit: (...texts: string[]) => void) {}

  /** A new run: its rows count from zero. */
  reset(): void {
    this.flush();
    this.shown = 0;
    this.capped = false;
  }

  push(text: string): void {
    if (this.capped) return;
    const lines = outputLines(text);
    if (lines.length === 0) return;
    this.pending.push(...lines);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const lines = this.pending;
    this.pending = [];
    if (lines.length === 0 || this.capped) return;
    let rows = lines.length > PER_FLUSH ? ["…", ...lines.slice(-PER_FLUSH)] : lines;
    const room = PER_RUN - this.shown;
    if (rows.length >= room) {
      rows = [...rows.slice(0, Math.max(0, room - 1)), MORE_HIDDEN];
      this.capped = true;
    }
    this.shown += rows.length;
    this.emit(...rows);
  }
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** GET /api/agent; null when the server can't run the AI itself (older server) or isn't reachable. */
export async function getAgentInfo(): Promise<AgentInfo | null> {
  try {
    const res = await fetch("/api/agent");
    if (!res.ok) return null;
    return normalizeAgentInfo(await json(res));
  } catch {
    return null;
  }
}

/** Choose the engine and/or set (a string) or remove (null) the Anthropic API key. Throws the server's error. */
export async function saveAgentSettings(body: { engine?: Preferred; anthropicApiKey?: string | null }): Promise<AgentInfo> {
  const res = await fetch("/api/agent/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await json(res);
  if (!res.ok) {
    const error = out && typeof out === "object" && typeof (out as { error?: unknown }).error === "string" ? (out as { error: string }).error : "";
    throw new Error(error || (res.status === 404 ? "This version of Glimpse can't run the AI itself." : res.statusText || `HTTP ${res.status}`));
  }
  const info = normalizeAgentInfo(out);
  if (!info) throw new Error("The server sent an unexpected answer.");
  return info;
}

/** Stop the running AI. */
export async function stopAgent(): Promise<void> {
  const res = await fetch("/api/agent/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) {
    const out = await json(res);
    const error = out && typeof out === "object" && typeof (out as { error?: unknown }).error === "string" ? (out as { error: string }).error : "";
    throw new Error(error || res.statusText || `HTTP ${res.status}`);
  }
}
