import { relative } from "node:path";
import type { Plugin } from "vite";
import { instrumentJsx } from "./instrument-jsx.js";
import { PREVIEW_CLIENT, PREVIEW_CLIENT_ID } from "./preview-client.js";

export interface GlimpseVitePluginOptions {
  /** Add the preview client (ready / HMR signals for the editor) to index.html. Default true. */
  client?: boolean;
  /** Directory the reported file paths are relative to. Default: Vite's root. */
  root?: string;
}

const SCRIPT = /\.[jt]sx?$/;
/** Module queries that don't load the file as JSX source. */
const NOT_SOURCE = /[?&](?:raw|url|worker|sharedworker|inline)\b/;

/**
 * Vite plugin for the Glimpse preview: tags host JSX elements with
 * `data-glimpse-src="file:line:col"` (file relative to the Vite root, forward
 * slashes) and adds the preview client. Dev server only.
 *
 * It runs first among the `enforce: "pre"` transforms so it sees the file
 * exactly as it is on disk, the same text Edit source patches later.
 */
export function glimpseVitePlugin(options: GlimpseVitePluginOptions = {}): Plugin {
  let root = options.root ?? process.cwd();
  const client = options.client ?? true;
  return {
    name: "glimpse",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      root = options.root ?? config.root;
    },
    resolveId(id) {
      return client && id === PREVIEW_CLIENT_ID ? id : null;
    },
    load(id) {
      return client && id === PREVIEW_CLIENT_ID ? PREVIEW_CLIENT : null;
    },
    transformIndexHtml: {
      // "pre", so Vite still processes the tag (base prefix, module URL).
      order: "pre",
      handler() {
        if (!client) return [];
        return [{ tag: "script", attrs: { type: "module", src: PREVIEW_CLIENT_ID }, injectTo: "head-prepend" }];
      },
    },
    transform: {
      order: "pre",
      handler(code, id) {
        if (id.startsWith("\0") || NOT_SOURCE.test(id)) return null;
        const file = id.replace(/[?#].*$/, "");
        if (!SCRIPT.test(file) || /[\\/]node_modules[\\/]/.test(file) || !code.includes("<")) return null;
        const rel = relative(root, file).split("\\").join("/");
        const out = instrumentJsx(code, rel, { source: file });
        return out ? { code: out.code, map: out.map } : null;
      },
    },
  };
}
