import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ChangeList } from "@glimpse/core";
import { startServer, type GlimpseServer, type PublicSnapshot } from "./index.js";

/** A 1×1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const INDEX = "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body><button>Hi</button></body></html>";

let dir: string;
let srv: GlimpseServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-history-"));
  await writeFile(join(dir, "index.html"), INDEX);
  await writeFile(join(dir, "style.css"), "button{color:red}");
  srv = await startServer({ dir, port: 0 });
});

afterEach(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async <T>(path: string) => (await fetch(`${srv.url}${path}`)).json() as Promise<T>;
const post = (path: string, body: unknown = {}, method = "POST") =>
  fetch(`${srv.url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const snapshots = async () => (await get<{ snapshots: PublicSnapshot[] }>("/api/history")).snapshots;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Collect websocket messages and wait for one matching `pred`. */
async function listen() {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
  const messages: { type: string; [k: string]: unknown }[] = [];
  const pending = new Set<() => void>();
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)));
    for (const check of pending) check();
  });
  await new Promise((ok) => ws.once("open", ok));
  return {
    messages,
    waitFor<T = Record<string, unknown>>(pred: (m: { type: string; [k: string]: unknown }) => boolean, timeoutMs = 6000): Promise<T> {
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("timed out waiting for a websocket message")), timeoutMs);
        const check = () => {
          const hit = messages.find(pred);
          if (!hit) return;
          clearTimeout(timer);
          pending.delete(check);
          ok(hit as T);
        };
        pending.add(check);
        check();
      });
    },
    close: () => ws.close(),
  };
}

const aiChangeList: ChangeList = {
  version: 1,
  target: "html",
  createdAt: new Date().toISOString(),
  changes: [{ op: "setText", node: "n1", src: "index.html:1:77", from: "Hi", to: "Hello" }],
};

