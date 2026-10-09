import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, type GlimpseServer } from "./index.js";

let dir: string;
let srv: GlimpseServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-sec-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><button>Hi</button></body></html>");
  srv = await startServer({ dir, port: 0 });
});

afterEach(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

/** A raw HTTP request, so Host and Origin can be set like a browser would (fetch doesn't allow them). */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Open the editor websocket with an Origin header; resolves with the first message, or the HTTP status it was refused with. */
function connect(origin?: string): Promise<{ hello?: { type: string; terminal?: unknown }; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`, origin ? { origin } : {});
    ws.once("message", (data) => {
      resolve({ hello: JSON.parse(String(data)) });
      ws.close();
    });
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.once("error", () => resolve({ status: 0 }));
  });
}

const changeList = { version: 1, target: "html", createdAt: new Date().toISOString(), changes: [] };

describe("who may talk to the server", () => {
  it("accepts the editor's own websocket and tools without an Origin", async () => {
    expect((await connect(`http://127.0.0.1:${srv.port}`)).hello?.type).toBe("hello");
    expect((await connect(`http://localhost:${srv.port}`)).hello?.type).toBe("hello");
    expect((await connect()).hello?.type).toBe("hello");
  });

  it("refuses websockets from other origins", async () => {
    expect(await connect("https://evil.example")).toEqual({ status: 403 });
    // Another local port is another origin (some other dev server's page).
    expect(await connect(`http://127.0.0.1:${srv.port + 1}`)).toEqual({ status: 403 });
    expect(await connect("null")).toEqual({ status: 403 });
  });

  it("refuses cross-origin state-changing requests and cross-site API calls", async () => {
    const json = { "content-type": "application/json" };
    const body = JSON.stringify({ kind: "ai", changeList });
    expect((await raw("POST", "/api/handoff", { ...json, origin: "https://evil.example" }, body)).status).toBe(403);
    // A "simple" request (no preflight) is refused just the same.
    expect((await raw("POST", "/api/reload", { "content-type": "text/plain", origin: "http://evil.example:4321" }, "{}")).status).toBe(403);
    expect((await raw("GET", "/api/handoff/next?timeout=1", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // The editor's own page (same origin) and local tools (no Origin) still work.
    expect((await raw("POST", "/api/handoff", { ...json, origin: `http://127.0.0.1:${srv.port}` }, body)).status).toBe(200);
    expect((await raw("POST", "/api/reload", json, "{}")).status).toBe(200);
    expect((await raw("GET", "/api/session", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("refuses requests for other host names (DNS rebinding)", async () => {
    expect((await raw("GET", "/preview/", { host: `evil.example:${srv.port}` })).status).toBe(403);
    expect((await raw("GET", "/preview/", { host: `localhost:${srv.port}` })).status).toBe(200);
    expect((await raw("GET", "/preview/", { host: `127.0.0.1:${srv.port}` })).status).toBe(200);
  });

  it("allows the editor dev server's origin when GLIMPSE_DEV_ORIGIN is set", async () => {
    await srv.close();
    process.env.GLIMPSE_DEV_ORIGIN = "http://localhost:5173";
    try {
      srv = await startServer({ dir, port: 0 });
    } finally {
      delete process.env.GLIMPSE_DEV_ORIGIN;
    }
    expect((await connect("http://localhost:5173")).hello?.type).toBe("hello");
    expect((await raw("POST", "/api/reload", { "content-type": "application/json", origin: "http://localhost:5173" }, "{}")).status).toBe(200);
    expect((await raw("POST", "/api/reload", { "content-type": "application/json", origin: "http://localhost:5174" }, "{}")).status).toBe(403);
  });
});

describe("POST /api/terminal/run", () => {
  const command = `${JSON.stringify(process.execPath)} -e "console.log('hello from the app')"`;

  it("needs the server's token", async () => {
    expect(srv.token).toMatch(/^[\w-]{40,}$/);
    const post = (headers: Record<string, string>) =>
      fetch(`${srv.url}/api/terminal/run`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ command }) });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-glimpse-token": "wrong" })).status).toBe(403);
    expect(srv.terminal.command).toBeUndefined();

    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const output = new Promise<string>((ok) => {
      let text = "";
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as { type: string; data?: string };
        if (msg.type === "term-data") text += msg.data;
        if (msg.type === "term-exit") ok(text);
      });
    });
    await new Promise((ok) => ws.once("message", ok)); // hello: from now on it gets terminal events

    const res = await post({ "x-glimpse-token": srv.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { terminal: { command: string } }).terminal.command).toBe(command);
    expect(await output).toContain("hello from the app");
    ws.close();
  }, 20_000);

  it("keeps the token away from the previewed app", async () => {
    await mkdir(join(dir, ".glimpse"), { recursive: true });
    await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ token: srv.token }));
    for (const path of ["/preview/.glimpse/server.json", "/preview/.GLIMPSE/server.json", "/preview/x/..%2f.glimpse%2fserver.json", "/.glimpse/server.json", "/variant/v1/1/.glimpse/server.json"]) {
      const res = await raw("GET", path, { referer: `http://127.0.0.1:${srv.port}/preview/` });
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain(srv.token);
    }
    // Even with the token, a browser page (which always sends Origin) can't start a command.
    const body = JSON.stringify({ command });
    const res = await raw("POST", "/api/terminal/run", { "content-type": "application/json", origin: `http://127.0.0.1:${srv.port}`, "x-glimpse-token": srv.token }, body);
    expect(res.status).toBe(403);
    expect(srv.terminal.command).toBeUndefined();
  });

  it("never takes a command from the browser's websocket", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const replies: { type: string; message?: string }[] = [];
    ws.on("message", (data) => replies.push(JSON.parse(String(data))));
    await new Promise((ok) => ws.once("open", ok));
    ws.send(JSON.stringify({ type: "term-restart", command }));
    ws.send(JSON.stringify({ type: "term-input", data: "echo hi\r" }));
    await expect.poll(() => replies.find((r) => r.type === "term-error")?.message).toContain("Nothing to run");
    expect(srv.terminal.command).toBeUndefined();
    ws.close();
  });
});
