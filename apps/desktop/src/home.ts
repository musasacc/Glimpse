// The home window's logic that doesn't need Electron: what builds a request (AI engine and Direct API provider), checking what the page
// sends, naming a new project folder after the request, and handing the request to a project's Glimpse server.
import { join } from "node:path";
import type { AiEngine, AiInfo, AiKeyProvider, AiProvider, AiProviderInfo, BuildTarget, HomeRequest, ResolvedAiEngine, SaveAiPatch } from "./api.js";

export const AI_ENGINES: readonly AiEngine[] = ["auto", "claude", "codex", "api", "external"];
export const AI_PROVIDERS: readonly AiProvider[] = ["anthropic", "openai", "gemini", "openrouter", "ollama"];
export const AI_KEY_PROVIDERS: readonly AiKeyProvider[] = ["anthropic", "openai", "gemini", "openrouter"];
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

/** The settings fields the home page's info is made of (glimpse-ui's AgentSettings, of which only key presence is used). */
export interface AiSettingsLike {
  engine: AiEngine;
  api?: { provider: AiProvider; model?: string; keys: Partial<Record<AiKeyProvider, string>> };
  /** Settings of glimpse-ui before the providers. */
  anthropicApiKey?: string;
}

/** What the main process found out about the providers: names, default models, keys in the environment, Ollama. */
export interface AiProviderFacts {
  providers: Record<AiProvider, { name: string; defaultModel: string; models: readonly string[] }>;
  envKeys: Record<AiKeyProvider, boolean>;
  ollama: { running: boolean; models: string[] };
}

const shortModel = (m: string) => m.replace(/^.*\//, "").replace(/:latest$/, "");

/** The chip's name for the Direct API, as the editor's engineLabel: "Claude · opus-5-5", "GPT · OpenAI", "Gemini", "Ollama · llama3". */
export function apiLabel(provider: AiProvider, model: string): string {
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

/** What the home page may know about the AI settings: never an API key itself, only whether one is saved. */
export function aiInfo(settings: AiSettingsLike, available: { claude: boolean; codex: boolean; api: boolean }, facts?: AiProviderFacts): AiInfo {
  const engine = resolveEngine(settings.engine, available);
  const provider = settings.api?.provider ?? "anthropic";
  const keys: Partial<Record<AiKeyProvider, string>> = { ...(settings.anthropicApiKey && { anthropic: settings.anthropicApiKey }), ...settings.api?.keys };
  const defaults = (p: AiProvider) => (p === "ollama" ? (facts?.ollama.models[0] ?? facts?.providers.ollama.defaultModel ?? "llama3.2") : (facts?.providers[p].defaultModel ?? ""));
  const model = settings.api?.model || defaults(provider) || "claude-opus-5-5";
  const providers: AiProviderInfo[] = AI_PROVIDERS.map((p) => {
    const keySaved = p !== "ollama" && !!keys[p];
    const envKey = p !== "ollama" && !!facts?.envKeys[p];
    return {
      id: p,
      name: facts?.providers[p].name ?? p,
      defaultModel: defaults(p),
      models: p === "ollama" ? [...(facts?.ollama.models ?? [])] : [...(facts?.providers[p].models ?? [])],
      keySaved,
      envKey,
      ready: p === "ollama" ? !!facts?.ollama.running : keySaved || envKey,
    };
  });
  return {
    preferred: settings.engine,
    engine,
    label: engine === "api" && (settings.api || facts) ? apiLabel(provider, model) : ENGINE_LABELS[engine],
    available: { claude: available.claude, codex: available.codex, api: available.api },
    keySaved: provider !== "ollama" && !!keys[provider],
    provider,
    model,
    chosenModel: settings.api?.model ?? "",
    providers,
  };
}

const MAX_KEY = 400;
const MAX_MODEL = 200;
const MAX_REQUEST = 20_000;

function parseKey(v: unknown): string {
  const key = typeof v === "string" ? v.trim() : "";
  if (!key || key.length > MAX_KEY || /\s/.test(key)) throw new Error("That doesn't look like an API key");
  return key;
}

/** The settings change the page asked for, checked (anything unexpected is an error, not ignored). */
export function parseSaveAi(input: unknown): SaveAiPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected { engine?, provider?, model?, apiKey? }");
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["engine", "anthropicApiKey", "provider", "model", "apiKey"].includes(k)) throw new Error(`Unknown setting: ${k}`);
  const { engine, anthropicApiKey, provider, model, apiKey } = o;
  const patch: SaveAiPatch = {};
  if (engine !== undefined) {
    if (typeof engine !== "string" || !(AI_ENGINES as readonly string[]).includes(engine)) throw new Error(`Unknown engine: ${String(engine)}`);
    patch.engine = engine as AiEngine;
  }
  if (anthropicApiKey === null) patch.anthropicApiKey = null;
  else if (anthropicApiKey !== undefined) patch.anthropicApiKey = parseKey(anthropicApiKey);
  if (provider !== undefined) {
    if (typeof provider !== "string" || !(AI_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider: ${String(provider)}`);
    patch.provider = provider as AiProvider;
  }
  if (model !== undefined) {
    if (model === null || (typeof model === "string" && !model.trim())) patch.model = null;
    else if (typeof model !== "string" || model.trim().length > MAX_MODEL || /[\s\u0000-\u001f\u007f]/.test(model.trim())) throw new Error("That doesn't look like a model name");
    else patch.model = model.trim();
  }
  if (apiKey !== undefined) {
    if (!apiKey || typeof apiKey !== "object" || Array.isArray(apiKey)) throw new Error("Expected apiKey: { provider, key }");
    const { provider: p, key, ...rest } = apiKey as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error("Expected apiKey: { provider, key }");
    if (typeof p !== "string" || !(AI_KEY_PROVIDERS as readonly string[]).includes(p)) throw new Error(`No API key for ${String(p)}`);
    patch.apiKey = { provider: p as AiKeyProvider, key: key === null ? null : parseKey(key) };
  }
  return patch;
}

/** The page's change as a glimpse-ui settings patch (saveAgentSettings). */
export function toSettingsPatch(patch: SaveAiPatch): {
  engine?: AiEngine;
  anthropicApiKey?: string | null;
  api?: { provider?: AiProvider; model?: string | null; keys?: Partial<Record<AiKeyProvider, string | null>> };
} {
  const api = {
    ...(patch.provider !== undefined && { provider: patch.provider }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.apiKey && { keys: { [patch.apiKey.provider]: patch.apiKey.key } }),
  };
  return {
    ...(patch.engine !== undefined && { engine: patch.engine }),
    ...(patch.anthropicApiKey !== undefined && { anthropicApiKey: patch.anthropicApiKey }),
    ...(Object.keys(api).length > 0 && { api }),
  };
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
