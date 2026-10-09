/** The built-in agent's public types (kept apart from the runner, so they don't pull in the SDKs' types). */
import type { ApiProvider, KeyProvider, Quality } from "./agent-providers.js";
import type { AgentEngine } from "./agent-settings.js";

export type BuiltInEngine = "claude" | "codex" | "api";
/** Who gets the next request: a built-in engine, the external agent that is waiting, or nobody (it waits in the queue). */
export type ResolvedEngine = BuiltInEngine | "external" | "none";

export interface AgentInfo {
  /** Who would handle a request sent now. */
  engine: ResolvedEngine;
  /** The engine chosen in the settings. */
  preferred: AgentEngine;
  /** What could run: the CLIs found on this machine, an API key, and whether an external agent is waiting right now. */
  available: { claude: boolean; codex: boolean; api: boolean; external: boolean };
  /** The built-in run in progress. `startedAt` is in ms since the epoch. */
  running: { seq: number; engine: BuiltInEngine; startedAt: number } | null;
  /** Handoffs waiting for the built-in agent behind the running one. */
  queued: number;
  /** The Direct API engine's settings. Keys never leave the server: only whether one is saved or set in the environment. */
  api: AgentApiInfo;
  quality: Quality;
  /** Claude Code may run shell commands too. */
  allowCommands: boolean;
  /** Steps the API engine takes at most. */
  maxSteps: number;
  /** Appended to every request ("" when none). */
  customInstructions: string;
}

export interface AgentApiInfo {
  provider: ApiProvider;
  /** The model it uses (the chosen one, else the default). */
  model: string;
  /** The model chosen in the settings ("" when the default is used). */
  chosenModel: string;
  /** Per provider: its default model and suggestions for the picker. */
  providers: Record<ApiProvider, { name: string; defaultModel: string; models: string[] }>;
  /** A key saved in Glimpse's settings, per provider. */
  keysSaved: Record<KeyProvider, boolean>;
  /** A key in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY / GOOGLE_API_KEY, OPENROUTER_API_KEY). */
  envKeys: Record<KeyProvider, boolean>;
  /** Ollama's address, whether it answers there, and its installed models. */
  ollama: { baseUrl: string; running: boolean; models: string[] };
}

/** Websocket message about a built-in run. A stopped run ends with `error` and text "Stopped". */
export interface AgentRunEvent {
  type: "agent-run";
  event: "start" | "output" | "done" | "error";
  seq: number;
  engine: BuiltInEngine;
  text?: string;
  /** ms since the epoch */
  at: number;
}

/** The run in progress, for editors that connect while it runs (hello, GET /api/session). */
export interface AgentRunState {
  seq: number;
  engine: BuiltInEngine;
  /** ms since the epoch */
  startedAt: number;
  /** Its latest output lines (up to 40). */
  output: string[];
}
