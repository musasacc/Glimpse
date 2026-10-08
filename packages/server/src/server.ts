import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { WebSocketServer, type WebSocket } from "ws";
import { changeListToPrompt, type ChangeList, type Target } from "@glimpse/core";
import { detectProject, type ProjectInfo } from "./detect.js";
import { CLIENT_SCRIPT, injectClient } from "./inject.js";
import { instrumentHtml } from "./instrument.js";
import { planPatch } from "./patch-html.js";

/**
 * - `ai`: the human's edits, for the agent to apply ("Send to AI")
 * - `source`: edits Glimpse already wrote into the files ("Edit source"), for the agent's information
 * - `request`: a free-form build request typed on the home screen
 */
export type HandoffKind = "ai" | "source" | "request";

export interface Handoff {
  seq: number;
  kind: HandoffKind;
  createdAt: string;
  changeList: ChangeList;
  /** Plain-language version for the agent. */
  prompt: string;
  /** For `request` handoffs: what the human typed. */
  request?: { text: string; target?: Target };
  /** Whether an agent has already received it. */
  delivered: boolean;
}

export interface HandoffSummary {
  seq: number;
  kind: HandoffKind;
  createdAt: string;
  title: string;
  count: number;
  delivered: boolean;
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  target?: Target;
  entry?: string;
  /** Directory with the built editor (index.html + assets). */
  editorDir?: string;
}

export interface GlimpseServer {
  url: string;
  port: number;
  project: ProjectInfo;
  server: Server;
  /** Post a status line to the editor's activity feed. */
  status(message: string): void;
  /**
   * Resolve with the next handoff for the agent, or null on timeout.
   * With `afterSeq`, the first handoff newer than it; without, the oldest one
   * no agent has received yet (so requests sent while no agent listened are queued).
   */
  nextHandoff(afterSeq: number | undefined, timeoutMs: number): Promise<Handoff | null>;
  /** Broadcast a full reload of the preview. */
  reload(): void;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
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
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const IGNORED = /(^|[\\/])(node_modules|\.git|\.glimpse|dist)([\\/]|$)/;

export async function startServer(opts: ServerOptions): Promise<GlimpseServer> {
  const dir = resolve(opts.dir);
  const project = detectProject(dir, { target: opts.target, entry: opts.entry });
  const stateDir = join(dir, ".glimpse");
  await mkdir(join(stateDir, "handoffs"), { recursive: true });

  const handoffs: Handoff[] = await loadHandoffs(join(stateDir, "handoffs"));
  const waiters = new Set<{ after: number | undefined; resolve: (h: Handoff) => void }>();
  const sockets = new Set<WebSocket>();

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);

    if (path === "/__glimpse/client.js") {
      res.writeHead(200, { "content-type": MIME[".js"]!, "cache-control": "no-store" });
      res.end(CLIENT_SCRIPT);
      return;
    }

    if (path === "/api/session" && req.method === "GET") {
      send(res, 200, {
        project,
        entryExists: await isFile(join(dir, project.entry)),
        agentWaiting: waiters.size > 0,
        lastSeq: handoffs.at(-1)?.seq ?? 0,
      });
      return;
    }

    if (path === "/api/handoffs" && req.method === "GET") {
      send(res, 200, { handoffs: handoffs.map(summarize).reverse() });
      return;
    }

    const seqMatch = path.match(/^\/api\/handoffs\/(\d+)$/);
    if (seqMatch && req.method === "GET") {
      const h = handoffs.find((x) => x.seq === Number(seqMatch[1]));
      if (h) send(res, 200, h);
      else send(res, 404, { error: "No such handoff" });
      return;
    }

    if (path === "/api/handoff" && req.method === "POST") {
      const body = (await readJson(req)) as { kind?: HandoffKind; changeList?: ChangeList };
      if (!body.changeList || (body.kind !== "ai" && body.kind !== "source")) {
        send(res, 400, { error: "Expected { kind: 'ai' | 'source', changeList }" });
        return;
      }
      const h = await addHandoff({ kind: body.kind, changeList: body.changeList, prompt: changeListToPrompt(body.changeList) });
      send(res, 200, { seq: h.seq, delivered: h.delivered });
      return;
    }

