/**
 * Glimpse's global settings (one file per user, not per project): which AI runs the human's requests, the
 * provider, model and API keys of the built-in API engine, and how the AI behaves (quality, steps, instructions).
 *
 *   $GLIMPSE_CONFIG_DIR/settings.json, or
 *   macOS    ~/Library/Application Support/Glimpse/settings.json
 *   Windows  %APPDATA%\Glimpse\settings.json
 *   Linux    ${XDG_CONFIG_HOME:-~/.config}/glimpse/settings.json
 *
 * The file holds a secret, so it is written with mode 0600 in a 0700 folder.
 */
import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  DEFAULT_MAX_STEPS,
  isApiProvider,
  isKeyProvider,
  isQuality,
  KEY_PROVIDERS,
  MAX_INSTRUCTIONS,
  MAX_STEPS_LIMIT,
  OLLAMA_DEFAULT_URL,
  PROVIDERS,
  type ApiProvider,
  type KeyProvider,
  type Quality,
} from "./agent-providers.js";

/**
 * - `auto`: an external agent if one is waiting (`glimpse wait`, MCP), else Claude Code, Codex, the API — the first one available
 * - `claude` / `codex`: that CLI, run by Glimpse in the project folder
 * - `api`: Glimpse calls a model provider's API itself (Anthropic, OpenAI, Gemini, OpenRouter or a local Ollama)
 * - `external`: never run anything; requests wait for an external agent (Glimpse's behaviour before the built-in agents)
 */
export type AgentEngine = "auto" | "claude" | "codex" | "api" | "external";
export const AGENT_ENGINES: readonly AgentEngine[] = ["auto", "claude", "codex", "api", "external"];

export interface ApiSettings {
  provider: ApiProvider;
  /** The model id; unset: the provider's default. */
  model?: string;
  /** Ollama's address (default http://localhost:11434). */
  baseUrl?: string;
  /** Only ever read by Glimpse itself: never sent to the editor. */
  keys: Partial<Record<KeyProvider, string>>;
}

export interface AgentSettings {
  engine: AgentEngine;
  api: ApiSettings;
  quality: Quality;
  /** Claude Code may also run shell commands (default: it only edits files). */
  allowCommands: boolean;
  /** Tool-loop iterations of the API engine before it gives up. */
  maxSteps: number;
  /** Appended to every request Glimpse's own AI gets ("use Tailwind"). */
  customInstructions?: string;
}

/** A change to the settings: `null` removes a value (a key, the model, the base URL, the instructions). */
export interface AgentSettingsPatch {
  engine?: AgentEngine;
  /** Older clients: the Anthropic key (same as `api.keys.anthropic`). */
  anthropicApiKey?: string | null;
  api?: {
    provider?: ApiProvider;
    model?: string | null;
    baseUrl?: string | null;
    keys?: Partial<Record<KeyProvider, string | null>>;
  };
  quality?: Quality;
  allowCommands?: boolean;
  maxSteps?: number;
  customInstructions?: string | null;
}

/** Which built-in engines could run on this machine right now (`api`: the chosen provider has a key, or Ollama answers). */
export interface DetectedAgents {
  claude: boolean;
  codex: boolean;
  api: boolean;
}

/** The folder Glimpse's global settings live in. */
export function configDir(): string {
  const override = process.env.GLIMPSE_CONFIG_DIR?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Glimpse");
  if (process.platform === "win32") return join(process.env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "Glimpse");
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "glimpse");
}

export function settingsPath(): string {
  return join(configDir(), "settings.json");
}

