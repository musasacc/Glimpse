// The home window's logic that doesn't need Electron: what builds a request (AI engine), checking what the page
// sends, naming a new project folder after the request, and handing the request to a project's Glimpse server.
import { join } from "node:path";
import type { AiEngine, AiInfo, BuildTarget, HomeRequest, ResolvedAiEngine, SaveAiPatch } from "./api.js";

export const AI_ENGINES: readonly AiEngine[] = ["auto", "claude", "codex", "api", "external"];
export const BUILD_TARGETS: readonly BuildTarget[] = ["html", "react", "tui", "native"];

/** Same names as the editor's engine chip (packages/editor/src/agent.ts). */
export const ENGINE_LABELS: Record<ResolvedAiEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  api: "Claude API",
  external: "Your agent",
  none: "Set up AI",
};

/** Who would build a request (as the server's resolveEngine decides it, with no external agent listening yet). */
export function resolveEngine(preferred: AiEngine, available: { claude: boolean; codex: boolean; api: boolean }): ResolvedAiEngine {
  if (preferred === "external") return "external";
  if (preferred === "auto") return available.claude ? "claude" : available.codex ? "codex" : available.api ? "api" : "none";
  return available[preferred] ? preferred : "none";
}

/** What the home page may know about the AI settings: never the API key itself, only whether one is saved. */
export function aiInfo(settings: { engine: AiEngine; anthropicApiKey?: string }, available: { claude: boolean; codex: boolean; api: boolean }): AiInfo {
  const engine = resolveEngine(settings.engine, available);
  return {
    preferred: settings.engine,
    engine,
    label: ENGINE_LABELS[engine],
    available: { claude: available.claude, codex: available.codex, api: available.api },
    keySaved: !!settings.anthropicApiKey,
  };
}

const MAX_KEY = 500;
const MAX_REQUEST = 20_000;

/** The settings change the page asked for, checked (anything unexpected is an error, not ignored). */
export function parseSaveAi(input: unknown): SaveAiPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected { engine?, anthropicApiKey? }");
  const { engine, anthropicApiKey } = input as Record<string, unknown>;
  const patch: SaveAiPatch = {};
  if (engine !== undefined) {
    if (typeof engine !== "string" || !(AI_ENGINES as readonly string[]).includes(engine)) throw new Error(`Unknown engine: ${String(engine)}`);
    patch.engine = engine as AiEngine;
  }
  if (anthropicApiKey === null) patch.anthropicApiKey = null;
  else if (anthropicApiKey !== undefined) {
    const key = typeof anthropicApiKey === "string" ? anthropicApiKey.trim() : "";
    if (!key || key.length > MAX_KEY || /\s/.test(key)) throw new Error("That doesn't look like an API key");
    patch.anthropicApiKey = key;
  }
  return patch;
}

/** The request the page sends: non-empty text and a known target. */
export function parseRequest(input: unknown): HomeRequest {
  if (!input || typeof input !== "object") throw new Error("Expected { text, target }");
  const { text, target } = input as Record<string, unknown>;
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("Describe what to build first");
  if (t.length > MAX_REQUEST) throw new Error("That request is too long");
  if (typeof target !== "string" || !(BUILD_TARGETS as readonly string[]).includes(target)) throw new Error(`Unknown target: ${String(target)}`);
  return { text: t, target: target as BuildTarget };
}

const STOP = new Set(
  "a an the and or of for to with in on at by from my our your me us i we it its this that some please make build create design want need would like can could give".split(
    " ",
  ),
);

/** A folder name for a new project, from what it should be: "A landing page for a coffee brand" → "landing-page". */
export function projectSlug(text: string, maxWords = 2): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
  const slug = words.slice(0, maxWords).join("-").slice(0, 40).replace(/-+$/, "");
  return slug || "my-project";
}

/** `<parent>/<name>`, or `<name>-2`, `-3`… when that is taken. */
export function uniqueFolder(parent: string, name: string, exists: (path: string) => boolean): string {
  let candidate = join(parent, name);
  for (let i = 2; exists(candidate) && i < 1000; i++) candidate = join(parent, `${name}-${i}`);
  return candidate;
}

/**
 * Hand a request to a project's Glimpse server, as the editor's Home does (POST /api/request). From the main
 * process there is no Origin header, which the server treats as a local tool, like the CLI.
 */
export async function postRequest(serverUrl: string, req: HomeRequest, fetchImpl: typeof fetch = fetch): Promise<{ seq: number; delivered: boolean }> {
  const res = await fetchImpl(`${serverUrl}/api/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: req.text, target: req.target }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { seq?: number; delivered?: boolean; error?: string };
  if (!res.ok || typeof body.seq !== "number") throw new Error(body.error ?? `The Glimpse server answered ${res.status}`);
  return { seq: body.seq, delivered: !!body.delivered };
}
