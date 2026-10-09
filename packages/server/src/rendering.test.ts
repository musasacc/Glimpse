import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, type GlimpseServer } from "./index.js";
import { trimOutput } from "./terminal.js";

let dir: string | undefined;
let srv: GlimpseServer | undefined;

afterEach(async () => {
  await srv?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  srv = dir = undefined;
});

async function open(files: Record<string, string>, entry?: string): Promise<GlimpseServer> {
  dir = await mkdtemp(join(tmpdir(), "glimpse-render-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  srv = await startServer({ dir, port: 0, ...(entry && { entry }) });
  return srv;
}

describe("previewed pages", () => {
  it("sends the preview of an entry in a subfolder to its own URL, so relative URLs and live updates work", async () => {
    const s = await open({ "site/index.html": '<link rel="stylesheet" href="style.css"><p>Hi</p>', "site/style.css": "p{}" }, "site/index.html");
    const res = await fetch(`${s.url}/preview/?x=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/preview/site/index.html?x=1");
    expect(await (await fetch(`${s.url}/preview/site/style.css`)).text()).toBe("p{}");

    const { snapshot } = (await (
      await fetch(`${s.url}/api/history/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    ).json()) as { snapshot: { id: string } };
    const snap = await fetch(`${s.url}/snapshot/${snapshot.id}/`, { redirect: "manual" });
    expect(snap.headers.get("location")).toBe(`/snapshot/${snapshot.id}/site/index.html`);
  });

  it("serves an index.html entry in place, and /preview without a slash at /preview/", async () => {
    const s = await open({ "index.html": "<p>Hi</p>" });
    expect((await fetch(`${s.url}/preview/`, { redirect: "manual" })).status).toBe(200);
    const bare = await fetch(`${s.url}/preview`, { redirect: "manual" });
    expect(bare.headers.get("location")).toBe("/preview/");
  });

  it("serves root-absolute URLs of a version from that version", async () => {
    const s = await open({ "index.html": '<img src="/logo.svg">', "logo.svg": "<svg>old</svg>" });
    const { snapshot } = (await (
      await fetch(`${s.url}/api/history/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    ).json()) as { snapshot: { id: string } };
    await writeFile(join(dir!, "logo.svg"), "<svg>new</svg>");
    const fromVersion = await fetch(`${s.url}/logo.svg`, { headers: { referer: `${s.url}/snapshot/${snapshot.id}/index.html` } });
    expect(await fromVersion.text()).toBe("<svg>old</svg>");
    const fromLive = await fetch(`${s.url}/logo.svg`, { headers: { referer: `${s.url}/preview/` } });
    expect(await fromLive.text()).toBe("<svg>new</svg>");
  });

  it("serves wasm and media with their types", async () => {
    const s = await open({ "index.html": "<p>Hi</p>", "app.wasm": "\0asm", "a.mp3": "x", "app.js.map": "{}" });
    expect((await fetch(`${s.url}/preview/app.wasm`)).headers.get("content-type")).toBe("application/wasm");
    expect((await fetch(`${s.url}/preview/a.mp3`)).headers.get("content-type")).toBe("audio/mpeg");
    expect((await fetch(`${s.url}/preview/app.js.map`)).headers.get("content-type")).toContain("application/json");
  });
});

describe("terminal", () => {
  it("cuts the scrollback where a terminal can start reading", () => {
    const text = "x".repeat(50) + "\x1b[38;5;12mcolored\nnext line";
    expect(trimOutput(text, 30)).toBe("next line");
    expect(trimOutput("ab\x1b[1mcd", 6)).toBe("\x1b[1mcd");
    expect(trimOutput("a😀b", 2)).toBe("b");
    expect(trimOutput("short", 10)).toBe("short");
  });

  it("sizes the app by the editor in use, not by whichever resized last", async () => {
    const s = await open({ "index.html": "<p>Hi</p>" });
    const connect = async () => {
      const ws = new WebSocket(`${s.url.replace("http", "ws")}/__glimpse/ws`, { origin: s.url });
      await new Promise((ok) => ws.once("message", ok)); // hello
      return ws;
    };
    const settle = () => new Promise((ok) => setTimeout(ok, 100));
    const a = await connect();
    const b = await connect();
    a.send(JSON.stringify({ type: "term-resize", cols: 100, rows: 30 }));
    await settle();
    b.send(JSON.stringify({ type: "term-resize", cols: 90, rows: 20 }));
    await settle();
    expect([s.terminal.cols, s.terminal.rows]).toEqual([100, 30]);
    b.send(JSON.stringify({ type: "term-input", data: "" }));
    await settle();
    expect([s.terminal.cols, s.terminal.rows]).toEqual([90, 20]);
    a.send(JSON.stringify({ type: "term-resize", cols: 100, rows: 30, focus: true }));
    await settle();
    expect(s.terminal.cols).toBe(100);
    a.close();
    await settle();
    expect(s.terminal.cols).toBe(90);
    b.close();
  });
});
