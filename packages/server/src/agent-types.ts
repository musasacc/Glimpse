/** The built-in agent's public types (kept apart from the runner, so they don't pull in the Anthropic SDK's types). */
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
