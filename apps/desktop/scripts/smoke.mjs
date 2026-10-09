// Launch the real desktop app and check it end to end:
//   1. no folder argument → the home window opens (greeting, composer, folder chip, AI chip) and its preload API
//      answers (window.glimpse.recent(), aiInfo() without the API key)
//   2. a folder argument  → a Glimpse server starts for it (.glimpse/server.json), the project window loads the
//      editor from it, the folder lands in recent projects; closing the project windows brings the home window
//      back, and quitting stops the servers again.
//
//   node scripts/smoke.mjs              run the dev build (dist/, via the electron package)
//   node scripts/smoke.mjs --packaged   run the unpacked app from release/ (npm run dist -- --dir)
//   --screenshots <dir>                 save PNGs of the windows (needs Node 22+ for its WebSocket)
//
// On Linux run it under a display, e.g. `xvfb-run -a node scripts/smoke.mjs`. Only stops processes it started.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { packaged: { type: "boolean", default: false }, screenshots: { type: "string" } } });
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = resolve(desktopDir, "..", "..", "examples", "donut");
const work = mkdtempSync(join(tmpdir(), "glimpse-desktop-smoke-"));
const userData = join(work, "user-data");
const shots = values.screenshots ? resolve(values.screenshots) : undefined;
if (shots) mkdirSync(shots, { recursive: true });

