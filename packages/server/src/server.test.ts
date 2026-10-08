import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ChangeList } from "@glimpse/core";
import { startServer, type GlimpseServer } from "./index.js";

let dir: string;
let srv: GlimpseServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><button>Hi</button></body></html>");
  await writeFile(join(dir, "style.css"), "button{color:red}");
  srv = await startServer({ dir, port: 0 });
});

afterEach(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

describe("server", () => {
  it("detects a plain HTML project", () => {
    expect(srv.project).toMatchObject({ target: "html", entry: "index.html" });
  });

  it("serves the preview with the live client injected", async () => {
    const html = await (await fetch(`${srv.url}/preview/`)).text();
    expect(html).toContain("<button>Hi</button>");
    expect(html).toContain('<script data-glimpse-internal src="/__glimpse/client.js"></script></body>');
    const css = await fetch(`${srv.url}/preview/style.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("refuses to serve files outside the project", async () => {
    const res = await fetch(`${srv.url}/preview/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
  });

  it("pushes file changes over the websocket (live mode)", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const changed = new Promise<{ path: string }>((ok) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "file-changed") ok(msg);
      });
    });
    await new Promise((ok) => ws.once("open", ok));
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    expect((await changed).path).toBe("style.css");
    ws.close();
  }, 10_000);

  it("hands the change list to a waiting agent", async () => {
    const waiting = fetch(`${srv.url}/api/handoff/next?after=0&timeout=5`).then((r) => r.json());
    const changeList: ChangeList = {
      version: 1,
      target: "html",
      createdAt: new Date().toISOString(),
      changes: [{ op: "setText", node: "n1", from: "Hi", to: "Hello", label: 'button "Hi"' }],
    };
    const post = await fetch(`${srv.url}/api/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "ai", changeList }),
    });
    expect(await post.json()).toEqual({ seq: 1 });
    const result = (await waiting) as { status: string; handoff: { prompt: string } };
    expect(result.status).toBe("ready");
    expect(result.handoff.prompt).toContain('Change the text of button "Hi" from "Hi" to "Hello".');
  });

  it("reports 'editing' when nothing was sent before the timeout", async () => {
    expect(await srv.nextHandoff(0, 50)).toBeNull();
  });
});