describe("version history", () => {
  it("snapshots the project when it opens and never stores a duplicate", async () => {
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "index.js"), "ignored");
    const [initial, ...rest] = await snapshots();
    expect(rest).toEqual([]);
    expect(initial).toMatchObject({ id: "s1", seq: 1, kind: "initial", label: "Opened in Glimpse", fileCount: 2, thumb: false });
    expect(initial).not.toHaveProperty("files");

    // Nothing changed (dependencies aren't versioned): the latest snapshot comes back.
    const same = (await (await post("/api/history/snapshot", { label: "Checkpoint" })).json()) as { snapshot: PublicSnapshot; created: boolean };
    expect(same).toMatchObject({ created: false, snapshot: { id: "s1" } });

    await mkdir(join(dir, "pages"));
    await writeFile(join(dir, "pages", "about.html"), "<p>About</p>");
    const manual = (await (await post("/api/history/snapshot", { label: "Checkpoint" })).json()) as { snapshot: PublicSnapshot; created: boolean };
    expect(manual).toMatchObject({ created: true, snapshot: { id: "s2", kind: "manual", label: "Checkpoint", fileCount: 3 } });
    expect(await srv.snapshot()).toMatchObject({ id: "s2" });

    const stored = JSON.parse(await readFile(join(dir, ".glimpse", "history", "snapshots.json"), "utf8")) as { files: Record<string, string> }[];
    expect(Object.keys(stored[1]!.files).sort()).toEqual(["index.html", "pages/about.html", "style.css"]);
    const sha = stored[1]!.files["pages/about.html"]!;
    expect(await readFile(join(dir, ".glimpse", "history", "objects", sha), "utf8")).toBe("<p>About</p>");
  });

  it("saves an AI round once the files have been quiet", async () => {
    const live = await listen();
    for (const name of ["a.css", "b.css", "c.css"]) await writeFile(join(dir, name), `/* ${name} */`);
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    const msg = await live.waitFor<{ snapshot: PublicSnapshot }>((m) => m.type === "snapshot");
    expect(msg.snapshot).toMatchObject({ id: "s2", kind: "ai", label: "AI edited a.css, b.css, c.css +1 more", fileCount: 5 });
    expect((await snapshots()).map((s) => s.kind)).toEqual(["initial", "ai"]);
    live.close();
  }, 10_000);

  it("restores a snapshot after backing up, and doesn't mistake its own writes for an AI round", async () => {
    const live = await listen();
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    await writeFile(join(dir, "extra.js"), "console.log(1)");
    const res = (await (await post("/api/history/s1/restore")).json()) as {
      restored: PublicSnapshot;
      backup: PublicSnapshot;
      written: string[];
      deleted: string[];
    };
    expect(res.restored).toMatchObject({ id: "s1", kind: "initial" });
    expect(res.backup).toMatchObject({ id: "s2", kind: "restore", label: "Before restoring Opened in Glimpse", fileCount: 3 });
    expect(res.written).toEqual(["style.css"]);
    expect(res.deleted).toEqual(["extra.js"]);
    expect(await readFile(join(dir, "style.css"), "utf8")).toBe("button{color:red}");
    expect(existsSync(join(dir, "extra.js"))).toBe(false);
    await live.waitFor((m) => m.type === "reload");

    // The backup can itself be restored.
    await post("/api/history/s2/restore");
    expect(await readFile(join(dir, "extra.js"), "utf8")).toBe("console.log(1)");

    // Well past the quiet period: Glimpse's own writes didn't produce an "ai" snapshot.
    await sleep(2500);
    expect((await snapshots()).map((s) => s.kind)).toEqual(["initial", "restore", "restore"]);
    expect((await post("/api/history/s99/restore")).status).toBe(404);
    live.close();
  }, 15_000);

  it("serves a snapshot's files as they were, without the live client", async () => {
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    const page = await fetch(`${srv.url}/snapshot/s1/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe(INDEX);
    const css = await fetch(`${srv.url}/snapshot/s1/style.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("button{color:red}");
    expect(await (await fetch(`${srv.url}/snapshot/s1/index.html`)).text()).toBe(INDEX);

    for (const bad of ["..%2f..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "..%5c..%5cwindows%5cwin.ini"]) {
      expect([403, 404]).toContain((await fetch(`${srv.url}/snapshot/s1/${bad}`)).status);
    }
    expect((await fetch(`${srv.url}/snapshot/s1/.glimpse/history/snapshots.json`)).status).toBe(404);
    expect((await fetch(`${srv.url}/snapshot/s1/missing.css`)).status).toBe(404);
    expect((await fetch(`${srv.url}/snapshot/s9/`)).status).toBe(404);
  });

  it("stores and serves thumbnails", async () => {
    expect((await fetch(`${srv.url}/api/history/s1/thumb`)).status).toBe(404);
    const live = await listen();
    const put = await post("/api/history/s1/thumb", { dataUrl: PNG_URL }, "PUT");
    expect(((await put.json()) as { snapshot: PublicSnapshot }).snapshot).toMatchObject({ id: "s1", thumb: true });
    await live.waitFor((m) => m.type === "snapshot-updated");
    const thumb = await fetch(`${srv.url}/api/history/s1/thumb`);
    expect(thumb.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await thumb.arrayBuffer()).toString("base64")).toBe(PNG_B64);
    expect((await snapshots())[0]!.thumb).toBe(true);

    expect((await post("/api/history/s1/thumb", { dataUrl: "data:image/jpeg;base64,/9j/4AAQ" })).status).toBe(400);
    expect((await post("/api/history/s1/thumb", { dataUrl: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}` })).status).toBe(400);
    expect((await post("/api/history/s7/thumb", { dataUrl: PNG_URL })).status).toBe(404);
    live.close();
  });

  it("snapshots handoffs and Edit source, and stores the handoff screenshot", async () => {
    await writeFile(join(dir, "style.css"), "button{color:green}");
    const sent = await post("/api/handoff", { kind: "ai", changeList: aiChangeList, screenshot: PNG_URL });
    expect(await sent.json()).toEqual({ seq: 1, delivered: false });

    const h = await get<{ screenshot: string; prompt: string }>("/api/handoffs/1");
    expect(h.screenshot).toBe(".glimpse/handoffs/1.png");
    const abs = join(dir, ".glimpse", "handoffs", "1.png");
    expect(h.prompt).toContain(`Screenshot of the human's edited version: ${abs.split("\\").join("/")}`);
    expect((await readFile(abs)).toString("base64")).toBe(PNG_B64);
    const shot = await fetch(`${srv.url}/api/handoffs/1/screenshot`);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect((await post("/api/handoff", { kind: "ai", changeList: aiChangeList, screenshot: "data:text/plain,hi" })).status).toBe(400);

    await writeFile(join(dir, "notes.txt"), "a request is coming");
    await post("/api/request", { text: "add a footer" });

    const applied = (await (await post("/api/patch/apply", { changeList: aiChangeList })).json()) as { snapshot: PublicSnapshot };
    expect(applied.snapshot).toMatchObject({ kind: "source", label: "Wrote 1 change to source" });
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<button>Hello</button>");

    expect((await snapshots()).map((s) => [s.kind, s.label])).toEqual([
      ["initial", "Opened in Glimpse"],
      ["handoff", "Sent 1 change to the AI"],
      ["handoff", "Sent a request"],
      ["source", "Wrote 1 change to source"],
    ]);
    expect((await fetch(`${srv.url}/api/handoffs/2/screenshot`)).status).toBe(404);
    // The list flags handoffs that carry a screenshot, so the editor can mark them.
    const { handoffs } = await get<{ handoffs: { seq: number; screenshot?: boolean }[] }>("/api/handoffs");
    expect(handoffs.find((x) => x.seq === 1)?.screenshot).toBe(true);
    expect(handoffs.find((x) => x.seq === 2)?.screenshot).toBeUndefined();
  });
});