const ok = (msg) => console.log(`  ✓ ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** [command, args before the folder] for the app under test. */
function appCommand() {
  if (!values.packaged) return [createRequire(import.meta.url)("electron"), [desktopDir]];
  const release = join(desktopDir, "release");
  const candidates =
    process.platform === "win32" ? [join(release, "win-unpacked", "Glimpse.exe"), join(release, "win-arm64-unpacked", "Glimpse.exe")]
    : process.platform === "darwin" ?
      readdirSync(release)
        .filter((d) => d.startsWith("mac"))
        .map((d) => join(release, d, "Glimpse.app", "Contents", "MacOS", "Glimpse"))
    : [join(release, "linux-unpacked", "glimpse-desktop"), join(release, "linux-arm64-unpacked", "glimpse-desktop")];
  const exe = candidates.find((p) => existsSync(p));
  assert(exe, `No unpacked app in ${release}; run \`npm run dist -- --dir\` first.`);
  return [exe, []];
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/** Start the app; resolves to { child, port, log() }. */
async function launch(extraArgs) {
  const [cmd, pre] = appCommand();
  const port = await freePort();
  const args = [...pre, `--remote-debugging-port=${port}`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extraArgs];
  const child = spawn(cmd, args, {
    env: { ...process.env, GLIMPSE_USER_DATA_DIR: userData, GLIMPSE_CONFIG_DIR: join(work, "config"), ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("error", (err) => (output += `\nspawn error: ${err.message}`));
  return { child, port, log: () => output };
}

/** Ask the app to quit the way the OS would (SIGTERM / WM_CLOSE) and wait for it to exit. */
async function quit(app, { force = false } = {}) {
  const { child } = app;
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
  else child.kill(force ? "SIGKILL" : "SIGTERM");
  const code = await Promise.race([exited, sleep(15_000).then(() => "timeout")]);
  if (code === "timeout" && !force) return quit(app, { force: true }).then(() => "timeout");
  return code;
}

async function waitFor(what, fn, app, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (app.child.exitCode !== null) throw new Error(`The app exited (${app.child.exitCode}) while waiting for ${what}.\n${app.log()}`);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.\n${app.log()}`);
}

/** DevTools targets of the running app (pages only). */
async function pages(app) {
  const res = await fetch(`http://127.0.0.1:${app.port}/json/list`);
  return (await res.json()).filter((t) => t.type === "page");
}

/** Minimal CDP client over the global WebSocket (Node 22+). */
async function cdp(target) {
  if (typeof WebSocket === "undefined") return undefined;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("CDP connection failed"));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      waiting.set(n, (msg) => (msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    async evaluate(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async screenshot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    close: () => ws.close(),
  };
}

const running = [];

async function main() {
  console.log(`glimpse-desktop smoke test (${values.packaged ? "packaged app" : "dev build"}) in ${work}`);

  step("launch without a folder → home window");
  const first = await launch([]);
  running.push(first);
  const launcherPage = await waitFor("the home window", async () => (await pages(first)).find((t) => t.url.endsWith("/launcher/index.html")), first);
  ok(`home loaded (${launcherPage.url.replace(/^.*\/dist\//, "dist/")})`);
  const launcherCdp = await cdp(launcherPage);
  if (launcherCdp) {
    const state = await waitFor(
      "the home window to render",
      () =>
        launcherCdp.evaluate(
          `(async () => {
            const $ = (s) => document.querySelector(s);
            if (!$("#version")?.textContent || $("#ai-label")?.textContent === "Checking AI…") return undefined;
            return {
              recent: await window.glimpse.recent(),
              ai: await window.glimpse.aiInfo(),
              folder: await window.glimpse.folder(),
              version: $("#version").textContent,
              greeting: $("#greeting").textContent,
              composer: !!$("textarea#prompt") && $("#prompt").placeholder,
              folderChip: $("#folder-name").textContent,
              target: $("#target-btn").textContent.trim(),
              ideas: document.querySelectorAll("#ideas .idea").length,
              aiLabel: $("#ai-label").textContent,
              send: !!$("#send"),
              width: window.innerWidth,
              node: typeof require,
            };
          })()`,
        ),
      first,
    );
    assert(Array.isArray(state.recent), "window.glimpse.recent() didn't return a list");
    assert(state.node === "undefined", "the home page can reach Node's require");
    ok(`preload API works (${state.version}, ${state.recent.length} recent projects); no Node globals in the page`);
    assert(/^(Up late|Morning|Afternoon|Evening), what are we building\?$/.test(state.greeting), `greeting: ${state.greeting}`);
    assert(state.composer === "Describe the UI you want…" && state.send, "no composer");
    assert(state.folderChip === "No folder" && state.folder === null, `folder chip: ${state.folderChip}`);
    assert(state.target === "Website" && state.ideas === 4, `target ${state.target}, ${state.ideas} ideas`);
    assert(state.ai && typeof state.ai.label === "string" && state.aiLabel === state.ai.label, `AI chip: ${JSON.stringify(state.ai)}`);
    assert(!("anthropicApiKey" in state.ai), "aiInfo() exposes the API key");
    assert(state.width >= 880, `home window is ${state.width}px wide`);
    ok(`home: "${state.greeting}", composer, folder chip "${state.folderChip}", target ${state.target}, AI chip "${state.aiLabel}" (${state.width}px wide)`);
    if (shots) {
      await sleep(300);
      await launcherCdp.screenshot(join(shots, "home.png"));
      ok(`screenshot ${join(shots, "home.png")}`);
      await launcherCdp.evaluate(`document.querySelector("#ai-chip").click()`);
      await sleep(400);
      await launcherCdp.screenshot(join(shots, "home-ai-settings.png"));
      ok(`screenshot ${join(shots, "home-ai-settings.png")}`);
    }
    launcherCdp.close();
  }
  const code1 = await quit(first);
  assert(code1 !== "timeout", "the app didn't quit on request");
  ok(`quit (exit ${code1})`);

  step("launch with a project folder → project window");
  const project = join(work, "donut");
  cpSync(example, project, { recursive: true });
  const second = await launch([project]);
  running.push(second);
  const info = await waitFor(
    ".glimpse/server.json",
    async () => {
      const i = JSON.parse(readFileSync(join(project, ".glimpse", "server.json"), "utf8"));
      return i.url ? i : undefined;
    },
    second,
  );
  ok(`Glimpse server for the folder at ${info.url} (pid ${info.pid} is the app)`);
  const home = await fetch(`${info.url}/`).then((r) => r.text());
  assert(home.includes('id="root"'), "GET / isn't the editor");
  const preview = await fetch(`${info.url}/preview/`).then((r) => r.text());
  assert(preview.includes("Donut Shop") && preview.includes("data-glimpse-src"), "GET /preview/ isn't the instrumented page");
  ok("server serves the editor and the instrumented preview");
  const editorPage = await waitFor("the project window", async () => (await pages(second)).find((t) => t.url.startsWith(info.url)), second);
  assert(/[?&]desktop=(mac|win|linux)/.test(editorPage.url), `editor URL lacks ?desktop=: ${editorPage.url}`);
  ok(`project window loaded ${editorPage.url}`);
  const editorCdp = await cdp(editorPage);
  if (editorCdp) {
    const state = await waitFor(
      "the editor to render",
      () =>
        editorCdp.evaluate(
          `document.documentElement.dataset.glimpseDesktop && document.querySelector("#root")?.children.length ? { desktop: document.documentElement.dataset.glimpseDesktop, node: typeof require, glimpse: typeof window.glimpse } : undefined`,
        ),
      second,
    );
    assert(state.node === "undefined" && state.glimpse === "undefined", "project window exposes Node or the launcher API");
    ok(`editor rendered with data-glimpse-desktop="${state.desktop}"; no Node, no launcher API in the page`);
    if (shots) {
      await sleep(1500);
      await editorCdp.screenshot(join(shots, "project.png"));
      ok(`screenshot ${join(shots, "project.png")}`);
    }
    editorCdp.close();
  }
  const recent = await waitFor(
    "recent-projects.json",
    async () => {
      const r = JSON.parse(readFileSync(join(userData, "recent-projects.json"), "utf8"));
      return r.projects?.length ? r : undefined;
    },
    second,
  );
  assert(recent.projects[0].name === "donut", `recent projects: ${JSON.stringify(recent)}`);
  ok(`recent projects: ${recent.projects.map((p) => p.name).join(", ")}`);

  step("second launch with another folder → handed to the running app (single instance)");
  const other = join(work, "other");
  cpSync(example, other, { recursive: true });
  const third = await launch([other]);
  running.push(third);
  const code3 = await Promise.race([new Promise((r) => third.child.once("exit", r)), sleep(30_000).then(() => "timeout")]);
  assert(code3 !== "timeout", "the second instance didn't exit");
  ok(`second instance exited (${code3})`);
  const info2 = await waitFor(
    "the running app to open the second folder",
    async () => {
      const i = JSON.parse(readFileSync(join(other, ".glimpse", "server.json"), "utf8"));
      return i.url ? i : undefined;
    },
    second,
  );
  assert(info2.pid === info.pid && info2.url !== info.url, `second folder: ${JSON.stringify(info2)}`);
  await waitFor("its window", async () => (await pages(second)).find((t) => t.url.startsWith(info2.url)), second);
  ok(`the running app opened it in a new window with its own server (${info2.url})`);

  step("close the project windows → the home window comes back");
  for (const url of [info.url, info2.url]) {
    const page = (await pages(second)).find((t) => t.url.startsWith(url));
    const c = page && (await cdp(page));
    if (!c) continue;
    // The page may go away before it answers.
    await Promise.race([c.evaluate("window.close(), true").catch(() => undefined), sleep(1500)]);
    c.close();
  }
  if (typeof WebSocket !== "undefined") {
    await waitFor("the home window", async () => (await pages(second)).find((t) => t.url.endsWith("/launcher/index.html")), second, 20_000);
    assert(!(await pages(second)).some((t) => t.url.startsWith(info.url) || t.url.startsWith(info2.url)), "a project window is still open");
    assert(second.child.exitCode === null, "the app quit when its last project window closed");
    ok("home window shown again after the last project window closed");
  }

  const code2 = await quit(second);
  assert(code2 !== "timeout", "the app didn't quit on request");
  for (const [dir, url] of [
    [project, info.url],
    [other, info2.url],
  ]) {
    assert(!existsSync(join(dir, ".glimpse", "server.json")), `${dir}/.glimpse/server.json is still there after quitting`);
    const down = await fetch(`${url}/api/session`).then(
      () => false,
      () => true,
    );
    assert(down, `the Glimpse server at ${url} still answers after quitting`);
  }
  ok(`quit (exit ${code2}): both servers stopped, their server.json files removed`);
  console.log("\nglimpse-desktop smoke test passed.");
}

try {
  await main();
} catch (err) {
  console.error(`\nglimpse-desktop smoke test FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  for (const app of running) await quit(app, { force: true });
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`(couldn't remove ${work}: ${err instanceof Error ? err.message : err})`);
  }
}
