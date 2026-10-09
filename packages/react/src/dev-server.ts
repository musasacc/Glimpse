import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineConfig, Plugin, ViteDevServer } from "vite";
import { glimpseVitePlugin } from "./vite-plugin.js";

type ViteModule = typeof import("vite");

export type ReactPreviewErrorCode = "VITE_NOT_FOUND";

/** A React project Glimpse can't preview; `message` is written for the human. */
export class ReactPreviewError extends Error {
  readonly code: ReactPreviewErrorCode;

  constructor(code: ReactPreviewErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReactPreviewError";
    this.code = code;
  }
}

export interface ReactPreviewOptions {
  /** The React project (the folder with its package.json and vite.config). */
  dir: string;
  /** URL prefix the preview is served under. Default "/preview/". */
  base?: string;
  /**
   * Glimpse's own HTTP server. Vite's HMR websocket attaches to it, so the
   * preview needs no second port. Its upgrade handler must leave Vite's
   * upgrades alone: see `isViteUpgrade`.
   */
  httpServer: Server;
  /** Extra Vite config merged over Glimpse's (e.g. `{ server: { allowedHosts: true } }` when served on a LAN address). */
  config?: InlineConfig;
}

export interface ReactPreview {
  /** Normalized base, always with leading and trailing slashes. */
  readonly base: string;
  /** Version of the project's own Vite. */
  readonly viteVersion: string;
  /** The underlying Vite dev server (the project's own Vite, in middleware mode). */
  readonly vite: ViteDevServer;
  /** Serve a request under `base` (Vite's middlewares). `next` runs when Vite doesn't answer. */
  handle(req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): void;
  /**
   * Whether the project's `server.proxy` (in its vite.config) sends this request URL on, as `vite` would. The
   * app calls such paths root-absolute (fetch("/api/items")): pass them to `handle` unchanged, not under `base`.
   */
  proxies(url: string): boolean;
  /**
   * Whether an HTTP upgrade is Vite's HMR (or HMR ping) websocket. Glimpse's
   * upgrade handler destroys sockets that aren't for /__glimpse/ws; it must
   * skip these instead, or HMR never connects.
   */
  isViteUpgrade(req: IncomingMessage): boolean;
  close(): Promise<void>;
}

/**
 * Serve a React + Vite project as the Glimpse preview, with the project's own
 * Vite (and its own vite.config, which Vite still loads and merges) plus the
 * Glimpse plugin that adds source locations to every host element.
 */
