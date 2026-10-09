import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReactPreview, ReactPreviewError } from "./dev-server.js";
import { serveFixture, type ServedFixture } from "./serve-fixture.test-helper.js";

/** Open a raw websocket through the shared server; resolves with the status and the first text frame. */
function handshake(port: number, path: string, protocol?: string): Promise<{ status: number; first?: string }> {
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
        ...(protocol ? { "sec-websocket-protocol": protocol } : {}),
      },
    });
    req.on("upgrade", (_res, socket, head) => {
      let buf = head;
      const tryRead = () => {
        // A short unmasked text frame from the server: 0x81, length, payload.
        if (buf.length < 2) return;
        const len = buf[1]! & 0x7f;
        if (len >= 126 || buf.length < 2 + len) return;
        socket.destroy();
        resolve({ status: 101, first: buf.subarray(2, 2 + len).toString("utf8") });
      };
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        tryRead();
      });
      tryRead();
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0 }));
    req.on("error", () => resolve({ status: 0 })); // destroyed by the upgrade handler
    req.end();
  });
}

// The first module request waits for Vite to pre-bundle react: slow on cold CI runners.
describe("createReactPreview", { timeout: 30_000 }, () => {
  let fx: ServedFixture;

  beforeAll(async () => {
    fx = await serveFixture("basic");
  }, 60_000);

  afterAll(async () => {
    await fx?.close();
  });

  it("serves index.html under /preview/ with the Vite client and the Glimpse preview client", async () => {
    const res = await fetch(`${fx.url}/preview/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/preview/@vite/client"');
    expect(html).toContain('src="/preview/@glimpse/preview-client"');
    expect(html).toContain('src="/preview/src/main.tsx"');
    expect(html).toContain("/preview/@react-refresh");
  });

  it("redirects /preview to /preview/", async () => {
    const res = await fetch(`${fx.url}/preview?x=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/preview/?x=1");
  });

  it("serves modules with data-glimpse-src on host elements only", async () => {
    const res = await fetch(`${fx.url}/preview/src/App.tsx`);
    expect(res.status).toBe(200);
    const js = await res.text();
    const srcs = [...js.matchAll(/"data-glimpse-src":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.sort()).toEqual(
      ["src/App.tsx:4:10", "src/App.tsx:10:5", "src/App.tsx:11:7", "src/App.tsx:12:7", "src/App.tsx:13:9", "src/App.tsx:14:9", "src/App.tsx:15:9"].sort(),
    );
    // main.tsx only renders components (StrictMode, App): nothing to tag.
    const main = await (await fetch(`${fx.url}/preview/src/main.tsx`)).text();
    expect(main).not.toContain("data-glimpse-src");
  });

  it("serves the preview client as a hot module", async () => {
    const js = await (await fetch(`${fx.url}/preview/@glimpse/preview-client`)).text();
    expect(js).toContain("createHotContext");
    expect(js).toContain("glimpse:before-update");
  });

  it("answers Vite's HMR websocket on the shared http server", async () => {
    const hmr = await handshake(fx.port, "/preview/", "vite-hmr");
    expect(hmr.status).toBe(101);
    expect(JSON.parse(hmr.first!)).toEqual({ type: "connected" });
    expect(fx.upgrades.at(-1)).toMatchObject({ url: "/preview/", vite: true });
    // Everything else still meets Glimpse's handler, which drops it.
    expect((await handshake(fx.port, "/elsewhere", "vite-hmr")).status).toBe(0);
    expect((await handshake(fx.port, "/preview/")).status).toBe(0);
    expect(fx.upgrades.slice(-2).map((u) => u.vite)).toEqual([false, false]);
  });

  it("reports VITE_NOT_FOUND for a project without Vite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-novite-"));
    try {
      const err = await createReactPreview({ dir, httpServer: fx.server }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReactPreviewError);
      expect((err as ReactPreviewError).code).toBe("VITE_NOT_FOUND");
      expect((err as Error).message).toBe(`This React project doesn't use Vite or its dependencies aren't installed: run npm install in ${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("createReactPreview with the project's own settings", { timeout: 30_000 }, () => {
  it("keeps the HMR client on Glimpse's server whatever the project's hmr address settings say", async () => {
    const fx = await serveFixture("basic", {
      viteConfig: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { hmr: { clientPort: 443, host: "example.com", path: "/hmr" } } });
`,
    });
    try {
      const client = await (await fetch(`${fx.url}/preview/@vite/client`)).text();
      expect(client).not.toContain("443");
      expect(client).not.toContain("example.com");
      expect(client).toMatch(/const hmrPort = null/);
      expect((await handshake(fx.port, "/preview/", "vite-hmr")).status).toBe(101);
    } finally {
      await fx.close();
    }
  }, 60_000);

  it("reports source paths relative to the project when it is opened through a symlink", async () => {
    const fx = await serveFixture("basic", { viaLink: true });
    try {
      const js = await (await fetch(`${fx.url}/preview/src/App.tsx`)).text();
      const srcs = [...js.matchAll(/"data-glimpse-src":\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) expect(src).toMatch(/^src\/App\.tsx:/);
    } finally {
      await fx.close();
    }
  }, 60_000);
});