const isEngine = (v: unknown): v is AgentEngine => typeof v === "string" && (AGENT_ENGINES as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function readRaw(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const KEY_RE = /^\S{1,400}$/;
const MODEL_RE = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

function str(v: unknown, re: RegExp): string | undefined {
  return typeof v === "string" && re.test(v.trim()) ? v.trim() : undefined;
}

/** The settings in a file, tolerantly: anything invalid falls back to its default. An old file's `anthropicApiKey` is the Anthropic key. */
function fromRaw(raw: Record<string, unknown>): AgentSettings {
  const rawApi = isObject(raw.api) ? raw.api : {};
  const rawKeys = isObject(rawApi.keys) ? rawApi.keys : {};
  const keys: Partial<Record<KeyProvider, string>> = {};
  for (const p of KEY_PROVIDERS) {
    const k = str(rawKeys[p], KEY_RE) ?? (p === "anthropic" ? str(raw.anthropicApiKey, KEY_RE) : undefined);
    if (k) keys[p] = k;
  }
  const model = str(rawApi.model, MODEL_RE);
  const baseUrl = typeof rawApi.baseUrl === "string" ? normalizeBaseUrl(rawApi.baseUrl) : undefined;
  const steps = raw.maxSteps;
  const instructions = typeof raw.customInstructions === "string" ? raw.customInstructions.trim().slice(0, MAX_INSTRUCTIONS) : "";
  return {
    engine: isEngine(raw.engine) ? raw.engine : "auto",
    api: { provider: isApiProvider(rawApi.provider) ? rawApi.provider : "anthropic", ...(model && { model }), ...(baseUrl && { baseUrl }), keys },
    quality: isQuality(raw.quality) ? raw.quality : "balanced",
    allowCommands: raw.allowCommands === true,
    maxSteps: typeof steps === "number" && Number.isInteger(steps) && steps >= 1 && steps <= MAX_STEPS_LIMIT ? steps : DEFAULT_MAX_STEPS,
    ...(instructions && { customInstructions: instructions }),
  };
}

/** The settings; a missing, unreadable or invalid file (or field) gives the defaults (`engine: "auto"`, no keys). */
export async function loadAgentSettings(): Promise<AgentSettings> {
  return fromRaw(await readRaw());
}

/**
 * Ollama's address, checked: http(s) on this machine only (localhost, 127.0.0.1, [::1]), without a trailing slash
 * or `/v1`. Undefined when it isn't one.
 */
export function normalizeBaseUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Thrown for a settings change that doesn't make sense (the server answers 400 with its message). */
export class SettingsError extends Error {}

/**
 * A settings change from a client, checked strictly: unknown fields, wrong types and odd values are errors.
 * Keys: 1–400 characters without whitespace. Ollama's base URL must be on this machine.
 */
export function validateSettingsPatch(input: unknown): AgentSettingsPatch {
  if (!isObject(input)) throw new SettingsError("Expected a settings object");
  const fail = (msg: string): never => {
    throw new SettingsError(msg);
  };
  const known = new Set(["engine", "anthropicApiKey", "api", "quality", "allowCommands", "maxSteps", "customInstructions"]);
  for (const k of Object.keys(input)) if (!known.has(k)) fail(`Unknown setting: ${k}`);
  const key = (v: unknown, what: string): string | null => {
    if (v === null) return null;
    if (typeof v !== "string" || !KEY_RE.test(v.trim())) fail(`That doesn't look like ${what}`);
    return (v as string).trim();
  };
  const patch: AgentSettingsPatch = {};
  const { engine, anthropicApiKey, api, quality, allowCommands, maxSteps, customInstructions } = input;
  if (engine !== undefined) {
    if (!isEngine(engine)) fail(`Unknown engine: ${String(engine)}`);
    patch.engine = engine as AgentEngine;
  }
  if (anthropicApiKey !== undefined) patch.anthropicApiKey = key(anthropicApiKey, "an Anthropic API key");
  if (api !== undefined) {
    if (!isObject(api)) fail("Expected api to be an object");
    const a = api as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!["provider", "model", "baseUrl", "keys"].includes(k)) fail(`Unknown API setting: ${k}`);
    const out: NonNullable<AgentSettingsPatch["api"]> = {};
    if (a.provider !== undefined) {
      if (!isApiProvider(a.provider)) fail(`Unknown provider: ${String(a.provider)}`);
      out.provider = a.provider as ApiProvider;
    }
    if (a.model !== undefined) {
      if (a.model === null || (typeof a.model === "string" && !a.model.trim())) out.model = null;
      else if (typeof a.model !== "string" || !MODEL_RE.test(a.model.trim())) fail("That doesn't look like a model name");
      else out.model = a.model.trim();
    }
    if (a.baseUrl !== undefined) {
      if (a.baseUrl === null || (typeof a.baseUrl === "string" && !a.baseUrl.trim())) out.baseUrl = null;
      else {
        const url = typeof a.baseUrl === "string" && a.baseUrl.length <= 300 ? normalizeBaseUrl(a.baseUrl) : undefined;
        if (!url) fail("Ollama's address must be an http(s) URL on this machine, like http://localhost:11434");
        out.baseUrl = url!;
      }
    }
    if (a.keys !== undefined) {
      if (!isObject(a.keys)) fail("Expected api.keys to be an object");
      const keys: Partial<Record<KeyProvider, string | null>> = {};
      for (const [p, v] of Object.entries(a.keys as Record<string, unknown>)) {
        if (!isKeyProvider(p)) fail(`No API key for ${p}`);
        keys[p as KeyProvider] = key(v, `an API key for ${PROVIDERS[p as KeyProvider].name}`);
      }
      out.keys = keys;
    }
    patch.api = out;
  }
  if (quality !== undefined) {
    if (!isQuality(quality)) fail(`Unknown quality: ${String(quality)}`);
    patch.quality = quality as Quality;
  }
  if (allowCommands !== undefined) {
    if (typeof allowCommands !== "boolean") fail("Expected allowCommands to be true or false");
    patch.allowCommands = allowCommands as boolean;
  }
  if (maxSteps !== undefined) {
    if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) fail(`Max steps must be a whole number from 1 to ${MAX_STEPS_LIMIT}`);
    patch.maxSteps = maxSteps as number;
  }
  if (customInstructions !== undefined) {
    if (customInstructions !== null && typeof customInstructions !== "string") fail("Expected customInstructions to be text");
    if (typeof customInstructions === "string" && customInstructions.length > MAX_INSTRUCTIONS) fail(`Custom instructions are limited to ${MAX_INSTRUCTIONS} characters`);
    patch.customInstructions = typeof customInstructions === "string" && customInstructions.trim() ? customInstructions.trim() : null;
  }
  return patch;
}