export async function createReactPreview(opts: ReactPreviewOptions): Promise<ReactPreview> {
  const dir = resolve(opts.dir);
  const base = normalizeBase(opts.base ?? "/preview/");
  const vite = await loadVite(dir);
  const viteVersion = String(vite.version ?? "");
  // Vite 8 moved the HMR websocket options from server.hmr to server.ws (the old key still works, with a warning).
  const major = Number.parseInt(viteVersion, 10) || 0;
  const ws = major >= 8 ? { ws: { server: opts.httpServer } } : { hmr: { server: opts.httpServer } };
  // The websocket attaches to Glimpse's server, so the project's own HMR address settings (a clientPort for
  // Docker or Codespaces, a host, port or path) would send the client somewhere nobody listens. Vite merges
  // them into the inline config, and an undefined there doesn't override, so they are cleared once resolved.
  const hmrAddress: Plugin = {
    name: "glimpse:hmr-address",
    configResolved(resolved) {
      const server = resolved.server as { ws?: unknown; hmr?: unknown };
      const options = major >= 8 ? server.ws : server.hmr;
      if (!options || typeof options !== "object") return;
      for (const key of ["protocol", "host", "port", "clientPort", "path"]) delete (options as Record<string, unknown>)[key];
    },
  };

  let config: InlineConfig = {
    root: dir,
    base,
    appType: "spa",
    server: { middlewareMode: true, ...ws },
    // Paths relative to the project, as Edit source resolves them.
    plugins: [glimpseVitePlugin({ root: dir }), hmrAddress],
    clearScreen: false,
    logLevel: "warn",
  };
  if (opts.config) config = vite.mergeConfig(config, opts.config) as InlineConfig;
  const server = await vite.createServer(config);
  // Matched like Vite's proxy middleware: a key starting with ^ is a regular expression, any other a prefix.
  const proxyRules = Object.keys(server.config.server.proxy ?? {}).map((context) => {
    if (!context.startsWith("^")) return (url: string) => url.startsWith(context);
    try {
      const re = new RegExp(context);
      return (url: string) => re.test(url);
    } catch {
      return () => false;
    }
  });

  const fallback = (res: ServerResponse) => (err?: unknown) => {
    if (res.headersSent) return void res.end();
    res.writeHead(err ? 500 : 404, { "content-type": "text/plain; charset=utf-8" });
    res.end(err ? String(err instanceof Error ? err.message : err) : "Not found");
  };

  return {
    base,
    viteVersion,
    vite: server,
    handle(req, res, next) {
      const url = req.url ?? "/";
      const pathname = url.replace(/[?#].*$/, "");
      // "/preview" → "/preview/": Vite only answers under its base.
      if (pathname === base.slice(0, -1)) {
        res.writeHead(302, { location: base + url.slice(pathname.length) });
        res.end();
        return;
      }
      server.middlewares(req, res, next ?? fallback(res));
    },
    proxies: (url) => proxyRules.some((match) => match(url)),
    isViteUpgrade(req) {
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
      if (!protocols.includes("vite-hmr") && !protocols.includes("vite-ping")) return false;
      const pathname = (req.url ?? "/").replace(/[?#].*$/, "");
      return pathname.startsWith(base);
    },
    close: () => server.close(),
  };
}

/**
 * Absolute path of the ESM entry of the project's own Vite. Throws VITE_NOT_FOUND.
 *
 * Resolved like `createRequire(<dir>/package.json).resolve("vite")`, but only
 * through the node_modules folders of `dir` and its parents: Node's global
 * folders and NODE_PATH (which pnpm's bin shims set) could otherwise hand us
 * some other Vite than the project's.
 */
export function resolveVite(dir: string): string {
  const root = resolve(dir);
  const pkgPath = findInstalledPackage(root, "vite");
  if (!pkgPath) throw viteNotFound(root);
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: unknown; module?: string; main?: string };
    const exp = pkg.exports && typeof pkg.exports === "object" && "." in pkg.exports ? (pkg.exports as Record<string, unknown>)["."] : pkg.exports;
    // Prefer the ESM build: older Vite maps `require` to a deprecated CJS wrapper.
    const esm = importTarget(exp) ?? pkg.module;
    if (esm) return join(dirname(pkgPath), esm);
    // No export map: let Node pick the entry, from the package itself.
    return createRequire(pkgPath).resolve(dirname(pkgPath));
  } catch (err) {
    throw viteNotFound(root, err);
  }
}

/** `node_modules/<name>/package.json` in `dir` or the closest parent that has one. */
function findInstalledPackage(dir: string, name: string): string | undefined {
  for (let d = dir; ; ) {
    if (basename(d) !== "node_modules") {
      const pkg = join(d, "node_modules", name, "package.json");
      if (existsSync(pkg)) return pkg;
    }
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

async function loadVite(dir: string): Promise<ViteModule> {
  const entry = resolveVite(dir);
  try {
    const mod = (await import(pathToFileURL(entry).href)) as ViteModule & { default?: ViteModule };
    const vite = typeof mod.createServer === "function" ? mod : mod.default;
    if (!vite || typeof vite.createServer !== "function") throw new Error(`${entry} has no createServer`);
    return vite;
  } catch (err) {
    throw viteNotFound(dir, err);
  }
}

function viteNotFound(dir: string, cause?: unknown): ReactPreviewError {
  return new ReactPreviewError(
    "VITE_NOT_FOUND",
    `This React project doesn't use Vite or its dependencies aren't installed: run npm install in ${dir}`,
    cause === undefined ? undefined : { cause },
  );
}

/** The "import" (else "default") target of an export map entry. */
function importTarget(exp: unknown): string | undefined {
  if (typeof exp === "string") return exp;
  if (Array.isArray(exp)) {
    for (const e of exp) {
      const t = importTarget(e);
      if (t) return t;
    }
    return undefined;
  }
  if (exp && typeof exp === "object") {
    const e = exp as Record<string, unknown>;
    return importTarget(e.import) ?? importTarget(e.node) ?? importTarget(e.default);
  }
  return undefined;
}

function normalizeBase(base: string): string {
  let b = base.trim();
  if (!b.startsWith("/")) b = `/${b}`;
  if (!b.endsWith("/")) b = `${b}/`;
  return b;
}
