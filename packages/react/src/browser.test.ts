import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type ServedFixture } from "./serve-fixture.test-helper.js";

/**
 * End to end in a real browser. Needs the Playwright install of the Linux dev
 * container; skipped anywhere else (CI on macOS and Windows).
 */
const PLAYWRIGHT = "/opt/node22/lib/node_modules/playwright/index.mjs";
const hasPlaywright = existsSync(PLAYWRIGHT);

/* Minimal slices of Playwright's API, so this file needs no Playwright types. */
interface PwPage {
  goto(url: string): Promise<unknown>;
  on(event: "websocket", fn: (ws: { url(): string; isClosed(): boolean }) => void): void;
  on(event: "console" | "pageerror", fn: (msg: unknown) => void): void;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  click(selector: string): Promise<void>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

describe.skipIf(!hasPlaywright)("React preview in Chromium", { timeout: 60_000 }, () => {
  let fx: ServedFixture;
  let browser: PwBrowser;
  let page: PwPage;
  const sockets: string[] = [];
  const errors: string[] = [];

  beforeAll(async () => {
    fx = await serveFixture("basic");
    const { chromium } = (await import(pathToFileURL(PLAYWRIGHT).href)) as { chromium: { launch(): Promise<PwBrowser> } };
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on("websocket", (ws) => sockets.push(ws.url()));
    page.on("pageerror", (err) => errors.push(String(err)));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fx?.close();
  });

  it("renders host elements with their source locations", async () => {
    await page.goto(`${fx.url}/preview/`);
    await page.waitForFunction("window.__glimpsePreview && window.__glimpsePreview.ready", undefined, { timeout: 30_000 });
    const srcs = await page.evaluate<string[]>(`[...document.querySelectorAll("button")].map((b) => b.getAttribute("data-glimpse-src"))`);
    expect(srcs).toEqual(["src/App.tsx:13:9", "src/App.tsx:14:9", "src/App.tsx:15:9"]);
    // A component's own host element points into the component, not at its call site.
    expect(await page.evaluate<string>(`document.querySelector(".badge").getAttribute("data-glimpse-src")`)).toBe("src/App.tsx:4:10");
    expect(await page.evaluate<string | null>(`document.getElementById("root").getAttribute("data-glimpse-src")`)).toBeNull();
  }, 60_000);

  it("connects Vite's HMR websocket through the shared http server", async () => {
    await page.waitForFunction(
      `performance.getEntriesByType("resource").some((e) => e.name.includes("/preview/@vite/client"))`,
      undefined,
      { timeout: 10_000 },
    );
    expect(sockets.some((u) => u.startsWith(`ws://127.0.0.1:${fx.port}/preview/?token=`))).toBe(true);
    expect(fx.upgrades.some((u) => u.vite && u.protocol === "vite-hmr" && u.url.startsWith("/preview/?token="))).toBe(true);
  });

  it("applies an edit on disk with HMR: no reload, state kept, locations updated", async () => {
    await page.evaluate(`(() => {
      window.__sameDocument = true;
      window.__events = [];
      for (const name of ["glimpse:before-update", "glimpse:after-update"]) {
        // Records whether React had already changed the DOM when the event fired.
        addEventListener(name, () => window.__events.push(name + (document.body.textContent.includes("Honey glazed") ? ":changed" : ":pristine")));
      }
      addEventListener("message", (e) => e.data && e.data.glimpse && window.__events.push("message:" + e.data.glimpse));
    })()`);
    await page.click("text=Clicked 0");
    await page.waitForFunction(`document.body.textContent.includes("Clicked 1")`);

    const file = join(fx.dir, "src", "App.tsx");
    const before = await readFile(file, "utf8");
    const after = before
      .replace(">Glazed<", ">Honey glazed<")
      .replace('        <button className="btn">Chocolate</button>\n', '        <button className="btn">Chocolate</button>\n        <button className="btn">Sprinkles</button>\n');
    expect(after).not.toBe(before);
    await writeFile(file, after);

    await page.waitForFunction(`document.querySelectorAll("button").length === 4 && document.body.textContent.includes("Honey glazed")`, undefined, {
      timeout: 20_000,
    });
    await page.waitForFunction(`window.__events.includes("message:morphed")`, undefined, { timeout: 5_000 });

    expect(await page.evaluate<boolean>("window.__sameDocument === true")).toBe(true);
    expect(await page.evaluate<boolean>(`document.body.textContent.includes("Clicked 1")`)).toBe(true);
    const srcs = await page.evaluate<string[]>(`[...document.querySelectorAll("button")].map((b) => b.getAttribute("data-glimpse-src"))`);
    expect(srcs).toEqual(["src/App.tsx:13:9", "src/App.tsx:14:9", "src/App.tsx:15:9", "src/App.tsx:16:9"]);
    // before-update fires while the DOM is still what React rendered, after-update once the change is in.
    const events = await page.evaluate<string[]>("window.__events");
    expect(events.filter((e) => e !== "message:ready")).toEqual(["glimpse:before-update:pristine", "glimpse:after-update:changed", "message:morphed"]);
    expect(errors).toEqual([]);
  }, 60_000);

  it("stays consistent when the editor undoes its own DOM edits on glimpse:before-update", async () => {
    // The editor previews deleting "Sprinkles" by removing it from the DOM, and
    // puts it back when Vite is about to apply an update, as the editor must.
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Sprinkles");
      const parent = btn.parentNode, next = btn.nextSibling;
      btn.remove();
      addEventListener("glimpse:before-update", () => btn.isConnected || parent.insertBefore(btn, next), { once: true });
      window.__updates = 0;
      addEventListener("glimpse:after-update", () => window.__updates++);
    })()`);
    // Edit source then deletes it for real. (Without the revert, React removes the wrong node and the page silently loses "Clicked 1".)
    const file = join(fx.dir, "src", "App.tsx");
    await writeFile(file, (await readFile(file, "utf8")).replace('        <button className="btn">Sprinkles</button>\n', ""));
    await page.waitForFunction("window.__updates > 0", undefined, { timeout: 20_000 });
    const texts = await page.evaluate<string[]>(`[...document.querySelectorAll("button")].map((b) => b.textContent)`);
    expect(texts).toEqual(["Honey glazed", "Chocolate", "Clicked 1"]);
    expect(await page.evaluate<boolean>("window.__sameDocument === true")).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);
});
