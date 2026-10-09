export { startServer, type GlimpseServer, type Handoff, type HandoffKind, type HandoffSummary, type ServerOptions } from "./server.js";
export { detectProject, SCENE_FILE, type ProjectInfo } from "./detect.js";
export { injectClient } from "./inject.js";
export { openBrowser } from "./browser.js";
export { planPatch, type PatchPlan } from "./patch-html.js";
export { History, type PublicSnapshot, type Snapshot, type SnapshotKind } from "./history.js";
export { type VariantJob } from "./variants.js";
export {
  applyScenePatch,
  describeSceneTarget,
  planScenePatch,
  readScene,
  sceneChangesPrompt,
  SceneConflictError,
  sceneVersion,
  type ScenePatchPlan,
  type SceneRead,
} from "./scene.js";
export {
  bridgeTerminal,
  handleTerminalMessage,
  loadPty,
  ptyAvailable,
  TerminalSession,
  terminalSnapshot,
  type TerminalClientMessage,
  type TerminalEvents,
  type TerminalMode,
  type TerminalServerMessage,
  type TerminalStartInfo,
  type TerminalStartOptions,
} from "./terminal.js";
