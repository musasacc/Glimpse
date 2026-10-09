/**
 * The AI that builds the UI. Newer Glimpse servers run it themselves (Claude Code, Codex, or the Claude API with
 * the user's key); an external agent can still connect over MCP. Older servers know none of this: the editor then
 * behaves as before ("your agent"), which `normalizeAgentInfo` returning null stands for.
 */

export type Engine = "claude" | "codex" | "api" | "external" | "none";
import { apiFetch } from "./session";
export type Preferred = "auto" | "claude" | "codex" | "api" | "external";
export type ApiProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "ollama";
export type KeyProvider = Exclude<ApiProvider, "ollama">;
export type Quality = "fast" | "balanced" | "best";

export const API_PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai", "gemini", "openrouter", "ollama"];
export const KEY_PROVIDERS: readonly KeyProvider[] = ["anthropic", "openai", "gemini", "openrouter"];
export const QUALITIES: readonly Quality[] = ["fast", "balanced", "best"];

/** What the dialog shows per provider (the server's list of models wins when it sends one). */
export const PROVIDER_META: Record<ApiProvider, { name: string; short: string; keyUrl?: string; keyHint?: string; defaultModel: string; models: string[] }> = {
  anthropic: {
    name: "Anthropic",
    short: "Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  },
  openai: { name: "OpenAI", short: "GPT", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…", defaultModel: "gpt-5", models: ["gpt-5", "gpt-5-mini"] },
  gemini: { name: "Google Gemini", short: "Gemini", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza…", defaultModel: "gemini-2.5-pro", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  openrouter: { name: "OpenRouter", short: "OpenRouter", keyUrl: "https://openrouter.ai/keys", keyHint: "sk-or-…", defaultModel: "anthropic/claude-opus-5-5", models: ["anthropic/claude-opus-5-5"] },
  ollama: { name: "Ollama", short: "Ollama", defaultModel: "llama3.2", models: [] },
};

export interface ApiInfo {
  provider: ApiProvider;
  /** The model it uses. */
  model: string;
  /** The model chosen in the settings ("" = the provider's default). */
  chosenModel: string;
  providers: Record<ApiProvider, { name: string; defaultModel: string; models: string[] }>;
  keysSaved: Record<KeyProvider, boolean>;
  envKeys: Record<KeyProvider, boolean>;
  ollama: { baseUrl: string; running: boolean; models: string[] };
}

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
  /** The Direct API settings; null from a server that only knows the Anthropic key. */
  api: ApiInfo | null;
  /** Behavior settings; null from an older server. */
  behavior: { quality: Quality; allowCommands: boolean; maxSteps: number; customInstructions: string } | null;
}

/** A settings change (POST /api/agent/settings). Keys: a string saves one, null removes it. */
export interface SettingsPatch {
  engine?: Preferred;
  anthropicApiKey?: string | null;
  api?: { provider?: ApiProvider; model?: string | null; baseUrl?: string | null; keys?: Partial<Record<KeyProvider, string | null>> };
  quality?: Quality;
  allowCommands?: boolean;
  maxSteps?: number;
  customInstructions?: string | null;
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

/** A model id, shortened for a chip: "anthropic/claude-opus-5-5" → "claude-opus-5-5", "llama3.2:latest" → "llama3.2". */
export function shortModel(model: string): string {
  return model.replace(/^.*\//, "").replace(/:latest$/, "");
}

/**
 * What the chip calls the AI: "Claude Code", "Codex", and for the Direct API the provider and model —
 * "Claude · opus-5-5", "GPT · OpenAI", "Gemini", "Ollama · llama3", "OpenRouter · claude-opus-5-5".
 */
export function engineLabel(engine: Engine | null | undefined, info: Pick<AgentInfo, "api"> | null | undefined): string {
  if (engine !== "api" || !info?.api) return engineName(engine);
  const { provider, model } = info.api;
  switch (provider) {
    case "anthropic":
      return `Claude · ${model.replace(/^claude-/, "")}`;
    case "openai":
      return /^gpt/i.test(model) ? "GPT · OpenAI" : `OpenAI · ${shortModel(model)}`;
    case "gemini":
      return "Gemini";
    case "ollama":
      return `Ollama · ${shortModel(model)}`;
    case "openrouter":
      return `OpenRouter · ${shortModel(model)}`;
  }
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

const isOneOf = <T extends string>(list: readonly T[], x: unknown): x is T => typeof x === "string" && (list as readonly string[]).includes(x);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
const flags = (x: unknown): Record<KeyProvider, boolean> => {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return Object.fromEntries(KEY_PROVIDERS.map((p) => [p, o[p] === true])) as Record<KeyProvider, boolean>;
};

function normalizeApi(x: unknown): ApiInfo | null {
  if (!x || typeof x !== "object") return null;
  const a = x as Record<string, unknown>;
  if (!isOneOf(API_PROVIDERS, a.provider)) return null;
  const rawProviders = (a.providers && typeof a.providers === "object" ? a.providers : {}) as Record<string, unknown>;
  const providers = Object.fromEntries(
    API_PROVIDERS.map((p) => {
      const r = (rawProviders[p] && typeof rawProviders[p] === "object" ? rawProviders[p] : {}) as Record<string, unknown>;
      const meta = PROVIDER_META[p];
      return [
        p,
        {
          name: typeof r.name === "string" ? r.name : meta.name,
          defaultModel: typeof r.defaultModel === "string" && r.defaultModel ? r.defaultModel : meta.defaultModel,
          models: Array.isArray(r.models) ? strings(r.models) : meta.models,
        },
      ];
    }),
  ) as ApiInfo["providers"];
  const o = (a.ollama && typeof a.ollama === "object" ? a.ollama : {}) as Record<string, unknown>;
  return {
    provider: a.provider,
    model: typeof a.model === "string" && a.model ? a.model : providers[a.provider].defaultModel,
    chosenModel: typeof a.chosenModel === "string" ? a.chosenModel : "",
    providers,
    keysSaved: flags(a.keysSaved),
    envKeys: flags(a.envKeys),
    ollama: { baseUrl: typeof o.baseUrl === "string" && o.baseUrl ? o.baseUrl : "http://localhost:11434", running: o.running === true, models: strings(o.models) },
  };
}

function normalizeBehavior(o: Record<string, unknown>): AgentInfo["behavior"] {
  if (!isOneOf(QUALITIES, o.quality)) return null;
  return {
    quality: o.quality,
    allowCommands: o.allowCommands === true,
    maxSteps: typeof o.maxSteps === "number" && Number.isInteger(o.maxSteps) && o.maxSteps > 0 ? o.maxSteps : 40,
    customInstructions: typeof o.customInstructions === "string" ? o.customInstructions : "",
  };
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
    api: normalizeApi(o.api),
    behavior: normalizeBehavior(o),
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
    const res = await apiFetch("/api/agent");
    if (!res.ok) return null;
    return normalizeAgentInfo(await json(res));
  } catch {
    return null;
  }
}

/** Change the AI settings (engine, provider, keys, model, behavior). Throws the server's error. */
export async function saveAgentSettings(body: SettingsPatch): Promise<AgentInfo> {
  const res = await apiFetch("/api/agent/settings", {
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

/** Run a request again whose built-in run failed or was stopped (it waits for an AI meanwhile). Throws the server's error. */
export async function retryHandoff(seq: number): Promise<{ delivered: boolean; engine?: string }> {
  const res = await apiFetch(`/api/handoffs/${seq}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const out = (await json(res)) as { delivered?: boolean; engine?: string; error?: string } | null;
  if (!res.ok) throw new Error(out?.error || res.statusText || `HTTP ${res.status}`);
  return { delivered: !!out?.delivered, ...(out?.engine && { engine: out.engine }) };
}

/** Stop the running AI. */
export async function stopAgent(): Promise<void> {
  const res = await apiFetch("/api/agent/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) {
    const out = await json(res);
    const error = out && typeof out === "object" && typeof (out as { error?: unknown }).error === "string" ? (out as { error: string }).error : "";
    throw new Error(error || res.statusText || `HTTP ${res.status}`);
  }
}
