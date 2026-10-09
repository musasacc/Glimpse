import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, posix, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { watch, type FSWatcher } from "chokidar";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { changeListToPrompt, SCENE_AUTHORING_GUIDE, type ChangeList, type Scene, type Target } from "@glimpse/core";
import { createReactPreview, isJsxChange, mergePatchPlans, planJsxPatch, ReactPreviewError, resolveVite, type ReactPreview } from "@glimpse/react";
import { AgentRunner } from "./agent-runner.js";
import { AGENT_ENGINES, saveAgentSettings, type AgentEngine, type AgentSettingsPatch } from "./agent-settings.js";
import { detectProject, SCENE_FILE, type ProjectInfo } from "./detect.js";
import {
  decodePngDataUrl,
  History,
  isIgnored,
  lexists,
  MAX_FILE_BYTES,
  publicSnapshot,
  writablePath,
  type PublicSnapshot,
  type SnapshotKind,
} from "./history.js";
import { decodeHtml, htmlCharset } from "./charset.js";
import { CLIENT_SCRIPT, injectClient } from "./inject.js";
import { instrumentHtml } from "./instrument.js";
import { planPatch, type FilePatch } from "./patch-html.js";
import { applyScenePatch, planScenePatch, readScene, SceneConflictError, sceneChangesPrompt, sceneVersion, type SceneRead } from "./scene.js";
import { bridgeTerminal, handleTerminalMessage, ptyAvailable, TerminalSession, terminalSnapshot, type TerminalStartInfo } from "./terminal.js";
import { parseVariantPath, VARIANT_COUNTS, Variants, variantsPrompt, type VariantJob } from "./variants.js";

/**
 * - `ai`: the human's edits, for the agent to apply ("Send to AI")
 * - `source`: edits Glimpse already wrote into the files ("Edit source"), for the agent's information
 * - `request`: a free-form build request typed on the home screen
 * - `variants`: "show me N versions of this element"; the agent writes them into .glimpse/variants/
 */
export type HandoffKind = "ai" | "source" | "request" | "variants";

export interface Handoff {
  seq: number;
  kind: HandoffKind;
  createdAt: string;
  changeList: ChangeList;
  /** Plain-language version for the agent. */
  prompt: string;
  /** For `request` handoffs: what the human typed. */
  request?: { text: string; target?: Target };
  /** For `variants` handoffs: the job the agent should write variants for. */
  variants?: { id: string; src?: string; label: string; count: number; hint?: string };
  /** Project-relative path of a PNG of the human's edited version (`.glimpse/handoffs/<seq>.png`). */
  screenshot?: string;
  /** Whether an agent has already received it. */
  delivered: boolean;
  /** Withdrawn before any agent received it (its variants job was chosen or discarded). */
  cancelled?: boolean;
}

export interface HandoffSummary {
  seq: number;
  kind: HandoffKind;
  createdAt: string;
  title: string;
  count: number;
  delivered: boolean;
  cancelled?: boolean;
  /** A screenshot of the human's edited version went with it (`GET /api/handoffs/<seq>/screenshot`). */
  screenshot?: boolean;
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  target?: Target;
  entry?: string;
  /** Directory with the built editor (index.html + assets). */
  editorDir?: string;
  /**
   * Shell command that runs the real app, e.g. "python app.py" (`glimpse open --run`, MCP glimpse_open).
   * Started right away in Glimpse's terminal, and used instead of meta.command from the scene file.
   */
  command?: string;
}

export interface GlimpseServer {
  url: string;
  port: number;
  /** What Glimpse shows. Updated in place when the agent turns the folder into another kind of project. */
  project: ProjectInfo;
  server: Server;
  /**
   * Secret for local tools (CLI, MCP, desktop app), sent as the x-glimpse-token header on privileged
   * requests such as POST /api/terminal/run. Whoever starts the server writes it into .glimpse/server.json;
   * it never goes to the browser.
   */
  token: string;
  /** The real app, run in Glimpse's terminal next to its mock (terminal UIs and native GUIs). */
  terminal: TerminalSession;
  /** Run `command` in the terminal (stopping what runs there) and use it for restarts from now on. */
  run(command: string): Promise<TerminalStartInfo | null>;
  /** Post a status line to the editor's activity feed. */
  status(message: string): void;
  /**
   * Resolve with the next handoff for the agent, or null on timeout.
   * With `afterSeq`, the first handoff newer than it; without, the oldest one
   * no agent has received yet (so requests sent while no agent listened are queued).
   */
  nextHandoff(afterSeq: number | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Handoff | null>;
  /**
   * Count a handoff that was handed out as not delivered again, because it never reached the agent
   * (e.g. its tool call was cancelled). False when there is no such delivered handoff.
   */
  requeueHandoff(seq: number): boolean;
  /** Broadcast a full reload of the preview. */
  reload(): void;
  /** Save a version of the project's files now (a "manual" snapshot), unless nothing changed since the latest one. */
  snapshot(label?: string): Promise<PublicSnapshot>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".bmp": "image/bmp",
  ".apng": "image/apng",
  ".vtt": "text/vtt; charset=utf-8",
};

/** Saves in the project are recorded as (part of) an AI round once they have been quiet this long, */
const AI_ROUND_QUIET_MS = 1500;
/** or once they have kept coming this long (say, a log file the app writes every second). */
const AI_ROUND_MAX_WAIT_MS = 10_000;
/** Request bodies can carry PNG data URLs (thumbnails, screenshots). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Where the agent writes variants, relative to the project (forward slashes). */
const VARIANTS_DIR = ".glimpse/variants";
/** URL paths inside a .glimpse folder (any case, and Windows' ignored trailing dots and spaces). */
const STATE_PATH = /(^|[/\\])\.glimpse[. ]*([/\\]|$)/i;
const DEFAULT_MANUAL_LABEL = "Saved by hand";
/** Backups of files Glimpse overwrote kept in .glimpse/backups (the version history has them too); older ones are removed. */
const KEEP_BACKUPS = 50;
const TARGETS: readonly unknown[] = ["html", "react", "tui", "native"] satisfies Target[];
/** After the React preview failed to start (usually: dependencies not installed yet), try again at most this often. */
const PREVIEW_RETRY_MS = 2000;
/** A terminal UI restarts once its code has been quiet this long. */
const TERMINAL_RESTART_MS = 800;
/** Saves of these restart a running terminal UI (not data or logs the app writes itself, which would loop). */
const CODE_FILE = /\.(py|pyw|tcss|css|[cm]?[jt]sx?|rs|go|rb|java|kts?|cs|fs|swift|c|cc|cpp|cxx|h|hpp|m|mm|lua|php|pl|sh|ex|exs|hs|ml|nim|zig|dart|scala|clj|toml)$/i;
/** Files whose changes can turn the folder into another kind of project, or make its React preview work. */
/** A Vite config file at the project root. */
const VITE_CONFIG = /^vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/;
const PROJECT_FILES = new Set(["package.json", SCENE_FILE, "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const NOTHING_TO_RUN = 'Nothing to run yet: set meta.command in glimpse.scene.json (e.g. "python app.py"), or start Glimpse with --run "<command>".';

/** An error that answers the request with `status` instead of 500. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(opts: ServerOptions): Promise<GlimpseServer> {
  const dir = resolve(opts.dir);
  const project = detectProject(dir, { target: opts.target, entry: opts.entry });
  const stateDir = join(dir, ".glimpse");
  await mkdir(join(stateDir, "handoffs"), { recursive: true });

  const waiters = new Set<{ after: number | undefined; resolve: (h: Handoff | null) => void }>();
  const sockets = new Set<WebSocket>();
  /** The live client in previewed pages (the page, compare and variant frames): it only acts on file changes. */
  const previewSockets = new Set<WebSocket>();
  const token = randomBytes(32).toString("base64url");
  /** Set once listening (the port may be picked by the OS). */
  let port = 0;
  let closing = false;

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
    if ((msg as { type?: unknown }).type === "file-changed") for (const ws of previewSockets) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const history = new History(dir, {
    onSnapshot: (s, change) => broadcast({ type: change === "created" ? "snapshot" : "snapshot-updated", snapshot: publicSnapshot(s) }),
    onPruned: (ids) => broadcast({ type: "snapshots-pruned", ids }),
  });
  const variants = new Variants(dir);
  await history.load();
  await variants.load();
  // Anything from a previous run counts as delivered so it isn't replayed, except a variants
  // request no agent got yet whose job is still open: the editor still shows it as waiting.
  const loaded = await loadHandoffs(
    join(stateDir, "handoffs"),
    (h) => h.kind === "variants" && !h.cancelled && !!h.variants && !!variants.get(h.variants.id),
  );
  const handoffs: Handoff[] = loaded.handoffs;
  /** The highest seq on disk, readable or not: a new handoff never takes the number (and files) of an unreadable one. */
  const seqFloor = loaded.lastSeq;
  /** Variants jobs being chosen or discarded right now. */
  const busyJobs = new Set<string>();
  /** The built-in agent: runs requests itself when no external agent is listening. */
  const runner = new AgentRunner({
    dir,
    broadcast: (msg) => broadcast(msg),
    externalWaiting: () => externalWaiting(),
    handoff: (seq) => handoffs.find((h) => h.seq === seq),
    claim: (h) => markDelivered(h),
    roundEnd: () => endAiRound(),
    prompt: (h) => builtInPrompt(h),
    screenshot: (h) => (h.screenshot ? join(stateDir, "handoffs", `${h.seq}.png`) : undefined),
  });
  const host = opts.host ?? "127.0.0.1";

  const isScene = () => project.target === "tui" || project.target === "native";
  /** The entry as watcher paths spell it: project-relative, forward slashes. */
  const entryRel = () => cleanRel(project.entry) ?? project.entry.split("\\").join("/");

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code =
        err instanceof HttpError || err instanceof SceneConflictError ? err.status
        : err instanceof SyntaxError || err instanceof URIError ? 400
        : 500;
      send(res, code, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  /* ── Who may talk to this server ──────────────────────────────────────
   * Glimpse runs commands, writes files and types into the real app, so other websites must not reach it:
   * - the Host header must name this machine (DNS rebinding: evil.example resolving to 127.0.0.1),
   * - browsers' cross-origin POST/PUT/DELETE requests, /api/ calls and websockets are refused (CSRF, cross-site websockets),
   * - POST /api/terminal/run also needs the token from .glimpse/server.json.
   * Tools without an Origin header (CLI, MCP, curl) are local processes and are let through. */

  /** GLIMPSE_DEV_ORIGIN: the editor's Vite dev server (`pnpm dev`, e.g. http://localhost:5173), which proxies to Glimpse. */
  const devOrigin = process.env.GLIMPSE_DEV_ORIGIN?.trim().replace(/\/+$/, "") || undefined;
  const devHost = devOrigin && URL.canParse(devOrigin) ? new URL(devOrigin).hostname : undefined;

  /** Host names a browser may use for this server; `hostName` as URL.hostname spells it (IPv6 in brackets). */
  function localName(hostName: string): boolean {
    const h = hostName.toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]") return true;
    if (h === bracketed(host.toLowerCase())) return true;
    if (host !== "0.0.0.0" && host !== "::") return false;
    // Listening on every interface: this machine's own addresses and name.
    const own = hostname().toLowerCase();
    if (h === own || h === `${own}.local`) return true;
    return Object.values(networkInterfaces()).some((list) => list?.some((a) => h === bracketed(a.address.toLowerCase())));
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const value = req.headers.host;
    if (!value) return true; // not a browser
    let name: string;
    try {
      name = new URL(`http://${value}`).hostname;
    } catch {
      return false;
    }
    // DNS rebinding needs a domain name; an IP address can only be one the browser really connected to.
    if (isIP(name.replace(/^\[|\]$/g, "")) || localName(name)) return true;
    return devHost !== undefined && devHost === name;
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // not a browser
    if (devOrigin !== undefined && origin === devOrigin) return true;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false; // includes "null" (sandboxed frames, file:// pages)
    }
    return u.protocol === "http:" && (u.port || "80") === String(port) && localName(u.hostname);
  }

  /** Browsers mark every request with Sec-Fetch-Site: only Glimpse's own pages (or a typed URL) may use the API. */
  function sameSite(req: IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site === undefined || site === "same-origin" || site === "none") return true;
    return devOrigin !== undefined && req.headers.origin === devOrigin;
  }

