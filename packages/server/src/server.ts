import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFile, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, posix, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { WebSocketServer, type WebSocket } from "ws";
import { changeListToPrompt, type ChangeList, type Target } from "@glimpse/core";
import { detectProject, type ProjectInfo } from "./detect.js";
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
import { CLIENT_SCRIPT, injectClient } from "./inject.js";
import { instrumentHtml } from "./instrument.js";
import { planPatch, type PatchPlan } from "./patch-html.js";
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
};

/** Saves in the project are recorded as (part of) an AI round once they have been quiet this long, */
const AI_ROUND_QUIET_MS = 1500;
/** or once they have kept coming this long (say, a log file the app writes every second). */
const AI_ROUND_MAX_WAIT_MS = 10_000;
/** Request bodies can carry PNG data URLs (thumbnails, screenshots). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Where the agent writes variants, relative to the project (forward slashes). */
const VARIANTS_DIR = ".glimpse/variants";
const DEFAULT_MANUAL_LABEL = "Saved by hand";

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

  const waiters = new Set<{ after: number | undefined; resolve: (h: Handoff) => void }>();
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const history = new History(dir, {
    onSnapshot: (s, change) => broadcast({ type: change === "created" ? "snapshot" : "snapshot-updated", snapshot: publicSnapshot(s) }),
  });
  const variants = new Variants(dir);
  await history.load();
  await variants.load();
  // Anything from a previous run counts as delivered so it isn't replayed, except a variants
  // request no agent got yet whose job is still open: the editor still shows it as waiting.
  const handoffs: Handoff[] = await loadHandoffs(
    join(stateDir, "handoffs"),
    (h) => h.kind === "variants" && !h.cancelled && !!h.variants && !!variants.get(h.variants.id),
  );
  /** Variants jobs being chosen or discarded right now. */
  const busyJobs = new Set<string>();
  const host = opts.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code = err instanceof HttpError ? err.status : err instanceof SyntaxError || err instanceof URIError ? 400 : 500;
      send(res, code, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const refused = refuse(req, host, path.startsWith("/api/"));
    if (refused) return send(res, refused.status, { error: refused.error });

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
      const body = (await readJson(req)) as { kind?: HandoffKind; changeList?: ChangeList; screenshot?: unknown };
      if (!body.changeList || (body.kind !== "ai" && body.kind !== "source")) {
        send(res, 400, { error: "Expected { kind: 'ai' | 'source', changeList, screenshot? }" });
        return;
      }
      // The picture is a nicety: one Glimpse can't take (not a PNG, over 5 MB) is left out, never the edits.
      const screenshot = body.screenshot == null ? undefined : (decodePngDataUrl(body.screenshot) ?? undefined);
      const warning = body.screenshot != null && !screenshot ? "The screenshot wasn't a PNG of at most 5 MB, so it was left out." : undefined;
      const h = await addHandoff({ kind: body.kind, changeList: body.changeList, prompt: changeListToPrompt(body.changeList) }, { screenshot });
      if (h.kind === "ai") {
        const n = h.changeList.changes.length;
        await takeSnapshot("handoff", `Sent ${n} change${n === 1 ? "" : "s"} to the AI`);
      }
      send(res, 200, { seq: h.seq, delivered: h.delivered, ...(warning && { warning }) });
      return;
    }

    if ((path === "/api/patch/preview" || path === "/api/patch/apply") && req.method === "POST") {
      const body = (await readJson(req)) as { changeList?: ChangeList };
      if (!body.changeList) {
        send(res, 400, { error: "Expected { changeList }" });
        return;
      }
      if (path === "/api/patch/preview") {
        const plan = await planPatch(dir, body.changeList.changes);
        send(res, 200, { files: plan.files.map(({ file, diff }) => ({ file, diff })), applied: plan.applied, needsAi: plan.needsAi });
        return;
      }
      const backup = join(stateDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      const label = (plan?: PatchPlan) => {
        const n = plan?.applied.length ?? 0;
        return { kind: "source" as const, label: `Wrote ${n} change${n === 1 ? "" : "s"} to source` };
      };
      // In the history's turn, so the AI's pending saves are recorded as theirs first and these writes as Edit source's.
      const { result: plan, snapshot } = await history.guardedWrite(null, label, async () => {
        const plan = await planPatch(dir, body.changeList!.changes);
        // Back up every file before writing it, so "Edit source" can always be undone by hand.
        for (const f of plan.files) {
          const to = join(backup, f.file);
          await mkdir(dirname(to), { recursive: true });
          await copyFile(join(dir, f.file), to);
        }
        for (const f of plan.files) await writeFile(join(dir, f.file), f.after);
        return plan;
      });
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
        snapshot: plan.files.length > 0 && snapshot ? publicSnapshot(snapshot) : undefined,
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
      await takeSnapshot("handoff", "Sent a request");
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

    if (path === "/api/history" || path.startsWith("/api/history/")) {
      await handleHistory(path, req, res);
      return;
    }

    if (path === "/api/variants" || path.startsWith("/api/variants/")) {
      await handleVariants(path, req, res);
      return;
    }

    if (path.startsWith("/preview/") || path === "/preview") {
      await servePreview(path.slice("/preview".length).replace(/^\/+/, ""), res);
      return;
    }

    const snapMatch = /^\/snapshot\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (snapMatch && req.method === "GET") {
      await serveSnapshot(snapMatch[1]!, snapMatch[2] ?? "", res);
      return;
    }

    const variantMatch = /^\/variant\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (variantMatch && req.method === "GET") {
      await serveVariant(variantMatch[1]!, Number(variantMatch[2]), variantMatch[3] ?? "", res);
      return;
    }

    await serveEditor(path, res);
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
    await writeFile(join(stateDir, "handoffs", `${h.seq}.json`), JSON.stringify(h, null, 2));
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
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
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
      const html = injectClient(instrumentHtml(await readFile(file, "utf8"), rel));
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
    const handoff: Handoff = { seq: (handoffs.at(-1)?.seq ?? 0) + 1, createdAt: new Date().toISOString(), delivered: !notify, ...h };
    if (opts.screenshot) {
      // Written before the agent can receive the handoff, so the file is always there when it looks.
      const file = join(stateDir, "handoffs", `${handoff.seq}.png`);
      await writeFile(file, opts.screenshot);
      handoff.screenshot = `.glimpse/handoffs/${handoff.seq}.png`;
      handoff.prompt += `\n\nScreenshot of the human's edited version: ${file.split(sep).join("/")}`;
    }
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
    endAiRound();
    // "source" handoffs are informational and never wake an agent; withdrawn ones are gone.
    const ready =
      after === undefined ? handoffs.find((h) => !h.delivered) : handoffs.find((h) => h.seq > after && h.kind !== "source" && !h.cancelled);
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

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__glimpse/ws") return socket.destroy();
    // A web page elsewhere must not listen in on (or pose as) the editor.
    if (refuse(req, host, true)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      void isFile(join(dir, project.entry)).then((entryExists) =>
        ws.send(JSON.stringify({ type: "hello", project, entryExists, agentWaiting: waiters.size > 0 })),
      );
    });
  });

  // Listen first: when the port is taken (callers then retry on another one), nothing else has
  // started yet, so no second watcher and history are left behind writing into the project.
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4321, host, () => ok());
  });

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
      });
    }
    await watcherReady;
  } catch (err) {
    clearTimeout(aiRoundTimer);
    await watcher?.close();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw err;
  }
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
    async snapshot(label) {
      const { snapshot } = await history.snapshot("manual", label?.trim() || DEFAULT_MANUAL_LABEL);
      return publicSnapshot(snapshot);
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await watcher?.close();
      clearTimeout(aiRoundTimer);
      // Let in-flight snapshots and variant updates finish writing before the project goes away.
      await history.idle();
      await variants.idle();
      await new Promise<void>((ok) => server.close(() => ok()));
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

/** Handoffs from a previous run, all counted as delivered (so they aren't replayed) unless `stillPending` keeps an undelivered one. */
async function loadHandoffs(dir: string, stillPending: (h: Handoff) => boolean): Promise<Handoff[]> {
  const out: Handoff[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const h = JSON.parse(await readFile(join(dir, name), "utf8")) as Handoff;
      out.push({ ...h, delivered: h.delivered || !stillPending(h) });
    } catch {
      // ignore unreadable files
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function warnSnapshot(err: unknown): void {
  console.warn(`glimpse: couldn't save a version (${err instanceof Error ? err.message : String(err)})`);
}

/**
 * Why a request is refused, or null. The API drives restores and puts text in front of the agent,
 * so only the editor (same origin) and tools on this machine (the CLI and MCP send no Origin) may
 * use it: browsers mark every cross-site request with Origin and Sec-Fetch-Site, and a JSON body
 * can't be sent cross-site without a preflight, which this server never answers. The Host check
 * stops DNS rebinding (a site's own name pointed at 127.0.0.1) from reading anything.
 */
function refuse(req: IncomingMessage, bindHost: string, api: boolean): { status: number; error: string } | null {
  const host = req.headers.host;
  if (host !== undefined && !hostAllowed(host, bindHost)) return { status: 403, error: `Unknown host: ${host}` };
  if (!api) return null;
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
    return { status: 403, error: "Cross-site requests to Glimpse are not allowed" };
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && !/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return { status: 415, error: "Expected a JSON body (content-type: application/json)" };
  }
  return null;
}

/** Loopback names (whatever the port; the editor may sit behind a dev proxy), or the host Glimpse was bound to. */
function hostAllowed(hostHeader: string, bindHost: string): boolean {
  if (bindHost === "0.0.0.0" || bindHost === "::") return true; // served to the network on purpose
  let name: string;
  try {
    name = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bound = bindHost.toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(name) ||
    name === "[::1]" ||
    name === bound ||
    name === `[${bound}]`
  );
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
