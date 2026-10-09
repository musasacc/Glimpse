export { startServer, type GlimpseServer, type Handoff, type HandoffKind, type HandoffSummary, type ServerOptions } from "./server.js";
export { detectProject, SCENE_FILE, type ProjectInfo } from "./detect.js";
export {
  detectAgents,
  loadAgentSettings,
  saveAgentSettings,
  type AgentEngine,
  type AgentSettings,
  type AgentSettingsPatch,
  type DetectedAgents,
} from "./agent-settings.js";
export { type AgentInfo, type AgentRunEvent, type AgentRunState, type BuiltInEngine, type ResolvedEngine } from "./agent-types.js";
export { injectClient } from "./inject.js";
export { openBrowser } from "./browser.js";
export { findRunningServer, projectDirKey, sameDir, servesProject, withProjectLock, type ServerInfo } from "./running.js";
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
