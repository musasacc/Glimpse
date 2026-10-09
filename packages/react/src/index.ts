export { instrumentJsx, type InstrumentJsxOptions } from "./instrument-jsx.js";
export { glimpseVitePlugin, type GlimpseVitePluginOptions } from "./vite-plugin.js";
export {
  createReactPreview,
  resolveVite,
  ReactPreviewError,
  type ReactPreview,
  type ReactPreviewErrorCode,
  type ReactPreviewOptions,
} from "./dev-server.js";
export {
  isJsxChange,
  mergePatchPlans,
  patchJsx,
  planJsxPatch,
  type FilePatch,
  type PatchJsxOptions,
  type PatchPlan,
  type PatchResult,
} from "./patch-jsx.js";
export { JSX_FILE, SRC_ATTR } from "./jsx-ast.js";
export { PREVIEW_CLIENT_ID } from "./preview-client.js";