    if ((path === "/api/patch/preview" || path === "/api/patch/apply") && req.method === "POST") {
      const body = (await readJson(req)) as { changeList?: ChangeList };
      if (!body.changeList) {
        send(res, 400, { error: "Expected { changeList }" });
        return;
      }
      const plan = await planPatch(dir, body.changeList.changes);
      if (path === "/api/patch/preview") {
        send(res, 200, { files: plan.files.map(({ file, diff }) => ({ file, diff })), applied: plan.applied, needsAi: plan.needsAi });
        return;
      }
      // Back up every file before writing it, so "Edit source" can always be undone by hand.
      const backup = join(stateDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      for (const f of plan.files) {
        const to = join(backup, f.file);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(dir, f.file), to);
      }
      for (const f of plan.files) await writeFile(join(dir, f.file), f.after);
      if (plan.applied.length > 0) {
        const changeList: ChangeList = { ...body.changeList, changes: plan.applied };
        // Recorded for the history (and so the agent can look it up), but it doesn't wake the agent: there's nothing to do.
        await addHandoff({ kind: "source", changeList, prompt: sourcePrompt(changeList, plan.files.map((f) => f.file)) }, { notify: false });
      }
      send(res, 200, {
        files: plan.files.map((f) => f.file),
        applied: plan.applied.length,
        needsAi: plan.needsAi,
        backup: relative(dir, backup).split(sep).join("/"),
      });
      return;
    }

    if (path === "/api/request" && req.method === "POST") {
      const body = (await readJson(req)) as { text?: string; target?: Target };
      const text = String(body.text ?? "").trim();
      if (!text) {
        send(res, 400, { error: "Expected { text }" });
        return;
      }
      const target = body.target ?? project.target;
      const h = await addHandoff({
        kind: "request",
        changeList: { version: 1, target, createdAt: new Date().toISOString(), changes: [] },
        prompt: requestPrompt(text, target, project),
        request: { text, target },
      });
      send(res, 200, { seq: h.seq, delivered: h.delivered });
      return;
    }

