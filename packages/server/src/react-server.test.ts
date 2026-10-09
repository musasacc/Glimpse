import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ChangeList } from "@glimpse/core";
import { startServer, type GlimpseServer } from "./index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(dir: string, opts: { target?: "react" } = {}): Promise<GlimpseServer> {
  const srv = await startServer({ dir, port: 0, ...opts });
  cleanups.push(() => srv.close());
  return srv;
}

const session = async (srv: GlimpseServer) =>
  (await (await fetch(`${srv.url}/api/session`)).json()) as { project: { target: string }; entryExists: boolean; previewError: string | null };

describe("React projects without their dependencies", () => {
  it("reports why the preview can't run instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-react-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^8.0.0" } }));
    await writeFile(join(dir, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>');
    const srv = await serve(dir);

    expect(srv.project.target).toBe("react");
    const s = await session(srv);
    expect(s.entryExists).toBe(false);
    expect(s.previewError).toMatch(/npm install/);
    const page = await fetch(`${srv.url}/preview/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("npm install");
  });

  it("refuses variants requests, which can't render a React component yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-react-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^8.0.0" } }));
    const srv = await serve(dir, { target: "react" });
    const res = await fetch(`${srv.url}/api/variants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "button", src: "src/App.tsx:3:5", count: 2 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("React");
    expect(await srv.nextHandoff(undefined, 10)).toBeNull();
  });

  it("switches an empty folder to React once the agent scaffolds one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-react-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const srv = await serve(dir);
    expect(srv.project.target).toBe("html");
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await expect.poll(() => messages[0]?.type).toBe("hello");

    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    await expect.poll(() => messages.find((m) => m.type === "project"), { timeout: 5000 }).toMatchObject({
      project: { target: "react", entry: "index.html" },
      entryExists: false,
      previewError: expect.stringMatching(/npm install/),
    });
    expect(srv.project.target).toBe("react");
    ws.close();
  }, 15_000);
});

// The fixture is copied into @glimpse/react's fixtures/.tmp, so react, vite and @vitejs/plugin-react resolve from
// that package's devDependencies (like its own tests do).
const reactFixtures = fileURLToPath(new URL("../../react/fixtures/", import.meta.url));

/** Open a raw websocket; resolves with the HTTP status (101 when it was accepted). */
function upgrade(port: number, path: string, protocol: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        "sec-websocket-protocol": protocol,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.on("error", () => resolve(0));
    req.end();
  });
}

describe("React projects with Vite", { timeout: 60_000 }, () => {
  it("serves the app through the project's Vite, keeps HMR's websocket and writes JSX edits", async () => {
    const dir = join(reactFixtures, ".tmp", `server-${process.pid}-${Date.now().toString(36)}`);
    await mkdir(dirname(dir), { recursive: true });
    await cp(join(reactFixtures, "basic"), dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const srv = await serve(dir, { target: "react" });

    expect(await session(srv)).toMatchObject({ project: { target: "react" }, entryExists: true, previewError: null });
    const html = await (await fetch(`${srv.url}/preview/`)).text();
    expect(html).toContain("/preview/@vite/client");
    const app = await (await fetch(`${srv.url}/preview/src/App.tsx`)).text();
    expect(app).toContain("data-glimpse-src");
    // Vite's HMR websocket isn't destroyed by Glimpse's upgrade handler; other paths still are.
    expect(await upgrade(srv.port, "/preview/", "vite-hmr")).toBe(101);
    expect(await upgrade(srv.port, "/elsewhere", "vite-hmr")).toBe(0);

    const src = (/data-glimpse-src": "(src\/App\.tsx:\d+:\d+)"(?:(?!data-glimpse-src)[^])*?children: "Glazed"/.exec(app) ?? [])[1];
    expect(src).toBeDefined();
    const changeList: ChangeList = {
      version: 1,
      target: "react",
      createdAt: new Date().toISOString(),
      changes: [{ op: "setText", node: "n1", src, from: "Glazed", to: "Maple" }],
    };
    const post = (path: string, body: unknown) =>
      fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
        (r) => r.json() as Promise<{ files: unknown[]; needsAi: unknown[]; applied: unknown }>,
      );
    // Rendered more than once: goes to the AI instead.
    const repeated = await post("/api/patch/preview", { changeList, repeated: [src] });
    expect(repeated.files).toEqual([]);
    expect(repeated.needsAi).toHaveLength(1);

    const applied = await post("/api/patch/apply", { changeList });
    expect(applied).toMatchObject({ files: ["src/App.tsx"], applied: 1, needsAi: [] });
    expect(await readFile(join(dir, "src", "App.tsx"), "utf8")).toContain('<button className="btn">Maple</button>');
  });

  it("starts the preview over when a vite.config appears after it started", async () => {
    const dir = join(reactFixtures, ".tmp", `server-cfg-${process.pid}-${Date.now().toString(36)}`);
    await mkdir(dirname(dir), { recursive: true });
    await cp(join(reactFixtures, "basic"), dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const config = await readFile(join(dir, "vite.config.ts"), "utf8");
    await rm(join(dir, "vite.config.ts"));
    const srv = await serve(dir, { target: "react" });
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    cleanups.push(async () => ws.close());
    const messages: { type: string }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await expect.poll(() => messages[0]?.type).toBe("hello");
    expect(await (await fetch(`${srv.url}/preview/`)).text()).not.toContain("@react-refresh");

    await writeFile(join(dir, "vite.config.ts"), config);
    await expect.poll(() => messages.some((m) => m.type === "reload"), { timeout: 10_000 }).toBe(true);
    expect(await (await fetch(`${srv.url}/preview/`)).text()).toContain("@react-refresh");
  });
});
