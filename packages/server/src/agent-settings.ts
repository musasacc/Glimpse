/**
 * Glimpse's global settings (one file per user, not per project): which AI runs the human's requests,
 * and the Anthropic API key for the built-in API engine.
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

/**
 * - `auto`: an external agent if one is waiting (`glimpse wait`, MCP), else Claude Code, Codex, the API — the first one available
 * - `claude` / `codex`: that CLI, run by Glimpse in the project folder
 * - `api`: the Anthropic API with the key from the settings (or ANTHROPIC_API_KEY)
 * - `external`: never run anything; requests wait for an external agent (Glimpse's behaviour before the built-in agents)
 */
export type AgentEngine = "auto" | "claude" | "codex" | "api" | "external";
export const AGENT_ENGINES: readonly AgentEngine[] = ["auto", "claude", "codex", "api", "external"];

export interface AgentSettings {
  engine: AgentEngine;
  /** Only ever read by Glimpse itself: never sent to the editor. */
  anthropicApiKey?: string;
}

/** A change to the settings: `anthropicApiKey: null` removes the key. */
export interface AgentSettingsPatch {
  engine?: AgentEngine;
  anthropicApiKey?: string | null;
}

/** Which built-in engines could run on this machine right now. */
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

async function readRaw(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fromRaw(raw: Record<string, unknown>): AgentSettings {
  const key = typeof raw.anthropicApiKey === "string" && raw.anthropicApiKey.trim() ? raw.anthropicApiKey.trim() : undefined;
  return { engine: isEngine(raw.engine) ? raw.engine : "auto", ...(key && { anthropicApiKey: key }) };
}

/** The settings; a missing, unreadable or invalid file (or field) gives the defaults (`engine: "auto"`, no key). */
export async function loadAgentSettings(): Promise<AgentSettings> {
  return fromRaw(await readRaw());
}

/** Change some settings and save them (keys Glimpse doesn't know are kept). Returns the new settings. */
export async function saveAgentSettings(patch: AgentSettingsPatch): Promise<AgentSettings> {
  if (patch.engine !== undefined && !isEngine(patch.engine)) throw new Error(`Unknown engine: ${String(patch.engine)}`);
  const raw = await readRaw();
  if (patch.engine !== undefined) raw.engine = patch.engine;
  if (patch.anthropicApiKey === null) delete raw.anthropicApiKey;
  else if (typeof patch.anthropicApiKey === "string") raw.anthropicApiKey = patch.anthropicApiKey.trim();
  const file = settingsPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
  return fromRaw(raw);
}

/** The API key the API engine uses: the one in the settings, else ANTHROPIC_API_KEY. Never leaves the server. */
export function resolveAnthropicKey(settings: AgentSettings): string | undefined {
  return settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
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

/** Which built-in engines are available: the claude and codex CLIs on PATH, an API key in the settings or the environment. */
export async function detectAgents(settings?: AgentSettings): Promise<DetectedAgents> {
  const s = settings ?? (await loadAgentSettings());
  return { claude: !!findAgentBinary("claude"), codex: !!findAgentBinary("codex"), api: !!resolveAnthropicKey(s) };
}