    if (path === "/api/handoff/next" && req.method === "GET") {
      const afterParam = url.searchParams.get("after");
      const after = afterParam === null || afterParam === "" ? undefined : Number(afterParam);
      const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 30), 600) * 1000;
      // If the agent disconnects mid-wait, stop waiting so nothing is delivered to a dead request.
      const cancel = new AbortController();
      res.on("close", () => cancel.abort());
      const h = await nextHandoff(after, timeout, cancel.signal);
      if (cancel.signal.aborted) return;
      send(res, 200, h ? { status: "ready", handoff: h } : { status: "editing" });
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

    if (path.startsWith("/preview/") || path === "/preview") {
      await servePreview(path.slice("/preview".length).replace(/^\/+/, ""), res);
      return;
    }

    await serveEditor(path, res);
  }

  async function servePreview(rel: string, res: ServerResponse): Promise<void> {
    let file = safeJoin(dir, rel || project.entry);
    if (!file) return send(res, 403, { error: "Forbidden" });
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const ext = extname(file).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        const rel = relative(dir, file).split(sep).join("/");
        const html = injectClient(instrumentHtml(await readFile(file, "utf8"), rel));
        res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
        res.end(html);
        return;
      }
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(file));
    } catch {
      send(res, 404, { error: `Not found: ${rel}` });
    }
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

  async function addHandoff(h: Omit<Handoff, "seq" | "createdAt" | "delivered">, opts: { notify?: boolean } = {}): Promise<Handoff> {
    const notify = opts.notify ?? true;
    const handoff: Handoff = { seq: (handoffs.at(-1)?.seq ?? 0) + 1, createdAt: new Date().toISOString(), delivered: !notify, ...h };
    handoffs.push(handoff);
    const waiter = notify ? [...waiters].find((w) => w.after === undefined || handoff.seq > w.after) : undefined;
    if (waiter) {
      waiters.delete(waiter);
      handoff.delivered = true;
      waiter.resolve(handoff);
      agentChanged();
    }
    await persist(handoff);
    broadcast({ type: "handoff", ...summarize(handoff) });
    return handoff;
  }

  async function persist(h: Handoff): Promise<void> {
    await writeFile(join(stateDir, "handoffs", `${h.seq}.json`), JSON.stringify(h, null, 2));
    await writeFile(join(stateDir, "latest.json"), JSON.stringify(h, null, 2));
  }

  function nextHandoff(after: number | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Handoff | null> {
    if (signal?.aborted) return Promise.resolve(null);
    // "source" handoffs are informational and never wake an agent.
    const ready =
      after === undefined ? handoffs.find((h) => !h.delivered) : handoffs.find((h) => h.seq > after && h.kind !== "source");
    if (ready) {
      if (!ready.delivered) {
        ready.delivered = true;
        void persist(ready);
        broadcast({ type: "handoff-delivered", seq: ready.seq });
      }
      return Promise.resolve(ready);
    }
    return new Promise((resolvePromise) => {
      const waiter = {
        after,
        resolve: (h: Handoff) => {
          clearTimeout(timer);
          broadcast({ type: "handoff-delivered", seq: h.seq });
          resolvePromise(h);
        },
      };
      const stop = () => {
        clearTimeout(timer);
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

  /** Let the editor know whether an agent is currently listening. */
  let lastWaiting = false;
  function agentChanged(): void {
    // Agents poll in chunks, so debounce the "stopped waiting" flicker between polls.
    setTimeout(() => {
      const waiting = waiters.size > 0;
      if (waiting !== lastWaiting) {
        lastWaiting = waiting;
        broadcast({ type: "agent", waiting });
      }
    }, waiters.size > 0 ? 0 : 1500).unref();
  }

  function status(message: string): void {
    broadcast({ type: "status", message, at: Date.now() });
  }

  // Live mode: every save in the project is pushed to the editor and the preview.
  const watcher: FSWatcher = watch(dir, {
    ignored: (p: string) => IGNORED.test(relative(dir, p)),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
  });
  const watcherReady = new Promise<void>((ok) => watcher.once("ready", () => ok()));
  for (const event of ["add", "change", "unlink"] as const) {
    watcher.on(event, (file: string) => {
      broadcast({ type: "file-changed", event, path: relative(dir, file).split(sep).join("/"), at: Date.now() });
    });
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__glimpse/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      void isFile(join(dir, project.entry)).then((entryExists) =>
        ws.send(JSON.stringify({ type: "hello", project, entryExists, agentWaiting: waiters.size > 0 })),
      );
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4321, host, () => ok());
  });
  await watcherReady;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4321);

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    port,
    project,
    server,
    status,
    nextHandoff: (after, timeoutMs) => nextHandoff(after, timeoutMs),
    reload: () => broadcast({ type: "reload" }),
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await watcher.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

function summarize(h: Handoff): HandoffSummary {
  const n = h.changeList.changes.length;
  const title =
    h.kind === "request" ? (h.request?.text ?? "Request")
    : h.changeList.note ? h.changeList.note
    : `${n} change${n === 1 ? "" : "s"}${h.kind === "source" ? " written to source" : ""}`;
  return { seq: h.seq, kind: h.kind, createdAt: h.createdAt, title, count: n, delivered: h.delivered };
}

function sourcePrompt(list: ChangeList, files: string[]): string {
  return [
    `The human used "Edit source" in Glimpse, which wrote these changes directly into ${files.join(", ")}. Nothing to do; this is for your information:`,
    "",
    changeListToPrompt(list).split("\n").slice(3).join("\n"),
  ].join("\n");
}

function requestPrompt(text: string, target: Target, project: ProjectInfo): string {
  const what = { html: "a web page (HTML/CSS/JS)", react: "a React app", tui: "a terminal UI", native: "a native desktop GUI" }[target];
  return [
    `The human asked for this in Glimpse:`,
    "",
    text,
    "",
    `Build it as ${what} in ${project.dir}` + (target === "html" ? ` (entry: ${project.entry}).` : "."),
    "Glimpse shows every file you save live, so the human watches it appear.",
    target === "tui" || target === "native"
      ? "Also write glimpse.scene.json describing the layout so the human can edit it visually (see docs/scene-schema.md)."
      : "",
    "When you're done, wait for the human's edits again (glimpse wait / glimpse_wait_for_done).",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
    .trim();
}

async function loadHandoffs(dir: string): Promise<Handoff[]> {
  const out: Handoff[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const h = JSON.parse(await readFile(join(dir, name), "utf8")) as Handoff;
      // Anything from a previous run counts as delivered so it isn't replayed.
      out.push({ ...h, delivered: true });
    } catch {
      // ignore unreadable files
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function send(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(code, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Join `rel` onto `root`, refusing anything that escapes `root`. */
function safeJoin(rootDir: string, rel: string): string | null {
  const root = resolve(rootDir);
  const full = normalize(join(root, rel));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
