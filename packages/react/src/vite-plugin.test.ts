import { describe, expect, it } from "vitest";
import { PREVIEW_CLIENT, PREVIEW_CLIENT_ID } from "./preview-client.js";
import { glimpseVitePlugin } from "./vite-plugin.js";

type Hook = (...args: unknown[]) => unknown;
const handlerOf = (hook: unknown): Hook => (typeof hook === "function" ? hook : (hook as { handler: Hook }).handler) as Hook;

describe("glimpseVitePlugin", () => {
  const plugin = glimpseVitePlugin({ root: "/proj" });
  const transform = (code: string, id: string) => handlerOf(plugin.transform).call({}, code, id) as { code: string } | null;

  it("runs first, and only in dev", () => {
    expect(plugin.enforce).toBe("pre");
    expect(plugin.apply).toBe("serve");
    expect((plugin.transform as { order?: string }).order).toBe("pre");
  });

  it("tags JSX in project files with paths relative to the root", () => {
    expect(transform("export const A = () => <b>x</b>;\n", "/proj/src/A.tsx")?.code).toContain('<b data-glimpse-src="src/A.tsx:1:24">');
    expect(transform("export const A = () => <b>x</b>;\n", "/proj/src/A.jsx?v=123")?.code).toContain('data-glimpse-src="src/A.jsx:1:24"');
  });

  it("leaves dependencies, virtual modules, raw imports and other files alone", () => {
    const code = "export const A = () => <b>x</b>;\n";
    expect(transform(code, "/proj/node_modules/lib/A.jsx")).toBeNull();
    expect(transform(code, "\0virtual:thing.jsx")).toBeNull();
    expect(transform(code, "/proj/src/A.tsx?raw")).toBeNull();
    expect(transform(code, "/proj/src/A.css")).toBeNull();
    expect(transform("export const a = 1;\n", "/proj/src/a.ts")).toBeNull();
  });

  it("serves the preview client and adds it to index.html", () => {
    expect(handlerOf(plugin.resolveId).call({}, PREVIEW_CLIENT_ID)).toBe(PREVIEW_CLIENT_ID);
    expect(handlerOf(plugin.resolveId).call({}, "/src/main.tsx")).toBeNull();
    expect(handlerOf(plugin.load).call({}, PREVIEW_CLIENT_ID)).toBe(PREVIEW_CLIENT);
    expect((plugin.transformIndexHtml as { order?: string }).order).toBe("pre");
    expect(handlerOf(plugin.transformIndexHtml).call({}, "<html></html>", {})).toEqual([
      { tag: "script", attrs: { type: "module", src: PREVIEW_CLIENT_ID }, injectTo: "head-prepend" },
    ]);
    const quiet = glimpseVitePlugin({ client: false });
    expect(handlerOf(quiet.transformIndexHtml).call({}, "<html></html>", {})).toEqual([]);
    expect(handlerOf(quiet.resolveId).call({}, PREVIEW_CLIENT_ID)).toBeNull();
  });
});
