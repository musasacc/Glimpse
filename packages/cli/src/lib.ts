/**
 * Programmatic API of the `glimpse-ui` package: everything the `glimpse` command uses, for tools that embed
 * Glimpse (the desktop app, editor integrations, tests).
 *
 *   import { startGlimpse } from "glimpse-ui";
 *   const srv = await startGlimpse({ dir: "./my-app" });
 *   console.log(srv.url);
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type GlimpseServer, type ServerOptions } from "@glimpse/server";

export {
  API_PROVIDERS,
  detectAgents,
  detectOllama,
  effectiveModel,
  envApiKey,
  KEY_PROVIDERS,
  loadAgentSettings,
  ollamaUrl,
  PROVIDERS,
  QUALITIES,
  saveAgentSettings,
  SettingsError,
  validateSettingsPatch,
  type AgentApiInfo,
  type AgentEngine,
  type AgentInfo,
  type ApiProvider,
  type ApiSettings,
  type KeyProvider,
  type OllamaStatus,
  type ProviderInfo,
  type Quality,
  type AgentRunEvent,
  type AgentRunState,
  type AgentSettings,
  type AgentSettingsPatch,
  type BuiltInEngine,
  type DetectedAgents,
  type ResolvedEngine,
  detectProject,
  openBrowser,
  sameDir,
  servesProject,
  startServer,
  withProjectLock,
  type GlimpseServer,
  type Handoff,
  type HandoffKind,
  type HandoffSummary,
  type ProjectInfo,
  type PublicSnapshot,
  type ServerOptions,
  type SnapshotKind,
} from "@glimpse/server";
export { createGlimpseMcp, runStdio, type McpOptions } from "@glimpse/mcp";
// The scene model, ops and change lists (types and the pure helpers that go with them).
export * from "@glimpse/core";

/** Replaced with the package version by scripts/bundle.mjs. */
declare const __GLIMPSE_VERSION__: string | undefined;

/** The version of glimpse-ui. */
export const VERSION: string = typeof __GLIMPSE_VERSION__ === "string" ? __GLIMPSE_VERSION__ : "0.0.0-dev";

/** The built editor UI shipped with this package (`dist/editor`), or undefined when it isn't there (e.g. in a dev checkout). */
export function editorDir(): string | undefined {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "editor");
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

/** Default port of `glimpse open`. */
export const DEFAULT_PORT = 4321;

/**
 * Start Glimpse for a project the way `glimpse open` does: with the bundled editor, on port 4321,
 * or on a free port when 4321 is taken and no port was asked for.
 */
export async function startGlimpse(opts: ServerOptions): Promise<GlimpseServer> {
  const base: ServerOptions = { ...opts, editorDir: opts.editorDir ?? editorDir() };
  if (opts.port !== undefined) return startServer(base);
  return startServer({ ...base, port: DEFAULT_PORT }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return startServer({ ...base, port: 0 });
    throw err;
  });
}