/**
 * Change some settings and save them (fields Glimpse doesn't know are kept). Returns the new settings.
 * The file is written in the current shape: an old file's `anthropicApiKey` moves to `api.keys.anthropic`.
 */
export async function saveAgentSettings(patch: AgentSettingsPatch): Promise<AgentSettings> {
  const p = validateSettingsPatch(patch);
  const raw = await readRaw();
  const current = fromRaw(raw);
  const api: Record<string, unknown> = isObject(raw.api) ? { ...raw.api } : {};
  const keys: Record<string, unknown> = { ...current.api.keys };
  if (p.anthropicApiKey !== undefined) keys.anthropic = p.anthropicApiKey;
  for (const [k, v] of Object.entries(p.api?.keys ?? {})) keys[k] = v;
  for (const k of Object.keys(keys)) if (keys[k] === null) delete keys[k];
  api.keys = keys;
  api.provider = p.api?.provider ?? current.api.provider;
  for (const field of ["model", "baseUrl"] as const) {
    const v = p.api?.[field];
    if (v === null) delete api[field];
    else if (v !== undefined) api[field] = v;
  }
  delete raw.anthropicApiKey;
  raw.api = api;
  if (p.engine !== undefined) raw.engine = p.engine;
  if (p.quality !== undefined) raw.quality = p.quality;
  if (p.allowCommands !== undefined) raw.allowCommands = p.allowCommands;
  if (p.maxSteps !== undefined) raw.maxSteps = p.maxSteps;
  if (p.customInstructions === null) delete raw.customInstructions;
  else if (p.customInstructions !== undefined) raw.customInstructions = p.customInstructions;
  const file = settingsPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
  return fromRaw(raw);
}

