import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { WebSocketServer, type WebSocket } from "ws";
import { changeListToPrompt, type ChangeList, type Target } from "@glimpse/core";
import { detectProject, type ProjectInfo } from "./detect.js";
import { CLIENT_SCRIPT, injectClient } from "./inject.js";

export type HandoffKind = "ai" | "source";

export interface Handoff {
  seq: number;
  kind: HandoffKind;
  createdAt: string;
  changeList: ChangeList;
  /** Plain-language version of the change list for the agent. */
  prompt: string;
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
  /** Resolve with the next handoff after `afterSeq`, or null on timeout. */
  nextHandoff(afterSeq: number, timeoutMs: number): Promise<Handoff | null>;
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

  const handoffs: Handoff[] = [];
  const waiters = new Set<{ after: number; resolve: (h: Handoff) => void }>();
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
      send(res, 200, { project, lastSeq: handoffs.at(-1)?.seq ?? 0 });
      return;
    }

    if (path === "/api/handoff" && req.method === "POST") {
      const body = (await readJson(req)) as { kind?: HandoffKind; changeList?: ChangeList };
      if (!body.changeList || (body.kind !== "ai" && body.kind !== "source")) {
        send(res, 400, { error: "Expected { kind: 'ai' | 'source', changeList }" });
        return;
      }
      const handoff: Handoff = {
        seq: (handoffs.at(-1)?.seq ?? 0) + 1,
        kind: body.kind,
        createdAt: new Date().toISOString(),
        changeList: body.changeList,
        prompt: changeListToPrompt(body.changeList),
      };
      handoffs.push(handoff);
      await writeFile(join(stateDir, "handoffs", `${handoff.seq}.json`), JSON.stringify(handoff, null, 2));
      await writeFile(join(stateDir, "latest.json"), JSON.stringify(handoff, null, 2));
      for (const w of [...waiters]) {
        if (handoff.seq > w.after) {
          waiters.delete(w);
          w.resolve(handoff);
        }
      }
      broadcast({ type: "handoff", seq: handoff.seq, kind: handoff.kind, count: handoff.changeList.changes.length });
      send(res, 200, { seq: handoff.seq });
      return;
    }

    if (path === "/api/handoff/next" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 30), 600) * 1000;
      const h = await nextHandoff(after, timeout);
      send(res, 200, h ? { status: "ready", handoff: h } : { status: "editing" });
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
        const html = injectClient(await readFile(file, "utf8"));
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

  function nextHandoff(after: number, timeoutMs: number): Promise<Handoff | null> {
    const ready = handoffs.find((h) => h.seq > after);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolvePromise) => {
      const waiter = {
        after,
        resolve: (h: Handoff) => {
          clearTimeout(timer);
          resolvePromise(h);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolvePromise(null);
      }, timeoutMs);
      waiters.add(waiter);
    });
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
      ws.send(JSON.stringify({ type: "hello", project }));
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
    nextHandoff,
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await watcher.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
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