  function tokenOk(req: IncomingMessage): boolean {
    const got = req.headers["x-glimpse-token"];
    if (typeof got !== "string") return false;
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /* ── React (Vite) preview ─────────────────────────────────────────────
   * The project's own Vite serves /preview/ in middleware mode, its HMR websocket on this server.
   * Created at startup for a React project, or on first use once the folder becomes one. */
  let reactPreview: ReactPreview | null = null;
  let reactPreviewLoad: Promise<ReactPreview | null> | undefined;
  /** Why the React preview can't run (for the human: "run npm install …"); null when it's fine. */
  let previewError: string | null = null;
  let previewFailedAt = 0;

  function ensureReactPreview(): Promise<ReactPreview | null> {
    if (project.target !== "react" || closing) return Promise.resolve(null);
    if (reactPreview) return Promise.resolve(reactPreview);
    if (!reactPreviewLoad && Date.now() - previewFailedAt >= PREVIEW_RETRY_MS) {
      const load = createReactPreview({ dir, httpServer: server }).then(
        async (p) => {
          // Closed (or no longer React) while Vite was starting.
          if (closing || project.target !== "react") {
            await p.close().catch(() => undefined);
            if (reactPreviewLoad === load) reactPreviewLoad = undefined;
            return null;
          }
          reactPreview = p;
          previewError = null;
          return p;
        },
        (err: unknown) => {
          if (reactPreviewLoad === load) reactPreviewLoad = undefined;
          previewFailedAt = Date.now();
          previewError =
            err instanceof ReactPreviewError ? err.message : `Vite couldn't start the preview: ${err instanceof Error ? err.message : String(err)}`;
          return null;
        },
      );
      reactPreviewLoad = load;
    }
    return reactPreviewLoad ?? Promise.resolve(null);
  }

  async function closeReactPreview(): Promise<void> {
    const p = reactPreview ?? (await reactPreviewLoad?.catch(() => null));
    reactPreview = null;
    reactPreviewLoad = undefined;
    previewFailedAt = 0;
    previewError = null;
    await p?.close().catch(() => undefined);
  }

  /** Whether there is something to show: the entry file, and for React also an installed Vite. */
  async function entryExists(): Promise<boolean> {
    if (!(await isFile(join(dir, project.entry)))) return false;
    if (project.target !== "react") return true;
    try {
      resolveVite(dir);
      return true;
    } catch {
      return false;
    }
  }

  /** What the editor needs to know about the project (GET /api/session, the websocket's hello and "project" messages). */
  async function projectState(): Promise<{ project: ProjectInfo; entryExists: boolean; previewError: string | null }> {
    if (project.target === "react") await ensureReactPreview();
    return { project, entryExists: await entryExists(), previewError: project.target === "react" ? previewError : null };
  }

  /**
   * Detect the project again after package.json, the scene file or a lockfile changed: an empty folder the agent
   * turns into a Vite React app or a terminal UI switches over, and a React preview that lacked its dependencies
   * starts once they are installed. Tells the editor when anything changed.
   */
  let lastProjectState = "";
  let refreshQueue: Promise<unknown> = Promise.resolve();
  function refreshProject(): void {
    refreshQueue = refreshQueue
      .then(async () => {
        if (closing) return;
        const next = detectProject(dir, { target: opts.target, entry: opts.entry }, project);
        const wasReact = project.target === "react";
        if (next.target !== project.target || next.entry !== project.entry) {
          Object.assign(project, next);
          if (wasReact && project.target !== "react") await closeReactPreview();
        }
        previewFailedAt = 0; // try a failed preview again right away
        const state = await projectState();
        const json = JSON.stringify(state);
        if (json !== lastProjectState) {
          lastProjectState = json;
          broadcast({ type: "project", ...state });
        }
      })
      .catch((err: unknown) => console.warn(`glimpse: couldn't detect the project again (${err instanceof Error ? err.message : String(err)})`));
  }

  /**
   * A vite.config appeared (or changed) at the project root. Vite restarts itself only for the config file it
   * loaded at startup, so a preview started without one (before the agent wrote it) or one that failed (a broken
   * config) starts over, and the editor reloads it.
   */
  function viteConfigChanged(): void {
    refreshQueue = refreshQueue
      .then(async () => {
        if (closing || project.target !== "react") return;
        const running = reactPreview ?? (await reactPreviewLoad?.catch(() => null)) ?? null;
        if (running?.vite.config.configFile) return; // Vite restarts on its own
        await closeReactPreview();
        if ((await ensureReactPreview()) || running) broadcast({ type: "reload" });
      })
      .catch((err: unknown) => console.warn(`glimpse: couldn't restart the preview (${err instanceof Error ? err.message : String(err)})`));
    refreshProject();
  }

  /* ── Scene (terminal UIs and native GUIs) ─────────────────────────── */

  const scenePayload = (r: SceneRead | null) =>
    r
      ? { exists: true, file: r.file, scene: r.scene, errors: r.errors, format: r.format, extras: r.extras, version: r.version, ...(r.invalid && { invalid: r.invalid }) }
      : { exists: false, file: entryRel() };

  // Scene file events are read one at a time, so the editor gets them in order.
  let sceneQueue: Promise<unknown> = Promise.resolve();
  function sceneChanged(deleted: boolean): void {
    sceneQueue = sceneQueue
      .then(async () => broadcast({ type: "scene", ...scenePayload(deleted ? null : await readScene(dir, project.entry)) }))
      .catch((err: unknown) => console.warn(`glimpse: couldn't read ${entryRel()} (${err instanceof Error ? err.message : String(err)})`));
  }

  /* ── Terminal: the real app next to its mock ──────────────────────────
   * The command comes from --run / the MCP (`runCommand`) or the scene file's meta.command, never from the browser.
   * meta.command only runs when the human presses Run in the editor (a cloned repo mustn't run code on open). */
  const terminal = new TerminalSession();
  const unbridge = bridgeTerminal(terminal, broadcast);
  let runCommand = opts.command?.trim() || undefined;
  /** Restart a terminal UI when its code changes (the editor can turn it off). */
  let autoRestart = true;
  /** The human pressed Stop: code changes don't start it again. */
  let userStopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  async function commandToRun(): Promise<{ command: string | undefined; read: SceneRead | null }> {
    const read = isScene() ? await readScene(dir, project.entry).catch(() => null) : null;
    const meta = read?.extras.meta?.command;
    return { command: runCommand ?? (typeof meta === "string" && meta.trim() ? meta.trim() : undefined), read };
  }

  /** Start (or restart) the app. Resolves null when there is no command, or a newer start superseded this one. */
  async function startTerminal(): Promise<TerminalStartInfo | null> {
    const { command, read } = await commandToRun();
    if (!command || closing) return null;
    userStopped = false;
    clearTimeout(restartTimer);
    // A terminal UI first runs at the mock's size; after that, at the size the editor's terminal has.
    const root = read && !read.invalid && project.target === "tui" ? read.scene.nodes[read.scene.rootId]?.layout : undefined;
    const size = terminal.command !== undefined ? { cols: terminal.cols, rows: terminal.rows } : { cols: root?.w ?? 80, rows: root?.h ?? 24 };
    return terminal.start({ command, cwd: dir, ...size });
  }

  async function run(command: string): Promise<TerminalStartInfo | null> {
    const c = command.trim();
    if (!c) throw new Error("Expected a command to run");
    runCommand = c;
    return startTerminal();
  }

  const terminalState = () => ({
    command: terminal.command ?? null,
    running: terminal.running,
    mode: terminal.mode,
    fallbackReason: terminal.fallbackReason ?? null,
    autoRestart,
  });

  function scheduleTerminalRestart(): void {
    if (project.target !== "tui" || !autoRestart || userStopped || terminal.command === undefined || closing) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (closing || userStopped || !autoRestart) return;
      startTerminal().catch((err: unknown) => broadcast({ type: "term-error", message: err instanceof Error ? err.message : String(err) }));
    }, TERMINAL_RESTART_MS);
  }

  /** Each editor's terminal pane size. The app gets the size of the editor the human typed in or focused last. */
  const termSizes = new Map<WebSocket, { cols: number; rows: number }>();
  let termOwner: WebSocket | undefined;

  function claimTerminal(ws: WebSocket, force = false): void {
    if (termOwner === ws && !force) return;
    const size = termSizes.get(ws);
    if (!size) return;
    termOwner = ws;
    if (size.cols !== terminal.cols || size.rows !== terminal.rows) terminal.resize(size.cols, size.rows);
  }

  /** An editor went away: the size falls to another one still open. */
  function releaseTerminal(ws: WebSocket): void {
    termSizes.delete(ws);
    if (termOwner !== ws) return;
    termOwner = undefined;
    const next = [...termSizes.keys()].at(-1);
    if (next) claimTerminal(next);
  }

  /** A message from the editor's websocket. Only terminal controls; the command itself never comes from the browser. */
  async function onClientMessage(ws: WebSocket, raw: RawData): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const reply = (m: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const m = (typeof msg === "object" && msg !== null ? msg : {}) as { type?: unknown; enabled?: unknown; cols?: unknown; rows?: unknown; focus?: unknown };
    try {
      switch (m.type) {
        case "term-resize": {
          if (!Number.isInteger(m.cols) || !Number.isInteger(m.rows)) return;
          termSizes.set(ws, { cols: m.cols as number, rows: m.rows as number });
          // Only the editor in use sizes the app; the others would resize it back and forth.
          if (termOwner === undefined || termOwner === ws || !termSizes.has(termOwner) || m.focus === true) claimTerminal(ws, true);
          return;
        }
        case "term-input":
          claimTerminal(ws);
          await handleTerminalMessage(terminal, msg, reply);
          return;
        case "term-restart": {
          claimTerminal(ws);
          // Starts the current command again, picking up an edited meta.command.
          if (!(await commandToRun()).command) return reply({ type: "term-error", message: NOTHING_TO_RUN });
          await startTerminal();
          return;
        }
        case "term-stop":
          userStopped = true;
          clearTimeout(restartTimer);
          await handleTerminalMessage(terminal, msg, reply);
          return;
        case "term-auto-restart":
          autoRestart = m.enabled !== false;
          if (!autoRestart) clearTimeout(restartTimer);
          broadcast({ type: "term-auto-restart", enabled: autoRestart });
          return;
        default:
          await handleTerminalMessage(terminal, msg, reply);
      }
    } catch (err) {
      reply({ type: "term-error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) {
      send(res, 403, { error: `Host not allowed: ${req.headers.host}. Open Glimpse at http://127.0.0.1:${port}/` });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    // The React app's own backend calls (fetch("/api/items")), sent on by its vite.config server.proxy as `vite`
    // would: they are the app's, never Glimpse's, whichever path they use.
    if (project.target === "react" && reactPreview?.proxies(req.url ?? "/") && previewFrom(req)?.kind === "preview") {
      return reactPreview.handle(req, res);
    }
    // State-changing requests, and every API call (GET /api/handoff/next hands a message out), only from Glimpse's own pages.
    const method = req.method ?? "GET";
    const api = url.pathname.startsWith("/api/");
    const guarded = (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") || api;
    if (guarded && (!originAllowed(req) || !sameSite(req))) {
      send(res, 403, { error: `Cross-origin request refused (Origin: ${req.headers.origin ?? "none"})` });
      return;
    }
    // The previewed app (and versions and variants of it) runs at this origin and never needs Glimpse's API, so its
    // own requests don't get it: a GET of an /api/ path is the app's (served from the project like any root-absolute
    // URL), anything else is refused. A page can still reach the API through the editor (window.parent shares the
    // origin): open projects you trust, as you would before running their dev server.
    const projectPage = guarded && fromProjectPage(req);
    if (projectPage && method !== "GET" && method !== "HEAD") {
      send(res, 403, { error: "The previewed page can't change Glimpse's state" });
      return;
    }
    // API bodies are JSON, which no other site can send without a preflight (and this server answers none).
    if (api && method !== "GET" && method !== "HEAD" && !/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
      send(res, 415, { error: "Expected a JSON body (content-type: application/json)" });
      return;
    }
    const path = decodeURIComponent(url.pathname);
    // Glimpse's own state (.glimpse/server.json holds the token) is never served, whichever route or engine
    // (static preview, the project's Vite, variants, root-absolute fallback) would otherwise read it: the
    // previewed app runs at this origin and must not get hold of it.
    if (STATE_PATH.test(path)) return send(res, 404, { error: "Not found" });
    // Neither are the project's dotfiles (.git/config, .env and .npmrc hold secrets). Vite applies its own fs.deny to /@fs/.
    if ((!api || projectPage) && !/^\/(preview\/)?@fs\//.test(path) && hiddenPath(path)) return send(res, 404, { error: "Not found" });
    if (projectPage) return serveFromProject(req, res, path);

    if (path === "/__glimpse/client.js") {
      res.writeHead(200, { "content-type": MIME[".js"]!, "cache-control": "no-store" });
      res.end(CLIENT_SCRIPT);
      return;
    }

    if (path === "/api/session" && req.method === "GET") {
      send(res, 200, {
        ...(await projectState()),
        agentWaiting: waiters.size > 0,
        agentInfo: await runner.info(),
        agentRun: runner.state(),
        lastSeq: handoffs.at(-1)?.seq ?? 0,
      });
      return;
    }

    if (path === "/api/agent" && req.method === "GET") {
      send(res, 200, await runner.info());
      return;
    }

    if (path === "/api/agent/settings" && req.method === "POST") {
      const body = (await readJson(req)) as { engine?: unknown; anthropicApiKey?: unknown } | null;
      const engine = body?.engine;
      const key = body?.anthropicApiKey;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (engine !== undefined && !(AGENT_ENGINES as readonly unknown[]).includes(engine)) ||
        (key !== undefined && key !== null && (typeof key !== "string" || !/^\S{1,400}$/.test(key.trim())))
      ) {
        send(res, 400, { error: `Expected { engine?: ${AGENT_ENGINES.join(" | ")}, anthropicApiKey?: string | null }` });
        return;
      }
      const patch: AgentSettingsPatch = {};
      if (engine !== undefined) patch.engine = engine as AgentEngine;
      if (key !== undefined) patch.anthropicApiKey = key === null ? null : (key as string).trim();
      await saveAgentSettings(patch);
      runner.refresh();
      const info = await runner.info();
      broadcast({ type: "agent-info", info });
      // Requests that waited because nothing could run them (no engine chosen, no key yet) start now.
      await runner.enqueue(pendingHandoffs());
      send(res, 200, info);
      return;
    }

    if (path === "/api/agent/stop" && req.method === "POST") {
      runner.stop();
      send(res, 200, { ok: true });
      return;
    }

    if (path === "/api/scene" && req.method === "GET") {
      if (!isScene()) return send(res, 404, { error: `Not a scene project (target ${project.target})` });
      send(res, 200, scenePayload(await readScene(dir, project.entry)));
      return;
    }

    if (path === "/api/terminal" && req.method === "GET") {
      send(res, 200, terminalState());
      return;
    }

    if (path === "/api/terminal/run" && req.method === "POST") {
      // Only local tools: a browser page (even Glimpse's own origin, where the previewed app runs) always sends Origin.
      if (req.headers.origin !== undefined) return send(res, 403, { error: "Commands can't be started from a browser" });
      if (!tokenOk(req)) return send(res, 403, { error: "Missing or wrong x-glimpse-token (it is in .glimpse/server.json)" });
      const body = (await readJson(req)) as { command?: unknown };
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command) return send(res, 400, { error: "Expected { command }" });
      const info = await run(command);
      send(res, 200, { ok: true, started: info, terminal: terminalState() });
      return;
    }

    if (path === "/api/handoffs" && req.method === "GET") {
      send(res, 200, { handoffs: handoffs.map(summarize).reverse() });
      return;
    }

    const seqMatch = path.match(/^\/api\/handoffs\/(\d+)(\/screenshot)?$/);
    if (seqMatch && req.method === "GET") {
      const h = handoffs.find((x) => x.seq === Number(seqMatch[1]));
      if (!h) return send(res, 404, { error: "No such handoff" });
      if (!seqMatch[2]) return send(res, 200, h);
      const png = h.screenshot ? await readFile(join(stateDir, "handoffs", `${h.seq}.png`)).catch(() => null) : null;
      if (!png) return send(res, 404, { error: "That handoff has no screenshot" });
      res.writeHead(200, { "content-type": MIME[".png"]!, "cache-control": "no-store" });
      res.end(png);
      return;
    }

    if (path === "/api/handoff" && req.method === "POST") {
      const body = (await readJson(req)) as { kind?: HandoffKind; changeList?: ChangeList; screenshot?: unknown; scene?: unknown; sceneVersion?: unknown };
      if (!isChangeList(body.changeList) || (body.kind !== "ai" && body.kind !== "source")) {
        send(res, 400, { error: "Expected { kind: 'ai' | 'source', changeList, screenshot?, scene?, sceneVersion? }" });
        return;
      }
      // The picture is a nicety: one Glimpse can't take (not a PNG, over 5 MB) is left out, never the edits.
      const screenshot = body.screenshot == null ? undefined : (decodePngDataUrl(body.screenshot) ?? undefined);
      const warning = body.screenshot != null && !screenshot ? "The screenshot wasn't a PNG of at most 5 MB, so it was left out." : undefined;
      let changeList = body.changeList;
      let prompt: string;
      let scene: { version: string | null; backup?: string } | undefined;
      if (body.kind === "ai" && isScene()) {
        // Glimpse writes the edited mock into the scene file itself; the AI updates the real code.
        let sceneWritten = false;
        if (body.scene !== undefined) {
          const edited = sceneFromBody(body.scene);
          const n = changeList.changes.length;
          // In the history's turn, so the AI's pending saves are recorded as theirs first and this write isn't one.
          const { result } = await history.guardedWrite(null, { kind: "handoff", label: `Sent ${n} change${n === 1 ? "" : "s"} to the AI` }, async () => {
            const plan = await planScenePatch(dir, project.entry, edited, changeList.changes, {
              expectedVersion: typeof body.sceneVersion === "string" ? body.sceneVersion : undefined,
            });
            const backup = plan.files.length && plan.version !== null ? await backupFiles(plan.files) : undefined;
            await applyScenePatch(dir, plan);
            return { plan, backup };
          });
          const { plan, backup } = result;
          changeList = { ...changeList, changes: plan.needsAi };
          sceneWritten = true;
          scene = { version: plan.files[0] ? sceneVersion(plan.files[0].after) : plan.version, ...(backup && { backup }) };
        }
        const extras = (await readScene(dir, project.entry).catch(() => null))?.extras;
        prompt = sceneChangesPrompt(changeList, { file: entryRel(), extras, sceneWritten });
      } else {
        prompt = changeListToPrompt(changeList);
      }
      const h = await addHandoff({ kind: body.kind, changeList, prompt }, { screenshot });
      if (h.kind === "ai") {
        const n = h.changeList.changes.length;
        await takeSnapshot("handoff", `Sent ${n} change${n === 1 ? "" : "s"} to the AI`);
      }
      send(res, 200, {
        seq: h.seq,
        delivered: h.delivered,
        ...(warning && { warning }),
        ...(scene && { sceneVersion: scene.version, ...(scene.backup && { backup: scene.backup }) }),
      });
      return;
    }

    if ((path === "/api/patch/preview" || path === "/api/patch/apply") && req.method === "POST") {
      const body = (await readJson(req)) as { changeList?: ChangeList; repeated?: unknown; scene?: unknown; sceneVersion?: unknown; planId?: unknown };
      if (!isChangeList(body.changeList)) {
        send(res, 400, { error: "Expected { changeList }" });
        return;
      }
      const previewOnly = path === "/api/patch/preview";
      if (isScene()) {
        await sceneEditSource(body.changeList, body.scene, body.sceneVersion, previewOnly, res);
        return;
      }
      // HTML pages through the HTML patcher, JSX components (React) through Babel. Source locations the page
      // renders more than once (list items, shared components) are `repeated`: those edits go to the AI.
      const changes = body.changeList.changes;
      const repeated = Array.isArray(body.repeated) ? body.repeated.filter((s): s is string => typeof s === "string") : [];
      const planAll = async () =>
        mergePatchPlans(
          changes,
          await planPatch(dir, changes.filter((c) => !isJsxChange(c))),
          await planJsxPatch(dir, changes.filter(isJsxChange), { repeated }),
        );
      if (previewOnly) {
        const plan = await planAll();
        send(res, 200, { files: plan.files.map(({ file, diff }) => ({ file, diff })), applied: plan.applied, needsAi: plan.needsAi, planId: planId(plan.files) });
        return;
      }
      const label = (plan?: { applied: unknown[] }) => {
        const n = plan?.applied.length ?? 0;
        return { kind: "source" as const, label: `Wrote ${n} change${n === 1 ? "" : "s"} to source` };
      };
      // In the history's turn, so the AI's pending saves are recorded as theirs first and these writes as Edit source's.
      const {
        result: { plan, backup },
        snapshot,
      } = await history.guardedWrite(
        null,
        (r?: { plan: { applied: unknown[] } }) => label(r?.plan),
        async () => {
          const plan = await planAll();
          // The files changed since the human reviewed the diff (the agent saved one): write nothing they haven't seen.
          if (typeof body.planId === "string" && body.planId !== planId(plan.files)) {
            throw new HttpError(409, "The files changed since you reviewed these edits. Open Edit source again to see the new diff.");
          }
          // Back up every file before writing it, so "Edit source" can always be undone by hand.
          const backup = await backupFiles(plan.files);
          for (const f of plan.files) await writeFile(join(dir, f.file), f.after);
          return { plan, backup };
        },
      );
      if (plan.applied.length > 0) {
        const changeList: ChangeList = { ...body.changeList, changes: plan.applied };
        // Recorded for the history (and so the agent can look it up), but it doesn't wake the agent: there's nothing to do.
        await addHandoff({ kind: "source", changeList, prompt: sourcePrompt(changeList, plan.files.map((f) => f.file)) }, { notify: false });
      }
      send(res, 200, {
        files: plan.files.map((f) => f.file),
        applied: plan.applied.length,
        needsAi: plan.needsAi,
        backup,
        snapshot: plan.files.length > 0 && snapshot ? publicSnapshot(snapshot) : undefined,
      });
      return;
    }

    if (path === "/api/request" && req.method === "POST") {
      const body = (await readJson(req)) as { text?: unknown; target?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || (body.target != null && !TARGETS.includes(body.target as Target))) {
        send(res, 400, { error: `Expected { text, target?: ${TARGETS.join(" | ")} }` });
        return;
      }
      const target = (body.target as Target | null | undefined) ?? project.target;
      const h = await addHandoff({
        kind: "request",
        changeList: { version: 1, target, createdAt: new Date().toISOString(), changes: [] },
        prompt: requestPrompt(text, target, project),
        request: { text, target },
      });
      await takeSnapshot("handoff", "Sent a request");
      send(res, 200, { seq: h.seq, delivered: h.delivered });
      return;
    }

    if (path === "/api/handoff/next" && req.method === "GET") {
      const afterParam = url.searchParams.get("after");
      const after = afterParam === null || afterParam === "" ? undefined : Number(afterParam);
      const timeoutSec = Number(url.searchParams.get("timeout") ?? 30);
      if ((after !== undefined && !Number.isInteger(after)) || !Number.isFinite(timeoutSec) || timeoutSec < 0) {
        send(res, 400, { error: "Expected ?timeout=<seconds>&after=<seq>, both numbers" });
        return;
      }
      const timeout = Math.min(timeoutSec, 600) * 1000;
      // If the agent disconnects mid-wait, stop waiting so nothing is delivered to a dead request.
      const cancel = new AbortController();
      res.on("close", () => cancel.abort());
      const got = await takeHandoff(after, timeout, cancel.signal);
      if (cancel.signal.aborted) {
        // The agent hung up just as something arrived: keep it for the agent's next wait.
        if (got?.fresh) requeueHandoff(got.handoff.seq);
        return;
      }
      // Likewise if the answer never makes it out.
      if (got?.fresh) res.once("close", () => void (res.writableFinished || requeueHandoff(got.handoff.seq)));
      send(res, 200, got ? { status: "ready", handoff: got.handoff } : { status: "editing" });
      return;
    }

    const requeueMatch = path.match(/^\/api\/handoffs\/(\d+)\/requeue$/);
    if (requeueMatch && req.method === "POST") {
      const ok = requeueHandoff(Number(requeueMatch[1]));
      send(res, ok ? 200 : 404, ok ? { ok } : { error: "No delivered handoff with that number" });
      return;
    }

    if (path === "/api/reload" && req.method === "POST") {
      broadcast({ type: "reload" });
      send(res, 200, { ok: true });
      return;
    }

    if (path === "/api/status" && req.method === "POST") {
      const body = (await readJson(req)) as { message?: string };
      status(String(body.message ?? ""));
      send(res, 200, { ok: true });
      return;
    }

    if (path === "/api/history" || path.startsWith("/api/history/")) {
      await handleHistory(path, req, res);
      return;
    }

    if (path === "/api/variants" || path.startsWith("/api/variants/")) {
      await handleVariants(path, req, res);
      return;
    }

    if (path.startsWith("/preview/") || path === "/preview") {
      if (project.target === "react") return serveReactPreview(req, res);
      const rel = path.slice("/preview".length).replace(/^\/+/, "");
      if (rel === "" && toEntry(req, res, url, "/preview/")) return;
      await servePreview(rel, res);
      return;
    }

    const snapMatch = /^\/snapshot\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (snapMatch && req.method === "GET") {
      if (!snapMatch[2] && project.target === "html" && toEntry(req, res, url, `/snapshot/${encodeURIComponent(snapMatch[1]!)}/`)) return;
      await serveSnapshot(snapMatch[1]!, snapMatch[2] ?? "", res);
      return;
    }

    const variantMatch = /^\/variant\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (variantMatch && req.method === "GET") {
      const [, id, k, rel] = variantMatch;
      if (!rel && project.target === "html" && toEntry(req, res, url, `/variant/${encodeURIComponent(id!)}/${encodeURIComponent(k!)}/`)) return;
      await serveVariant(id!, Number(k), rel ?? "", res);
      return;
    }

    // Root-absolute URLs in the previewed app (<img src="/logo.svg">, fetch("/data.json")) skip the /preview/
    // prefix and land here: serve them from the project, or from the version or variant that asked for them.
    const from = path === "/" ? null : previewFrom(req);
    if (from && (req.method === "GET" || req.method === "HEAD") && (from.kind !== "preview" || !isScene())) {
      return serveFromProject(req, res, path, from);
    }

    await serveEditor(path, res);
  }

  /**
   * A root-absolute URL of the previewed app, served from the project, or from the version or variant whose page
   * asked for it (`from`, by the Referer).
   */
  async function serveFromProject(req: IncomingMessage, res: ServerResponse, path: string, from = previewFrom(req)): Promise<void> {
    const rel = path.replace(/^\/+/, "");
    if (from?.kind === "snapshot") return serveSnapshot(from.id, rel, res);
    if (from?.kind === "variant") return serveVariant(from.id, from.k, rel, res);
    if (project.target === "react") {
      req.url = `/preview${req.url ?? "/"}`;
      return serveReactPreview(req, res);
    }
    if (isScene()) return send(res, 404, { error: "Not found" });
    return servePreview(rel, res);
  }

  /** The React app through the project's own Vite, or a page saying why it can't run. */
  async function serveReactPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const preview = await ensureReactPreview();
    if (preview) return preview.handle(req, res);
    res.writeHead(503, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Preview unavailable</title>
<body data-glimpse-internal style="background:#000;color:#fafafa;font:14px/1.5 system-ui;margin:0;padding:24px">
<p style="margin:0 0 8px;font-weight:600">The React preview can't start</p>
<p style="margin:0;color:#a1a1aa">${escapeHtml(previewError ?? "Vite didn't start.")}</p>`);
  }

  /**
   * Which previewed page a request comes from, by its Referer: the live preview (under /preview/), a version
   * (/snapshot/<id>/) or a variant (/variant/<id>/<k>/). Null for the editor's own requests.
   */
  function previewFrom(req: IncomingMessage): { kind: "preview" } | { kind: "snapshot"; id: string } | { kind: "variant"; id: string; k: number } | null {
    let ref: string;
    try {
      ref = decodeURIComponent(new URL(req.headers.referer ?? "").pathname);
    } catch {
      return null;
    }
    if (ref.startsWith("/preview/")) return { kind: "preview" };
    const snap = /^\/snapshot\/([^/]+)\//.exec(ref);
    if (snap && history.get(snap[1]!)) return { kind: "snapshot", id: snap[1]! };
    const variant = /^\/variant\/([^/]+)\/(\d+)\//.exec(ref);
    if (variant && variants.get(variant[1]!)) return { kind: "variant", id: variant[1]!, k: Number(variant[2]) };
    return null;
  }

  /**
   * A page at the root of the preview (or of a version or variant) whose entry is another file: send the frame
   * there instead, so the page's relative URLs resolve next to it (an entry in a subfolder) and the live client
   * knows which file it shows. False when the entry is the folder's index.html, served right here.
   */
  function toEntry(req: IncomingMessage, res: ServerResponse, url: URL, root: string): boolean {
    const entry = entryRel();
    if (project.target !== "html" || (entry === "index.html" && url.pathname.endsWith("/"))) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const page = entry === "index.html" ? "" : entry.split("/").map(encodeURIComponent).join("/");
    res.writeHead(302, { location: `${root}${page}${url.search}`, "cache-control": "no-store" });
    res.end();
    return true;
  }

  /** Whether a request comes from a page of the project: the live preview, or a version or variant of it. */
  function fromProjectPage(req: IncomingMessage): boolean {
    try {
      return /^\/(preview|snapshot|variant)(\/|$)/.test(new URL(req.headers.referer ?? "").pathname);
    } catch {
      return false;
    }
  }

  /**
   * Edit source for a terminal UI or native GUI: write the editor's edited scene into the scene file. The real
   * code still has to follow, so every change but editor-only ones comes back as `needsAi` (the editor sends those
   * with Send to AI); no "source" handoff is recorded, since there is something left to do.
   */
  async function sceneEditSource(list: ChangeList, sceneArg: unknown, versionArg: unknown, previewOnly: boolean, res: ServerResponse): Promise<void> {
    const plan = await planScenePatch(dir, project.entry, sceneFromBody(sceneArg), list.changes, {
      expectedVersion: typeof versionArg === "string" ? versionArg : undefined,
    });
    if (previewOnly) {
      send(res, 200, { files: plan.files.map(({ file, diff }) => ({ file, diff })), applied: plan.applied, needsAi: plan.needsAi, version: plan.version });
      return;
    }
    const n = plan.applied.length;
    // In the history's turn, so the AI's pending saves are recorded as theirs first and this write as Edit source's.
    const { result, snapshot } = await history.guardedWrite(
      null,
      { kind: "source", label: `Wrote ${n} change${n === 1 ? "" : "s"} to ${entryRel()}` },
      async () => {
        // A scene file that didn't exist yet has nothing to back up.
        const backup = plan.files.length && plan.version !== null ? await backupFiles(plan.files) : undefined;
        return { backup, files: await applyScenePatch(dir, plan) };
      },
    );
    const { backup, files } = result;
    send(res, 200, {
      files,
      applied: n,
      needsAi: plan.needsAi,
      backup,
      snapshot: files.length > 0 && snapshot ? publicSnapshot(snapshot) : undefined,
      version: plan.files[0] ? sceneVersion(plan.files[0].after) : plan.version,
    });
  }

  /** Copy files into .glimpse/backups/<time>/ before Glimpse overwrites them. Returns the backup folder (project-relative). */
  async function backupFiles(files: FilePatch[]): Promise<string> {
    const backup = join(stateDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    for (const f of files) {
      const from = safeJoin(dir, f.file);
      if (!from || !(await isFile(from))) continue;
      const to = join(backup, f.file);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    // Their names are timestamps, so they sort oldest first.
    const all = (await readdir(join(stateDir, "backups")).catch(() => [] as string[])).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await rm(join(stateDir, "backups", old), { recursive: true, force: true });
    return relative(dir, backup).split(sep).join("/");
  }

  /** Version history: list, save, restore, thumbnails. */
  async function handleHistory(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (path === "/api/history" && req.method === "GET") {
      send(res, 200, { snapshots: history.list() });
      return;
    }

    if (path === "/api/history/snapshot" && req.method === "POST") {
      const body = (await readJson(req)) as { label?: unknown };
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : DEFAULT_MANUAL_LABEL;
      const { snapshot, created } = await history.snapshot("manual", label);
      send(res, 200, { snapshot: publicSnapshot(snapshot), created });
      return;
    }

    const m = /^\/api\/history\/([^/]+)\/(restore|thumb)$/.exec(path);
    const id = m?.[1] ?? "";
    if (!m || !history.get(id)) {
      send(res, 404, { error: m ? `No such snapshot: ${id}` : "Not found" });
      return;
    }

    if (m[2] === "restore" && req.method === "POST") {
      const r = await history.restore(id);
      broadcast({ type: "reload" });
      send(res, 200, {
        restored: publicSnapshot(r.target),
        // The files as they were before (usually the latest version, saved already) and right after.
        backup: r.backup && publicSnapshot(r.backup),
        snapshot: r.snapshot && publicSnapshot(r.snapshot),
        written: r.written,
        deleted: r.deleted,
        skipped: r.skipped,
      });
      return;
    }

    if (m[2] === "thumb" && (req.method === "PUT" || req.method === "POST")) {
      const body = (await readJson(req)) as { dataUrl?: unknown };
      const png = decodePngDataUrl(body.dataUrl);
      if (!png) {
        send(res, 400, { error: "Expected { dataUrl: 'data:image/png;base64,…' } of at most 5 MB" });
        return;
      }
      const snapshot = publicSnapshot(await history.setThumb(id, png));
      send(res, 200, { snapshot });
      return;
    }

    if (m[2] === "thumb" && req.method === "GET") {
      const png = history.get(id)!.thumb ? await readFile(history.thumbFile(id)).catch(() => null) : null;
      if (!png) {
        send(res, 404, { error: "No thumbnail for that snapshot" });
        return;
      }
      res.writeHead(200, { "content-type": MIME[".png"]!, "cache-control": "no-store" });
      res.end(png);
      return;
    }

    send(res, 405, { error: "Method not allowed" });
  }

  /** Variants: the human asks for N versions of an element, the agent writes them, the human picks one. */
  async function handleVariants(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (path === "/api/variants" && req.method === "GET") {
      send(res, 200, { jobs: variants.list() });
      return;
    }

    if (path === "/api/variants" && req.method === "POST") {
      if (project.target === "react") {
        // A variant cell would load the raw component file: there is no Vite-backed variant preview yet.
        send(res, 400, { error: "Variants aren't available for React projects yet." });
        return;
      }
      const body = (await readJson(req)) as { src?: unknown; label?: unknown; count?: unknown; hint?: unknown };
      const label = typeof body.label === "string" ? body.label.trim() : "";
      const count = Number(body.count);
      if (!label || !(VARIANT_COUNTS as readonly number[]).includes(count)) {
        send(res, 400, { error: "Expected { label, count: 2 | 3 | 4, src?, hint? }" });
        return;
      }
      const src = typeof body.src === "string" && body.src.trim() ? body.src.trim() : undefined;
      const hint = typeof body.hint === "string" && body.hint.trim() ? body.hint.trim() : undefined;
      const job = await variants.create({ ...(src && { src }), label, count, ...(hint && { hint }) });
      const h = await addHandoff({
        kind: "variants",
        changeList: { version: 1, target: project.target, createdAt: job.createdAt, changes: [] },
        prompt: variantsPrompt(job, project),
        variants: { id: job.id, src, label, count, hint },
      });
      await variants.update(job.id, { seq: h.seq });
      broadcast({ type: "variants", job: variants.get(job.id) });
      send(res, 200, { job: variants.get(job.id), seq: h.seq, delivered: h.delivered });
      return;
    }

    const m = /^\/api\/variants\/([^/]+)(?:\/(choose|discard))?$/.exec(path);
    const job = m ? variants.get(m[1]!) : undefined;
    if (!m || !job) {
      send(res, 404, { error: m ? `No such variants job: ${m[1]}` : "Not found" });
      return;
    }
    // A second "Use this" (double click, another tab) or a Discard while one is being applied
    // would back up for nothing and copy from a folder that is being deleted. Claimed before any await.
    if (m[2] && req.method === "POST") {
      if (busyJobs.has(job.id)) {
        send(res, 409, { error: "These variants are being applied or discarded right now" });
        return;
      }
      busyJobs.add(job.id);
      try {
        await chooseOrDiscard(m[2], job, req, res);
      } finally {
        busyJobs.delete(job.id);
      }
      return;
    }

    if (!m[2] && req.method === "GET") {
      const files: Record<number, string[]> = {};
      for (let k = 1; k <= job.count; k++) files[k] = await variants.files(job.id, k);
      send(res, 200, { job, files });
      return;
    }

    send(res, 405, { error: "Method not allowed" });
  }

  async function chooseOrDiscard(action: string, job: VariantJob, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (action === "choose") {
      const body = (await readJson(req)) as { k?: unknown };
      const k = Number(body.k);
      if (!Number.isInteger(k) || k < 1 || k > job.count) {
        send(res, 400, { error: `Expected { k: 1..${job.count} }` });
        return;
      }
      const files = await variants.files(job.id, k);
      if (files.length === 0) {
        send(res, 409, { error: `Variant ${k} has no files yet` });
        return;
      }
      const from = variants.dir(job.id, k);
      const { backup, snapshot, result } = await history.guardedWrite(
        { kind: "variant", label: `Before using variant ${k} of ${job.label}` },
        { kind: "variant", label: `Used variant ${k} of ${job.label}` },
        async (current) => {
          const copied: string[] = [];
          const skipped: string[] = [];
          const backedUp = new Set(Object.keys(current.files).map((p) => p.toLowerCase()));
          for (const rel of files) {
            // A variant may only replace project files: never Glimpse's state, git or dependencies, nothing
            // through a symlink, and nothing the backup doesn't hold (too big, past the file cap).
            const to = await writablePath(dir, rel);
            const src = join(from, ...rel.split("/"));
            const ok = to && (await isRegularFile(src)) && (backedUp.has(rel.toLowerCase()) || !(await lexists(to)));
            if (!ok) {
              skipped.push(rel);
              continue;
            }
            await mkdir(dirname(to), { recursive: true });
            await copyFile(src, to);
            copied.push(rel);
          }
          return { copied, skipped };
        },
      );
      await closeVariantsJob(job.id);
      send(res, 200, {
        files: result.copied,
        skipped: result.skipped,
        backup: backup && publicSnapshot(backup),
        snapshot: snapshot && publicSnapshot(snapshot),
      });
      return;
    }
    await closeVariantsJob(job.id);
    send(res, 200, { ok: true });
  }

  /** A variants job was chosen or discarded: drop it, and withdraw its request if no agent has picked it up yet. */
  async function closeVariantsJob(id: string): Promise<void> {
    await variants.remove(id);
    broadcast({ type: "variants-removed", id });
    const h = handoffs.find((x) => x.kind === "variants" && x.variants?.id === id);
    if (!h || h.delivered) return;
    h.delivered = true;
    h.cancelled = true;
    await persist(h);
    broadcast({ type: "handoff-delivered", seq: h.seq });
  }

  async function servePreview(rel: string, res: ServerResponse): Promise<void> {
    let file = safeJoin(dir, rel || project.entry);
    if (!file) return send(res, 403, { error: "Forbidden" });
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      await sendLive(res, file, relative(dir, file).split(sep).join("/"));
    } catch {
      send(res, 404, { error: `Not found: ${rel}` });
    }
  }

  /**
   * A file as it was in snapshot `id`. HTML is served exactly as stored: no
   * live client and no source locations, since it isn't editable.
   */
  async function serveSnapshot(id: string, rel: string, res: ServerResponse): Promise<void> {
    if (!history.get(id)) return send(res, 404, { error: `No such snapshot: ${id}` });
    let file = cleanRel(rel || project.entry);
    if (file === null) return send(res, 403, { error: "Forbidden" });
    if (file === "" || file.endsWith("/")) file += "index.html";
    else if (!history.has(id, file) && history.has(id, `${file}/index.html`)) file += "/index.html";
    const type = MIME[posix.extname(file).toLowerCase()] ?? "application/octet-stream";
    // The live preview finds "Logo.PNG" as "logo.png" on macOS and Windows; so must a version of it.
    const stored = history.findPath(id, file, CASE_INSENSITIVE_FS);
    const data = stored === null ? null : await history.readFile(id, stored);
    if (data) {
      // Exactly as stored, so in the encoding the page declares.
      const contentType = type === MIME[".html"] ? `text/html; charset=${htmlCharset(data)}` : type;
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      res.end(data);
      return;
    }
    // Never versioned (dependencies, build output, huge media): use the live file so the page still renders.
    const live = /(^|\/)(\.git|\.glimpse)(\/|$)/i.test(file) ? null : safeJoin(dir, file);
    if (live && (isIgnored(file) || (await fileSize(live)) > MAX_FILE_BYTES)) {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(await readFile(live));
      return;
    }
    // A page this version doesn't have (say, the first one of a project built from scratch) is
    // shown in a frame: say so there, in the editor's colors, rather than as raw JSON.
    if (type === MIME[".html"]) {
      res.writeHead(404, { "content-type": type, "cache-control": "no-store" });
      res.end(missingPage(file));
      return;
    }
    send(res, 404, { error: `Not found in ${id}: ${file}` });
  }

  /**
   * Variant k of a job, overlaid on the project: the agent's file when it wrote
   * one, the project's otherwise. HTML gets source locations (project-relative)
   * and the live client, like the preview.
   */
  async function serveVariant(id: string, k: number, rel: string, res: ServerResponse): Promise<void> {
    const job = variants.get(id);
    if (!job || !Number.isInteger(k) || k < 1 || k > job.count) return send(res, 404, { error: "No such variant" });
    const clean = cleanRel(rel || project.entry);
    if (clean === null) return send(res, 403, { error: "Forbidden" });
    for (const root of [variants.dir(id, k), dir]) {
      let file = safeJoin(root, clean);
      if (!file) return send(res, 403, { error: "Forbidden" });
      if (await isDir(file)) file = join(file, "index.html");
      if (!(await isFile(file))) continue;
      await sendLive(res, file, relative(root, file).split(sep).join("/"));
      return;
    }
    send(res, 404, { error: `Not found: ${clean}` });
  }

  /** Send a project (or variant) file; HTML pages get source locations and the live client. */
  async function sendLive(res: ServerResponse, file: string, rel: string): Promise<void> {
    const ext = extname(file).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      // Served as UTF-8 whatever the file declares (the header wins over its <meta charset>), so decoded as declared.
      const html = injectClient(instrumentHtml(decodeHtml(await readFile(file)), rel));
      res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
      res.end(html);
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  }

  async function serveEditor(path: string, res: ServerResponse): Promise<void> {
    if (!opts.editorDir) {
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end(`<!doctype html><title>Glimpse</title><body style="background:#000;color:#fafafa;font-family:system-ui;margin:0">
<p style="padding:16px">Editor bundle not found. Previewing <code>${project.entry}</code>.</p>
<iframe src="/preview/" style="border:0;width:100vw;height:calc(100vh - 56px);background:#fff"></iframe>`);
      return;
    }
    const file = safeJoin(opts.editorDir, path === "/" ? "index.html" : path.slice(1));
    const target = file && (await isFile(file)) ? file : join(opts.editorDir, "index.html");
    const ext = extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(await readFile(target));
  }

  /** Snapshot the project (the editor hears about it from the history); failures are logged, never fatal. */
  async function takeSnapshot(kind: SnapshotKind, label: string): Promise<void> {
    await history.snapshot(kind, label).catch(warnSnapshot);
  }

  // Handoffs are added one at a time, so a screenshot written under its seq can't race another handoff.
  let handoffQueue: Promise<unknown> = Promise.resolve();
  function addHandoff(
    h: Omit<Handoff, "seq" | "createdAt" | "delivered">,
    opts: { notify?: boolean; screenshot?: Buffer } = {},
  ): Promise<Handoff> {
    const run = handoffQueue.then(() => addHandoffNow(h, opts));
    handoffQueue = run.catch(() => undefined);
    return run;
  }

  async function addHandoffNow(
    h: Omit<Handoff, "seq" | "createdAt" | "delivered">,
    opts: { notify?: boolean; screenshot?: Buffer },
  ): Promise<Handoff> {
    const notify = opts.notify ?? true;
    const handoff: Handoff = { seq: Math.max(handoffs.at(-1)?.seq ?? 0, seqFloor) + 1, createdAt: new Date().toISOString(), delivered: !notify, ...h };
    if (opts.screenshot) {
      // Written before the agent can receive the handoff, so the file is always there when it looks.
      const file = join(stateDir, "handoffs", `${handoff.seq}.png`);
      await writeFile(file, opts.screenshot);
      handoff.screenshot = `.glimpse/handoffs/${handoff.seq}.png`;
      handoff.prompt += `\n\nScreenshot of the human's edited version: ${file.split(sep).join("/")}`;
    }
    handoffs.push(handoff);
    if (notify) offer(handoff);
    await persist(handoff);
    broadcast({ type: "handoff", ...summarize(handoff) });
    // No agent listening: Glimpse runs it itself (if an engine is available; otherwise it waits as before).
    if (notify && !handoff.delivered && handoff.kind !== "source") void runner.enqueue(handoff).catch(() => undefined);
    return handoff;
  }

  /** Handoffs no agent has received yet. */
  function pendingHandoffs(): Handoff[] {
    return handoffs.filter((h) => !h.delivered && !h.cancelled && h.kind !== "source");
  }

  /** The built-in agent took it: the same bookkeeping as an external agent taking it. */
  function markDelivered(h: Handoff): void {
    h.delivered = true;
    persist(h).catch((err: unknown) => console.warn(`glimpse: couldn't save handoff #${h.seq} (${err instanceof Error ? err.message : String(err)})`));
    broadcast({ type: "handoff-delivered", seq: h.seq });
  }

  /** An external agent listens, or did a moment ago (agents poll in chunks, so it is between two polls). */
  function externalWaiting(): boolean {
    return waiters.size > 0 || lastWaiting;
  }

  /** What the built-in agent is told: where it runs, then the handoff itself, without the "wait for the human" step. */
  function builtInPrompt(h: Handoff): string {
    const preamble = [
      `You are running inside Glimpse, a visual editor that previews this project live. The current directory is the project folder (${dir}).`,
      `Make the changes by writing the files directly; Glimpse shows every save to the human as it happens. Keep ${entryRel()} as the file Glimpse previews unless asked otherwise.`,
      "Don't wait for the human or call any glimpse wait tool: finish the task and stop.",
    ].join("\n");
    let body: string;
    if (h.kind === "request" && h.request) {
      body = requestPrompt(h.request.text, h.request.target ?? project.target, project, { builtIn: true });
    } else if (h.kind === "variants") {
      const job = h.variants && variants.get(h.variants.id);
      body = job ? variantsPrompt(job, project, { builtIn: true }) : h.prompt;
    } else {
      body = h.prompt;
    }
    if (h.screenshot && !body.includes("Screenshot of the human's edited version")) {
      body += `\n\nScreenshot of the human's edited version: ${join(dir, h.screenshot).split(sep).join("/")}`;
    }
    return `${preamble}\n\n${body}`;
  }

  /** Hand an undelivered handoff to a waiting agent, if one is listening for it. */
  function offer(handoff: Handoff): boolean {
    const waiter = [...waiters].find((w) => w.after === undefined || handoff.seq > w.after);
    if (!waiter) return false;
    waiters.delete(waiter);
    handoff.delivered = true;
    waiter.resolve(handoff);
    agentChanged();
    return true;
  }

  // Handoff files are written one at a time, so an older write can't land after a newer one.
  let persistQueue: Promise<unknown> = Promise.resolve();
  function persist(h: Handoff): Promise<void> {
    const run = persistQueue.then(async () => {
      await writeFile(join(stateDir, "handoffs", `${h.seq}.json`), JSON.stringify(h, null, 2));
      // latest.json is the newest thing the human sent, not whatever was delivered last.
      const newest = handoffs.at(-1);
      if (newest) await writeFile(join(stateDir, "latest.json"), JSON.stringify(newest, null, 2));
    });
    persistQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * A handoff given to an agent never reached it (its request was cancelled or timed out on the
   * client): count it as not delivered again, so the agent's next wait gets it.
   */
  function requeueHandoff(seq: number): boolean {
    const h = handoffs.find((x) => x.seq === seq);
    if (!h || !h.delivered || h.cancelled || h.kind === "source") return false;
    h.delivered = false;
    broadcast({ type: offer(h) ? "handoff-delivered" : "handoff-requeued", seq: h.seq });
    void persist(h).catch(() => {});
    return true;
  }

  /**
   * The next handoff for an agent, or null on timeout or when `signal` aborts. `fresh` is set when
   * this call is what marked it delivered (so it can be requeued if the agent never got it).
   */
  function takeHandoff(after: number | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ handoff: Handoff; fresh: boolean } | null> {
    if (signal?.aborted || closing) return Promise.resolve(null);
    endAiRound();
    // "source" handoffs are informational and never wake an agent; withdrawn ones are gone.
    const ready =
      after === undefined ? handoffs.find((h) => !h.delivered) : handoffs.find((h) => h.seq > after && h.kind !== "source" && !h.cancelled);
    if (ready) {
      const fresh = !ready.delivered;
      if (fresh) {
        ready.delivered = true;
        persist(ready).catch((err: unknown) => console.warn(`glimpse: couldn't save handoff #${ready.seq} (${err instanceof Error ? err.message : String(err)})`));
        broadcast({ type: "handoff-delivered", seq: ready.seq });
      }
      return Promise.resolve({ handoff: ready, fresh });
    }
    return new Promise((resolvePromise) => {
      const waiter = {
        after,
        resolve: (h: Handoff | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          if (h) broadcast({ type: "handoff-delivered", seq: h.seq });
          resolvePromise(h && { handoff: h, fresh: true });
        },
      };
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        waiters.delete(waiter);
        agentChanged();
        resolvePromise(null);
      };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      waiters.add(waiter);
      agentChanged();
    });
  }

  /** Like takeHandoff, but a handoff that arrives just as `signal` aborts goes back in the queue. */
  async function nextHandoff(after: number | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Handoff | null> {
    const got = await takeHandoff(after, timeoutMs, signal);
    if (!got) return null;
    if (signal?.aborted) {
      if (got.fresh) requeueHandoff(got.handoff.seq);
      return null;
    }
    return got.handoff;
  }

  /** Let the editor know whether an agent is currently listening. */
  let lastWaiting = false;
  function agentChanged(): void {
    // Agents poll in chunks, so debounce the "stopped waiting" flicker between polls.
    setTimeout(() => {
      const waiting = waiters.size > 0;
      if (waiting !== lastWaiting) {
        lastWaiting = waiting;
        broadcast({ type: "agent", waiting });
        runner.infoChanged();
        // The external agent went away: what it left waiting runs with the built-in agent, if one is available.
        if (!waiting && !closing) void runner.enqueue(pendingHandoffs()).catch(() => undefined);
      }
    }, waiters.size > 0 ? 0 : 1500).unref();
  }

  function status(message: string): void {
    broadcast({ type: "status", message, at: Date.now() });
  }

  /**
   * Saves in the project are the AI at work: once they have been quiet for a moment, record them
   * as a version (the history keeps adding to the same one until the agent waits for the human).
   */
  let aiRoundTimer: ReturnType<typeof setTimeout> | undefined;
  let aiRoundSince = 0;
  function scheduleAiRound(): void {
    const now = Date.now();
    if (aiRoundTimer === undefined) aiRoundSince = now;
    clearTimeout(aiRoundTimer);
    aiRoundTimer = setTimeout(
      () => {
        aiRoundTimer = undefined;
        history.aiRound().catch(warnSnapshot);
      },
      Math.max(0, Math.min(AI_ROUND_QUIET_MS, aiRoundSince + AI_ROUND_MAX_WAIT_MS - now)),
    );
  }

  /** The agent waits for the human again, so its round is over: record what's pending as part of it, and start anew. */
  function endAiRound(): void {
    const pending = aiRoundTimer !== undefined;
    clearTimeout(aiRoundTimer);
    aiRoundTimer = undefined;
    history.endRound(pending).catch(warnSnapshot);
  }

  /** The agent wrote into .glimpse/variants/<id>/<k>/: tell the editor, and track which variants are ready. */
  function variantChanged(event: string, rel: string): void {
    const v = parseVariantPath(rel);
    const job = v && variants.get(v.id);
    if (!v || !job || v.k < 1 || v.k > job.count) return;
    if (v.path && event !== "unlinkDir") broadcast({ type: "variant-updated", id: v.id, k: v.k, path: v.path, event, at: Date.now() });
    variants.refreshReady(v.id).then(
      (changed) => {
        const fresh = variants.get(v.id);
        if (changed && fresh) broadcast({ type: "variants", job: fresh });
      },
      () => undefined,
    );
  }

  // Browsers always send Origin on websockets: only the editor's own pages may connect (term-input types into a local process).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req) || !originAllowed(req)) return refuseUpgrade(socket, "403 Forbidden");
    // Vite's HMR websocket for the React preview: its own upgrade listener answers it.
    if (reactPreview?.isViteUpgrade(req)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/__glimpse/ws") return socket.destroy();
    if (url.searchParams.get("role") === "preview") {
      // No hello, terminal catch-up, scenes or snapshots: just the file changes it reloads or morphs on.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("close", () => previewSockets.delete(ws));
        previewSockets.add(ws);
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => void onClientMessage(ws, raw));
      ws.on("close", () => {
        sockets.delete(ws);
        releaseTerminal(ws);
      });
      void helloState().then(
        (hello) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify(hello));
          // Catch up on the terminal, then receive every event from here on.
          const catchUp = terminalSnapshot(terminal);
          for (const m of catchUp) ws.send(JSON.stringify(m));
          sockets.add(ws);
          // The scrollback of a full-screen app may hold only its latest updates: have it paint the whole screen.
          if (catchUp.some((m) => m.type === "term-data")) terminal.redraw();
        },
        () => ws.close(1011, "Glimpse couldn't read the project"),
      );
    });
  });

  async function helloState() {
    const state = await projectState();
    const usesTerminal = isScene() || terminal.command !== undefined;
    return {
      type: "hello",
      ...state,
      agentWaiting: waiters.size > 0,
      agentInfo: await runner.info(),
      agentRun: runner.state(),
      terminal: { ...terminalState(), ...(usesTerminal && { pty: await ptyAvailable() }) },
    };
  }

  // Listen first: when the port is taken (callers then retry on another one), nothing else has
  // started yet, so no second watcher and history are left behind writing into the project.
  try {
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(opts.port ?? 4321, host, () => ok());
    });
  } catch (err) {
    closing = true;
    unbridge();
    throw err;
  }

  let watcher: FSWatcher | undefined;
  try {
    await takeSnapshot("initial", "Opened in Glimpse");
    // Live mode: every save in the project is pushed to the editor and the preview.
    // Glimpse's own state in .glimpse is ignored, except the variants the agent writes there.
    watcher = watch(dir, {
      ignored: (p: string) => {
        const rel = relative(dir, p).split(sep).join("/");
        if (rel === ".glimpse" || rel === VARIANTS_DIR || rel.startsWith(`${VARIANTS_DIR}/`)) return false;
        return isIgnored(rel);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
    });
    const watcherReady = new Promise<void>((ok) => watcher!.once("ready", () => ok()));
    for (const event of ["add", "change", "unlink", "unlinkDir"] as const) {
      watcher.on(event, (file: string) => {
        const rel = relative(dir, file).split(sep).join("/");
        if (rel.startsWith(`${VARIANTS_DIR}/`)) return variantChanged(event, rel.slice(VARIANTS_DIR.length + 1));
        if (event === "unlinkDir" || isIgnored(rel)) return;
        broadcast({ type: "file-changed", event, path: rel, at: Date.now() });
        scheduleAiRound();
        if (PROJECT_FILES.has(rel) || rel === entryRel()) refreshProject();
        else if (VITE_CONFIG.test(rel)) viteConfigChanged();
        if (isScene() && rel === entryRel()) sceneChanged(event === "unlink");
        else if (CODE_FILE.test(rel)) scheduleTerminalRestart();
      });
    }
    await watcherReady;
  } catch (err) {
    // Leave nothing running, so the caller can try again.
    closing = true;
    unbridge();
    clearTimeout(aiRoundTimer);
    await watcher?.close();
    await history.idle();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw err;
  }
  const address = server.address();
  port = typeof address === "object" && address ? address.port : (opts.port ?? 4321);

  if (project.target === "react") await ensureReactPreview();
  lastProjectState = JSON.stringify(await projectState());
  if (runCommand) {
    void startTerminal().catch((err: unknown) => {
      const message = `couldn't run ${runCommand}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`glimpse: ${message}`);
      broadcast({ type: "term-error", message });
    });
  }

  return {
    url: `http://${host === "0.0.0.0" || host === "::" ? "localhost" : bracketed(host)}:${port}`,
    port,
    project,
    server,
    token,
    terminal,
    run,
    status,
    nextHandoff: (after, timeoutMs, signal) => nextHandoff(after, timeoutMs, signal),
    requeueHandoff,
    reload: () => broadcast({ type: "reload" }),
    async snapshot(label) {
      const { snapshot } = await history.snapshot("manual", label?.trim() || DEFAULT_MANUAL_LABEL);
      return publicSnapshot(snapshot);
    },
    async close() {
      closing = true;
      // Agents long-polling /api/handoff/next would hold the server open for up to minutes: answer them now.
      for (const w of [...waiters]) {
        waiters.delete(w);
        w.resolve(null);
      }
      // The built-in agent and the app first, so they can't outlive Glimpse.
      await runner.close();
      unbridge();
      clearTimeout(restartTimer);
      await terminal.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await watcher?.close();
      clearTimeout(aiRoundTimer);
      // Let in-flight snapshots, variant updates and scene reads finish before the project goes away.
      await history.idle();
      await variants.idle();
      await Promise.all([refreshQueue, sceneQueue, handoffQueue, persistQueue]);
      await closeReactPreview();
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      force.unref();
      await closed;
      clearTimeout(force);
    },
  };
}

/** macOS and Windows file systems ignore case by default (and macOS Unicode normalization). */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Placeholder for a page a version doesn't have. The meta tag tells the editor not to make a thumbnail of it. */
function missingPage(file: string): string {
  const name = file.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="glimpse-missing" content="${name}"><title>Not in this version</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#a1a1aa;font:14px/1.5 system-ui,sans-serif">
<p>This version has no <code style="color:#fafafa">${name}</code> yet.</p></body></html>`;
}

/** Answer a websocket upgrade with an HTTP error and hang up. */
function refuseUpgrade(socket: Duplex, status: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function summarize(h: Handoff): HandoffSummary {
  const n = h.changeList.changes.length;
  const title =
    h.kind === "request" ? (h.request?.text ?? "Request")
    : h.kind === "variants" ? `${h.variants?.count ?? "Some"} variants of ${h.variants?.label ?? "an element"}`
    : h.changeList.note ? h.changeList.note
    : `${n} change${n === 1 ? "" : "s"}${h.kind === "source" ? " written to source" : ""}`;
  return {
    seq: h.seq,
    kind: h.kind,
    createdAt: h.createdAt,
    title,
    count: n,
    delivered: h.delivered,
    ...(h.cancelled && { cancelled: true }),
    ...(h.screenshot && { screenshot: true }),
  };
}

/** Identifies an Edit source plan (every file before and after), so apply can tell whether it is still the one previewed. */
function planId(files: FilePatch[]): string {
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.file}\0${f.before}\0${f.after}\0`);
  return hash.digest("base64url");
}

function sourcePrompt(list: ChangeList, files: string[]): string {
  return [
    `The human used "Edit source" in Glimpse, which wrote these changes directly into ${files.join(", ")}. Nothing to do; this is for your information:`,
    "",
    changeListToPrompt(list).split("\n").slice(3).join("\n"),
  ].join("\n");
}

function requestPrompt(text: string, target: Target, project: ProjectInfo, opts: { builtIn?: boolean } = {}): string {
  const what = { html: "a web page (HTML/CSS/JS)", react: "a React app", tui: "a terminal UI", native: "a native desktop GUI" }[target];
  return [
    `The human asked for this in Glimpse:`,
    "",
    text,
    "",
    `Build it as ${what} in ${project.dir}` + (target === "html" ? ` (entry: ${project.entry}).` : "."),
    "Glimpse shows every file you save live, so the human watches it appear.",
    target === "tui" || target === "native"
      ? opts.builtIn
        ? `Also write glimpse.scene.json describing the layout so the human can edit it visually, with meta.command set to how the app is run. The format:\n\n${SCENE_AUTHORING_GUIDE}`
        : "Also write glimpse.scene.json describing the layout so the human can edit it visually (call glimpse_scene_schema for the format), with meta.command set to how the app is run."
      : "",
    opts.builtIn ? "" : "When you're done, wait for the human's edits again (glimpse wait / glimpse_wait_for_done).",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
    .trim();
}

/** Handoffs from a previous run, all counted as delivered (so they aren't replayed) unless `stillPending` keeps an undelivered one. */
async function loadHandoffs(dir: string, stillPending: (h: Handoff) => boolean): Promise<{ handoffs: Handoff[]; lastSeq: number }> {
  const out: Handoff[] = [];
  let lastSeq = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = /^(\d+)\.(json|png)$/.exec(name);
    if (!m) continue;
    lastSeq = Math.max(lastSeq, Number(m[1]));
    if (m[2] !== "json") continue;
    try {
      const h = JSON.parse(await readFile(join(dir, name), "utf8")) as Handoff;
      out.push({ ...h, delivered: h.delivered || !stillPending(h) });
    } catch {
      // ignore unreadable files
    }
  }
  return { handoffs: out.sort((a, b) => a.seq - b.seq), lastSeq };
}

function warnSnapshot(err: unknown): void {
  console.warn(`glimpse: couldn't save a version (${err instanceof Error ? err.message : String(err)})`);
}

function isChangeList(v: unknown): v is ChangeList {
  return typeof v === "object" && v !== null && Array.isArray((v as { changes?: unknown }).changes);
}

/** The editor's scene after the human's edits, as sent with Edit source / Send to AI for scene targets. */
function sceneFromBody(v: unknown): Scene {
  const s = v as Partial<Scene> | null;
  const ok =
    typeof s === "object" && s !== null && typeof s.rootId === "string" && typeof s.nodes === "object" && s.nodes !== null && !!s.nodes[s.rootId];
  if (!ok) throw new HttpError(400, "Expected scene: the editor's scene after the edits ({ rootId, nodes, … })");
  return s as Scene;
}

/** An IPv6 address as URLs spell it ("[::1]"); anything else unchanged. */
function bracketed(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function send(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(code, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/**
 * A URL path to a dotfile or dot-folder (".git/config", ".env"), or with a ".." segment (a backslash one, which URL
 * parsing leaves alone). Package managers' and Vite's folders inside node_modules (.pnpm, .vite/deps) are fine.
 */
function hiddenPath(path: string): boolean {
  let deps = false;
  for (const part of path.split(/[/\\]/)) {
    if (part === "..") return true;
    if (part === "node_modules") deps = true;
    else if (!deps && part.startsWith(".") && part !== "." && part !== ".well-known") return true;
  }
  return false;
}

/** Join `rel` onto `root`, refusing anything that escapes `root`. */
function safeJoin(rootDir: string, rel: string): string | null {
  const root = resolve(rootDir);
  const full = normalize(join(root, rel));
  return full === root || full.startsWith(root + sep) ? full : null;
}

/**
 * A URL path as a project-relative path with forward slashes ("" for the root,
 * a trailing slash kept); null when it would escape the project.
 */
function cleanRel(rel: string): string | null {
  if (rel.includes("\0")) return null;
  const path = posix.normalize(rel.split("\\").join("/"));
  if (path === "." || path === "./") return "";
  if (path === ".." || path.startsWith("../") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  return path;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** A plain file, not a symlink to one. */
async function isRegularFile(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await stat(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}