/** A provider's key from its environment variable(s), if one is set. */
export function envApiKey(provider: KeyProvider): string | undefined {
  for (const name of PROVIDERS[provider].envKeys) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** The key the API engine uses for a provider: the one in the settings, else its environment variable. Never leaves the server. */
export function resolveApiKey(settings: AgentSettings, provider: KeyProvider): string | undefined {
  return settings.api.keys[provider] || envApiKey(provider);
}

/** The Anthropic key (the settings', else ANTHROPIC_API_KEY). */
export function resolveAnthropicKey(settings: AgentSettings): string | undefined {
  return resolveApiKey(settings, "anthropic");
}

/** Ollama's address from the settings (default http://localhost:11434). */
export function ollamaUrl(settings: AgentSettings): string {
  return settings.api.baseUrl || OLLAMA_DEFAULT_URL;
}

export interface OllamaStatus {
  running: boolean;
  /** The installed models (`ollama list`). */
  models: string[];
}

const OLLAMA_TIMEOUT_MS = 800;
const OLLAMA_TTL_MS = 30_000;
const ollamaCache = new Map<string, { at: number; status: Promise<OllamaStatus> }>();

/** Whether Ollama answers at `baseUrl` and which models it has: a short probe of /api/tags, cached for 30 s. */
export function detectOllama(baseUrl: string = OLLAMA_DEFAULT_URL): Promise<OllamaStatus> {
  const hit = ollamaCache.get(baseUrl);
  if (hit && Date.now() - hit.at < OLLAMA_TTL_MS) return hit.status;
  const status = (async (): Promise<OllamaStatus> => {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
      if (!res.ok) return { running: false, models: [] };
      const body = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
      const models = (Array.isArray(body?.models) ? body.models : [])
        .map((m) => (typeof m?.name === "string" ? m.name : typeof m?.model === "string" ? m.model : ""))
        .filter((n) => n && MODEL_RE.test(n))
        .slice(0, 100);
      return { running: true, models };
    } catch {
      return { running: false, models: [] };
    }
  })();
  ollamaCache.set(baseUrl, { at: Date.now(), status });
  return status;
}

/** Probe Ollama again next time (the settings changed, or the human asked to refresh). */
export function clearOllamaCache(): void {
  ollamaCache.clear();
}

/** The model the API engine uses: the settings', else the provider's default (Ollama: its first installed model). */
export function effectiveModel(settings: AgentSettings, ollamaModels: string[] = []): string {
  if (settings.api.model) return settings.api.model;
  if (settings.api.provider === "ollama") return ollamaModels[0] ?? PROVIDERS.ollama.defaultModel;
  return PROVIDERS[settings.api.provider].defaultModel;
}

/** The chosen API provider can run: it has a key, or (Ollama) it answers. */
export async function apiAvailable(settings: AgentSettings): Promise<boolean> {
  const p = settings.api.provider;
  return p === "ollama" ? (await detectOllama(ollamaUrl(settings))).running : !!resolveApiKey(settings, p);
}

/**
 * The absolute path of a command on PATH (or in a few places CLIs install to that a GUI app's PATH often lacks),
 * or undefined. GLIMPSE_AGENT_CLAUDE_BIN / GLIMPSE_AGENT_CODEX_BIN name the binary directly (tests, unusual installs).
 */
export function findAgentBinary(name: "claude" | "codex"): string | undefined {
  const override = process.env[`GLIMPSE_AGENT_${name.toUpperCase()}_BIN`]?.trim();
  if (override) return isFile(override) ? override : undefined;
  return findExecutable(name);
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isWindows = process.platform === "win32";
  const home = homedir();
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (isWindows) dirs.push(join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"));
  else dirs.push(join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin");
  const exts = isWindows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      if (!isFile(p)) continue;
      if (isWindows) {
        if (ext) return p;
        continue;
      }
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not executable
      }
    }
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Which built-in engines are available: the claude and codex CLIs on PATH, and the chosen API provider (a key, or Ollama answering). */
export async function detectAgents(settings?: AgentSettings): Promise<DetectedAgents> {
  const s = settings ?? (await loadAgentSettings());
  return { claude: !!findAgentBinary("claude"), codex: !!findAgentBinary("codex"), api: await apiAvailable(s) };
}
