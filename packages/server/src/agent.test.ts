import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { claudeArgs, createProjectTools, resolveEngine, withInstructions } from "./agent-runner.js";
import {
  clearOllamaCache,
  detectAgents,
  detectOllama,
  findExecutable,
  loadAgentSettings,
  normalizeBaseUrl,
  resolveApiKey,
  saveAgentSettings,
  settingsPath,
  validateSettingsPatch,
} from "./agent-settings.js";
import { startServer, type GlimpseServer } from "./index.js";

const isWindows = process.platform === "win32";
const API_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];
const ENV_KEYS = ["GLIMPSE_CONFIG_DIR", "GLIMPSE_AGENT_CLAUDE_BIN", "GLIMPSE_AGENT_CODEX_BIN", ...API_ENV, "FAKE_MODE", "FAKE_LOG"];

/** The settings with nothing chosen, plus `over`. */
const settings = (over: Record<string, unknown> = {}, api: Record<string, unknown> = {}) => ({
  engine: "auto",
  quality: "balanced",
  allowCommands: false,
  maxSteps: 40,
  ...over,
  api: { provider: "anthropic", keys: {}, ...api },
});

let tmp: string;
let dir: string;
let savedEnv: Record<string, string | undefined>;
let srv: GlimpseServer | undefined;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = await mkdtemp(join(tmpdir(), "glimpse-agent-"));
  dir = join(tmp, "project");
  await mkdir(dir);
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><p>Hi</p></body></html>");
  process.env.GLIMPSE_CONFIG_DIR = join(tmp, "config");
  process.env.GLIMPSE_AGENT_CLAUDE_BIN = join(tmp, "no-claude");
  process.env.GLIMPSE_AGENT_CODEX_BIN = join(tmp, "no-codex");
  process.env.FAKE_LOG = join(tmp, "fake.log");
  for (const k of API_ENV) delete process.env[k];
  delete process.env.FAKE_MODE;
  clearOllamaCache();
});

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tmp, { recursive: true, force: true });
});

/** A stand-in for the claude CLI: logs how it was started, prints stream-json, writes index.html. */
async function fakeClaude(): Promise<string> {
  const bin = join(tmp, isWindows ? "claude.cmd" : "claude");
  const script = join(tmp, "fake-claude.cjs");
  await writeFile(
    script,
    `const fs = require("fs"), path = require("path"), cp = require("child_process");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input }));
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  out({ type: "system", subtype: "init" });
  if (process.env.FAKE_MODE === "sleep") {
    const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_LOG + ".pids", JSON.stringify([process.pid, child.pid]));
    out({ type: "assistant", message: { content: [{ type: "text", text: "Thinking for a long time" }] } });
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.FAKE_MODE === "auth") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" });
    process.exitCode = 1;
    return;
  }
  if (process.env.FAKE_MODE === "fail") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Something broke" });
    return;
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Building the page" }, { type: "tool_use", name: "Write", input: { file_path: path.join(process.cwd(), "index.html") } }] } });
  fs.writeFileSync("index.html", "<h1>Built</h1>");
  out({ type: "result", subtype: "success", is_error: false, result: "Made a page" });
});
`,
  );
  await writeFile(bin, isWindows ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(bin, 0o755);
  process.env.GLIMPSE_AGENT_CLAUDE_BIN = bin;
  return bin;
}

/** A stand-in for a Codex whose `exec` has no --skip-git-repo-check and rejects unknown options like clap does. */
async function fakeCodex(): Promise<string> {
  const bin = join(tmp, isWindows ? "codex.cmd" : "codex");
  const script = join(tmp, "fake-codex.cjs");
  await writeFile(
    script,
    `const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "--help") {
  console.log("Run Codex non-interactively\\n\\nUsage: codex exec [OPTIONS] [PROMPT]\\n\\nArguments:\\n  [PROMPT]  Initial instructions. If not provided as an argument (or if \\\`-\\\` is used), instructions are read from stdin\\n\\nOptions:\\n      --full-auto  Low-friction sandboxed automatic execution");
  process.exit(0);
}
const bad = args.slice(1).find((a) => a.startsWith("--") && a !== "--full-auto");
if (args[0] !== "exec" || bad) {
  console.error("error: unexpected argument '" + bad + "' found\\n\\nUsage: codex exec [OPTIONS] [PROMPT]\\n\\nFor more information, try '--help'.");
  process.exit(2);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }));
  console.log("codex: writing index.html");
  fs.writeFileSync("index.html", "<h1>By Codex</h1>");
});
`,
  );
  await writeFile(bin, isWindows ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(bin, 0o755);
  process.env.GLIMPSE_AGENT_CODEX_BIN = bin;
  return bin;
}

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv!.url}${path}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });

/** Collects the websocket messages of one editor connection. */
async function editor(): Promise<{ messages: { type: string; [k: string]: unknown }[]; until: (pred: (m: { type: string; [k: string]: unknown }) => boolean, ms?: number) => Promise<{ type: string; [k: string]: unknown }>; close: () => void }> {
  const ws = new WebSocket(`${srv!.url.replace("http", "ws")}/__glimpse/ws`);
  const messages: { type: string; [k: string]: unknown }[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)));
    for (const l of listeners) l();
  });
  await new Promise((ok) => ws.once("open", ok));
  const until = (pred: (m: { type: string; [k: string]: unknown }) => boolean, ms = 10_000) =>
    new Promise<{ type: string; [k: string]: unknown }>((ok, fail) => {
      const check = () => {
        const m = messages.find(pred);
        if (!m) return;
        listeners.delete(check);
        clearTimeout(timer);
        ok(m);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        fail(new Error(`timed out; got ${JSON.stringify(messages.map((x) => x.type))}`));
      }, ms);
      listeners.add(check);
      check();
    });
  // The server sends every event after the hello (it registers the socket once that is out).
  await until((m) => m.type === "hello");
  return { messages, until, close: () => ws.close() };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("agent settings", () => {
  it("defaults when the file is missing or broken, and saves patches with mode 0600", async () => {
    expect(await loadAgentSettings()).toEqual(settings());
    await mkdir(process.env.GLIMPSE_CONFIG_DIR!, { recursive: true });
    await writeFile(settingsPath(), "{not json");
    expect(await loadAgentSettings()).toEqual(settings());
    await writeFile(settingsPath(), JSON.stringify({ engine: "bogus", other: 1, quality: "max", maxSteps: 0, api: { provider: "nope", keys: { openai: "has space" } } }));
    expect(await loadAgentSettings()).toEqual(settings());

    expect(await saveAgentSettings({ engine: "codex", anthropicApiKey: " sk-ant-test " })).toEqual(settings({ engine: "codex" }, { keys: { anthropic: "sk-ant-test" } }));
    expect(await loadAgentSettings()).toEqual(settings({ engine: "codex" }, { keys: { anthropic: "sk-ant-test" } }));
    const raw = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(raw.other).toBe(1); // unknown keys are kept
    expect(raw.anthropicApiKey).toBeUndefined();
    if (!isWindows) expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);

    expect(await saveAgentSettings({ engine: "api" })).toEqual(settings({ engine: "api" }, { keys: { anthropic: "sk-ant-test" } }));
    expect(await saveAgentSettings({ anthropicApiKey: null })).toEqual(settings({ engine: "api" }));
    await expect(saveAgentSettings({ engine: "nope" as never })).rejects.toThrow(/Unknown engine/);
  });

  it("detects the CLIs and the API key", async () => {
    expect(await detectAgents()).toEqual({ claude: false, codex: false, api: false });
    await fakeClaude();
    expect(await detectAgents()).toMatchObject({ claude: true, codex: false, api: false });
    process.env.ANTHROPIC_API_KEY = "sk-env";
    expect((await detectAgents()).api).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    await saveAgentSettings({ anthropicApiKey: "sk-file" });
    expect((await detectAgents()).api).toBe(true);
  });

  it.skipIf(isWindows)("finds executables on PATH", async () => {
    const bin = join(tmp, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "glimpse-fake-agent"), "#!/bin/sh\n");
    await writeFile(join(bin, "glimpse-not-executable"), "");
    await chmod(join(bin, "glimpse-fake-agent"), 0o755);
    expect(findExecutable("glimpse-fake-agent", { PATH: bin })).toBe(join(bin, "glimpse-fake-agent"));
    expect(findExecutable("glimpse-not-executable", { PATH: bin })).toBeUndefined();
    expect(findExecutable("glimpse-missing-agent", { PATH: bin })).toBeUndefined();
  });

  it("resolves the engine: an external agent, then Claude Code, Codex, the API", () => {
    const none = { claude: false, codex: false, api: false };
    const all = { claude: true, codex: true, api: true };
    expect(resolveEngine("auto", all, true)).toBe("external");
    expect(resolveEngine("auto", all, false)).toBe("claude");
    expect(resolveEngine("auto", { ...none, codex: true, api: true }, false)).toBe("codex");
    expect(resolveEngine("auto", { ...none, api: true }, false)).toBe("api");
    expect(resolveEngine("auto", none, false)).toBe("none");
    expect(resolveEngine("codex", all, false)).toBe("codex");
    expect(resolveEngine("codex", none, false)).toBe("none");
    expect(resolveEngine("api", all, true)).toBe("external");
    expect(resolveEngine("external", all, false)).toBe("external");
  });
});

describe("built-in agent", () => {
  it("runs Claude Code for a request and streams its progress", async () => {
    await fakeClaude();
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    const hello = ed.messages[0] ?? (await ed.until((m) => m.type === "hello"));
    expect(hello).toMatchObject({ type: "hello", agentInfo: { engine: "claude", preferred: "auto", running: null, queued: 0 }, agentRun: null });
    expect((hello.agentInfo as { available: unknown }).available).toEqual({ claude: true, codex: false, api: false, external: false });

    const res = await post("/api/request", { text: "Make a landing page" });
    expect(res.status).toBe(200);
    const done = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(done).toMatchObject({ event: "done", engine: "claude", text: "Made a page" });

    const runEvents = ed.messages.filter((m) => m.type === "agent-run");
    expect(runEvents.map((m) => m.event)).toEqual(["start", "output", "output", "done"]);
    expect(runEvents.map((m) => m.text).slice(1, 3)).toEqual(["Building the page", "Editing index.html"]);
    const types = ed.messages.map((m) => m.type);
    expect(types.indexOf("handoff")).toBeLessThan(types.indexOf("handoff-delivered"));
    expect(types.indexOf("handoff-delivered")).toBeLessThan(types.indexOf("agent-run"));
    expect(types).toContain("agent-info");

    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>Built</h1>");
    const log = JSON.parse(await readFile(process.env.FAKE_LOG!, "utf8"));
    expect(log.args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    expect(await realpath(log.cwd)).toBe(await realpath(dir));
    expect(log.input).toContain("Make a landing page");
    expect(log.input).toContain("running inside Glimpse");
    expect(log.input).not.toContain("glimpse wait /");

    const { handoffs } = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: { kind: string; delivered: boolean }[] };
    expect(handoffs[0]).toMatchObject({ kind: "request", delivered: true });
    const info = await (await fetch(`${srv.url}/api/agent`)).json();
    expect(info).toMatchObject({ engine: "claude", running: null, queued: 0 });
    const session = await (await fetch(`${srv.url}/api/session`)).json();
    expect(session).toMatchObject({ agentInfo: { engine: "claude" }, agentRun: null });
    ed.close();
  }, 20_000);

  it("reports a failed run", async () => {
    await fakeClaude();
    process.env.FAKE_MODE = "fail";
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Break it" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "error", text: "Something broke" });
    ed.close();
  }, 20_000);

  it("runs Codex with the options its version has", async () => {
    await fakeCodex();
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Make a landing page" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "done", engine: "codex" });
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>By Codex</h1>");
    const log = JSON.parse(await readFile(process.env.FAKE_LOG!, "utf8")) as { args: string[]; input: string };
    expect(log.args.slice(0, 2)).toEqual(["exec", "--full-auto"]);
    expect(log.args).not.toContain("--skip-git-repo-check");
    expect(isWindows ? log.input : log.args[2]).toContain("Make a landing page");
    ed.close();
  }, 20_000);

  it("explains an expired Claude Code sign-in and lets auto fall back to Codex", async () => {
    await fakeClaude();
    await fakeCodex();
    process.env.FAKE_MODE = "auth";
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Make a landing page" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error") && m.engine === "codex");
    expect(end).toMatchObject({ event: "done", engine: "codex" });
    const texts = ed.messages.filter((m) => m.type === "agent-run").map((m) => m.text);
    expect(texts).toContain("Claude Code isn't signed in, trying Codex…");
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>By Codex</h1>");
    // Claude Code is skipped for a while, until the settings change.
    expect(await (await fetch(`${srv.url}/api/agent`)).json()).toMatchObject({ engine: "codex" });

    // Chosen explicitly, the sign-in error says what to do.
    await post("/api/agent/settings", { engine: "claude" });
    const before = ed.messages.length;
    await post("/api/request", { text: "Again" });
    const err = await ed.until((m) => ed.messages.indexOf(m) >= before && m.type === "agent-run" && m.event === "error");
    expect(String(err.text)).toContain("run `claude` and type /login");
    ed.close();
  }, 30_000);

  it.skipIf(isWindows)("stops a run and its whole process tree", async () => {
    await fakeClaude();
    process.env.FAKE_MODE = "sleep";
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Take forever" });
    await ed.until((m) => m.type === "agent-run" && m.event === "output");
    const running = (await (await fetch(`${srv.url}/api/agent`)).json()) as { running: { engine: string } | null };
    expect(running.running).toMatchObject({ engine: "claude" });
    const session = (await (await fetch(`${srv.url}/api/session`)).json()) as { agentRun: { output: string[] } | null };
    expect(session.agentRun?.output).toEqual(["Thinking for a long time"]);
    const pids = JSON.parse(await readFile(`${process.env.FAKE_LOG}.pids`, "utf8")) as number[];
    expect(pids.every(alive)).toBe(true);

    expect(await (await post("/api/agent/stop", {})).json()).toEqual({ ok: true });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "error", text: "Stopped" });
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(pids.some(alive)).toBe(false);
    expect(((await (await fetch(`${srv.url}/api/agent`)).json()) as { running: unknown }).running).toBeNull();
    ed.close();
  }, 20_000);

  it("leaves requests to an external agent that is waiting", async () => {
    await fakeClaude();
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    const waiting = srv.nextHandoff(undefined, 5000);
    expect(await (await fetch(`${srv.url}/api/agent`)).json()).toMatchObject({ engine: "external", available: { external: true, claude: true } });
    await post("/api/request", { text: "For the external agent" });
    const h = await waiting;
    expect(h?.request?.text).toBe("For the external agent");
    await new Promise((r) => setTimeout(r, 400));
    expect(ed.messages.some((m) => m.type === "agent-run")).toBe(false);
    expect(existsSync(process.env.FAKE_LOG!)).toBe(false);
    ed.close();
  }, 20_000);

  it("doesn't run anything when no engine is available or the engine is external", async () => {
    srv = await startServer({ dir, port: 0 });
    expect(await (await fetch(`${srv.url}/api/agent`)).json()).toMatchObject({ engine: "none", preferred: "auto", running: null });
    const res = (await (await post("/api/request", { text: "Nobody listens" })).json()) as { seq: number; delivered: boolean };
    expect(res.delivered).toBe(false);
    // An external agent that connects later still gets it.
    expect((await srv.nextHandoff(undefined, 1000))?.seq).toBe(res.seq);

    await fakeClaude();
    const info = await (await post("/api/agent/settings", { engine: "external" })).json();
    expect(info).toMatchObject({ engine: "external", preferred: "external", available: { claude: true } });
    const ed = await editor();
    await post("/api/request", { text: "Still for the external agent" });
    await new Promise((r) => setTimeout(r, 400));
    expect(ed.messages.some((m) => m.type === "agent-run")).toBe(false);

    // Choosing an engine runs what waited.
    await post("/api/agent/settings", { engine: "claude" });
    expect(await ed.until((m) => m.type === "agent-run" && m.event === "done")).toMatchObject({ engine: "claude" });
    ed.close();
  }, 20_000);

  it("guards the settings endpoint and never returns the key", async () => {
    srv = await startServer({ dir, port: 0 });
    expect((await post("/api/agent/settings", { engine: "claude" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/agent/stop", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/agent/settings", { engine: "bogus" })).status).toBe(400);
    expect((await post("/api/agent/settings", { anthropicApiKey: "has space" })).status).toBe(400);
    expect((await post("/api/agent/settings", { anthropicApiKey: 42 })).status).toBe(400);
    expect((await post("/api/agent/settings", [])).status).toBe(400);
    expect(await loadAgentSettings()).toEqual(settings());

    const ed = await editor();
    const res = await post("/api/agent/settings", { engine: "external", anthropicApiKey: "sk-ant-secret-123" });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk-ant-secret");
    expect(JSON.parse(text)).toMatchObject({ preferred: "external", available: { api: true } });
    const broadcastInfo = await ed.until((m) => m.type === "agent-info" && (m.info as { preferred: string }).preferred === "external");
    expect(JSON.stringify(broadcastInfo)).not.toContain("sk-ant-secret");
    expect(await loadAgentSettings()).toEqual(settings({ engine: "external" }, { keys: { anthropic: "sk-ant-secret-123" } }));
    if (!isWindows) expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
    expect(await (await post("/api/agent/settings", { anthropicApiKey: null })).json()).toMatchObject({ available: { api: false } });
    expect(await (await post("/api/agent/stop", {})).json()).toEqual({ ok: true });
    ed.close();
  }, 20_000);
});

describe("API engine", () => {
  let api: Server;
  let requests: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[];
  let reply: (n: number) => { status: number; events?: [string, unknown][] ; body?: unknown };

  beforeEach(async () => {
    requests = [];
    api = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
        const r = reply(requests.length);
        if (!r.events) {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [event, data] of r.events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((ok) => api.listen(0, "127.0.0.1", () => ok()));
    const addr = api.address() as { port: number };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
    await saveAgentSettings({ engine: "api", anthropicApiKey: "sk-ant-test-key" });
  });

  afterEach(async () => {
    await new Promise<void>((ok) => api.close(() => ok()));
  });

  const message = (stopReason: string, blocks: [string, unknown, unknown[]][]): [string, unknown][] => [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ...blocks.flatMap(([, start, deltas], index): [string, unknown][] => [
      ["content_block_start", { type: "content_block_start", index, content_block: start }],
      ...deltas.map((delta): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index, delta }]),
      ["content_block_stop", { type: "content_block_stop", index }],
    ]),
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ];

  it("runs the tool loop against the Messages API", async () => {
    reply = (n) =>
      n === 1
        ? {
            status: 200,
            events: message("tool_use", [
              ["text", { type: "text", text: "" }, [{ type: "text_delta", text: "Writing the page\n" }]],
              [
                "tool",
                { type: "tool_use", id: "toolu_1", name: "write_file", input: {} },
                [{ type: "input_json_delta", partial_json: JSON.stringify({ path: "index.html", contents: "<h1>From the API</h1>" }) }],
              ],
            ]),
          }
        : { status: 200, events: message("end_turn", [["text", { type: "text", text: "" }, [{ type: "text_delta", text: "Made the page." }]]]) };
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "A page from the API" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "done", engine: "api", text: "Made the page." });
    expect(ed.messages.filter((m) => m.type === "agent-run" && m.event === "output").map((m) => m.text)).toEqual(["Writing the page", "Editing index.html", "Made the page."]);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>From the API</h1>");

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first!.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(String(first!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(first!.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 64000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, fallbacks: "default", stream: true });
    expect((first!.body.tools as { name: string; eager_input_streaming: boolean }[]).map((t) => [t.name, t.eager_input_streaming])).toEqual([
      ["list_files", true],
      ["read_file", true],
      ["write_file", true],
      ["delete_file", true],
    ]);
    const msgs = second!.body.messages as { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean }[] }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(msgs[2]!.content[0]!.is_error).toBeUndefined();
    ed.close();
  }, 20_000);

  it("uses the chosen model and maps the quality to its effort", async () => {
    const done = { status: 200, events: message("end_turn", [["text", { type: "text", text: "" }, [{ type: "text_delta", text: "Done." }]]]) };
    reply = () => done;
    await saveAgentSettings({ quality: "best", api: { model: "claude-sonnet-5-5" } });
    srv = await startServer({ dir, port: 0 });
    let ed = await editor();
    await post("/api/request", { text: "One" });
    await ed.until((m) => m.type === "agent-run" && m.event === "done");
    expect(ed.messages.find((m) => m.type === "agent-run" && m.event === "start")).toMatchObject({ text: "Claude API · claude-sonnet-5-5" });
    expect(requests[0]!.body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "high" } });
    ed.close();
    await srv.close();
    srv = undefined;

    await saveAgentSettings({ quality: "fast", api: { model: "claude-haiku-5-5" } });
    srv = await startServer({ dir, port: 0 });
    ed = await editor();
    await post("/api/request", { text: "Two" });
    await ed.until((m) => m.type === "agent-run" && m.event === "done");
    expect(requests[1]!.body).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "adaptive" } });
    expect(requests[1]!.body.output_config).toBeUndefined();
    ed.close();
  }, 20_000);

  it("explains a rejected key", async () => {
    reply = () => ({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Anything" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "error", engine: "api", text: "The API key was rejected" });
    ed.close();
  }, 20_000);

  it("stops on a refusal without running its tools", async () => {
    reply = () => ({
      status: 200,
      events: message("refusal", [["tool", { type: "tool_use", id: "toolu_1", name: "write_file", input: {} }, [{ type: "input_json_delta", partial_json: '{"path":"index.html","contents":"x"}' }]]]),
    });
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "Anything" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "error", text: "The model declined this request" });
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<p>Hi</p>");
    ed.close();
  }, 20_000);
});

describe("project tools of the API engine", () => {
  it("read, write, list and delete inside the project", async () => {
    const tools = createProjectTools(dir);
    expect(await tools.run("write_file", { path: "src/app.js", contents: "console.log(1)" })).toMatchObject({ isError: false, activity: "Editing src/app.js" });
    expect(await tools.run("read_file", { path: "src/app.js" })).toMatchObject({ isError: false, content: "console.log(1)", activity: "Reading src/app.js" });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "a.js"), "");
    await writeFile(join(dir, ".env"), "SECRET=1");
    expect((await tools.run("list_files", {})).content.split("\n")).toEqual(["index.html", "src/app.js"]);
    expect((await tools.run("list_files", { dir: "src" })).content).toBe("src/app.js");
    expect(await tools.run("delete_file", { path: "src/app.js" })).toMatchObject({ isError: false, activity: "Deleting src/app.js" });
    expect(existsSync(join(dir, "src", "app.js"))).toBe(false);
    expect(await tools.run("read_file", { path: "missing.txt" })).toMatchObject({ isError: true });
    expect(await tools.run("write_file", { path: "a.txt" })).toMatchObject({ isError: true });
    expect((await tools.run("write_file", { path: "a.txt" })).content).toContain("INVALID_INPUT");
    expect(await tools.run("nope", {})).toMatchObject({ isError: true });
  });

  it("refuses paths outside the project, dotfiles, Glimpse's state and node_modules writes", async () => {
    const tools = createProjectTools(dir);
    await writeFile(join(tmp, "outside.txt"), "outside");
    await writeFile(join(dir, ".env"), "SECRET=1");
    for (const path of ["../outside.txt", "a/../../outside.txt", join(tmp, "outside.txt"), "/etc/passwd", "C:\\Windows\\win.ini", ".env", ".git/config", ".glimpse/server.json", "src/.secret"]) {
      expect(await tools.run("read_file", { path }), path).toMatchObject({ isError: true });
      expect(await tools.run("write_file", { path, contents: "x" }), path).toMatchObject({ isError: true });
    }
    expect(await tools.run("write_file", { path: "node_modules/x/index.js", contents: "x" })).toMatchObject({ isError: true });
    expect(await tools.run("list_files", { dir: ".." })).toMatchObject({ isError: true });
    expect(await readFile(join(tmp, "outside.txt"), "utf8")).toBe("outside");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it.skipIf(isWindows)("refuses symlinks that lead out of the project", async () => {
    const tools = createProjectTools(dir);
    const outside = join(tmp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(dir, "linked"));
    await symlink(join(outside, "secret.txt"), join(dir, "secret-link.txt"));
    expect(await tools.run("read_file", { path: "linked/secret.txt" })).toMatchObject({ isError: true });
    expect(await tools.run("write_file", { path: "linked/new.txt", contents: "x" })).toMatchObject({ isError: true });
    expect(await tools.run("read_file", { path: "secret-link.txt" })).toMatchObject({ isError: true });
    expect(await tools.run("write_file", { path: "secret-link.txt", contents: "x" })).toMatchObject({ isError: true });
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("lets a variants run write only its own variants folder", async () => {
    const tools = createProjectTools(dir, { variantsDir: ".glimpse/variants/abc" });
    expect(await tools.run("write_file", { path: ".glimpse/variants/abc/1/index.html", contents: "v1" })).toMatchObject({ isError: false });
    expect(await readFile(join(dir, ".glimpse", "variants", "abc", "1", "index.html"), "utf8")).toBe("v1");
    expect(await tools.run("write_file", { path: ".glimpse/variants/other/1/index.html", contents: "x" })).toMatchObject({ isError: true });
    expect(await tools.run("write_file", { path: ".glimpse/server.json", contents: "x" })).toMatchObject({ isError: true });
    expect(await tools.run("write_file", { path: ".glimpse/variants/abc/../../server.json", contents: "x" })).toMatchObject({ isError: true });
    expect((await tools.run("list_files", { dir: ".glimpse/variants/abc" })).content).toBe(".glimpse/variants/abc/1/index.html");
  });
});


describe("provider settings", () => {
  it("migrates an old file's Anthropic key and keeps it out of the new file", async () => {
    await mkdir(process.env.GLIMPSE_CONFIG_DIR!, { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ engine: "api", anthropicApiKey: "sk-ant-old", other: true }));
    expect(await loadAgentSettings()).toEqual(settings({ engine: "api" }, { keys: { anthropic: "sk-ant-old" } }));
    await saveAgentSettings({ api: { provider: "openai", keys: { openai: "sk-openai" } }, quality: "best", maxSteps: 12, customInstructions: "  Use Tailwind  " });
    const raw = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(raw).toEqual({
      engine: "api",
      other: true,
      api: { provider: "openai", keys: { anthropic: "sk-ant-old", openai: "sk-openai" } },
      quality: "best",
      maxSteps: 12,
      customInstructions: "Use Tailwind",
    });
    if (!isWindows) expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
    const s = await saveAgentSettings({ api: { model: "gpt-5-mini", keys: { anthropic: null } }, customInstructions: null, allowCommands: true });
    expect(s).toEqual(settings({ engine: "api", quality: "best", maxSteps: 12, allowCommands: true }, { provider: "openai", model: "gpt-5-mini", keys: { openai: "sk-openai" } }));
    expect((await saveAgentSettings({ api: { model: null } })).api.model).toBeUndefined();
  });

  it("validates a settings change strictly", () => {
    const bad = [
      [],
      "x",
      { nope: 1 },
      { engine: "gpt" },
      { anthropicApiKey: "has space" },
      { api: [] },
      { api: { provider: "mistral" } },
      { api: { other: 1 } },
      { api: { keys: { ollama: "x" } } },
      { api: { keys: { openai: "" } } },
      { api: { keys: { gemini: "x".repeat(401) } } },
      { api: { keys: { openai: 5 } } },
      { api: { model: "two words" } },
      { api: { baseUrl: "http://example.com:11434" } },
      { api: { baseUrl: "file:///etc/passwd" } },
      { api: { baseUrl: "http://user:pw@localhost:11434" } },
      { quality: "max" },
      { allowCommands: "yes" },
      { maxSteps: 0 },
      { maxSteps: 201 },
      { maxSteps: 2.5 },
      { customInstructions: 3 },
      { customInstructions: "x".repeat(4001) },
    ];
    for (const b of bad) expect(() => validateSettingsPatch(b), JSON.stringify(b)).toThrow();
    expect(
      validateSettingsPatch({
        engine: "api",
        api: { provider: "ollama", baseUrl: "http://127.0.0.1:9999/v1/", model: " llama3.2:latest ", keys: { openrouter: " sk-or-1 ", gemini: null } },
        quality: "fast",
        allowCommands: false,
        maxSteps: 200,
        customInstructions: "",
      }),
    ).toEqual({
      engine: "api",
      api: { provider: "ollama", baseUrl: "http://127.0.0.1:9999", model: "llama3.2:latest", keys: { openrouter: "sk-or-1", gemini: null } },
      quality: "fast",
      allowCommands: false,
      maxSteps: 200,
      customInstructions: null,
    });
    expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("https://[::1]:1/ollama")).toBe("https://[::1]:1/ollama");
    expect(normalizeBaseUrl("http://192.168.1.2:11434")).toBeUndefined();
  });

  it("takes keys from the settings, else the environment, and detects the chosen provider", async () => {
    const s = await loadAgentSettings();
    expect(resolveApiKey(s, "openai")).toBeUndefined();
    process.env.OPENAI_API_KEY = "sk-env-openai";
    process.env.GOOGLE_API_KEY = "g-google";
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    expect(resolveApiKey(s, "openai")).toBe("sk-env-openai");
    expect(resolveApiKey(s, "gemini")).toBe("g-google");
    process.env.GEMINI_API_KEY = "g-gemini";
    expect(resolveApiKey(s, "gemini")).toBe("g-gemini");
    expect(resolveApiKey(s, "openrouter")).toBe("sk-or-env");
    expect(resolveApiKey(s, "anthropic")).toBeUndefined();
    const saved = await saveAgentSettings({ api: { keys: { openai: "sk-saved" } } });
    expect(resolveApiKey(saved, "openai")).toBe("sk-saved");

    // api = the chosen provider can run
    delete process.env.OPENAI_API_KEY;
    expect((await detectAgents(await saveAgentSettings({ api: { provider: "anthropic" } }))).api).toBe(false);
    expect((await detectAgents(await saveAgentSettings({ api: { provider: "openai" } }))).api).toBe(true);
    expect((await detectAgents(await saveAgentSettings({ api: { provider: "gemini" } }))).api).toBe(true);
  });

  it("builds Claude Code's command line and appends the standing instructions", () => {
    expect(claudeArgs({ allowCommands: false })).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    expect(claudeArgs({ allowCommands: true }).slice(-2)).toEqual(["--allowedTools", "Bash"]);
    expect(withInstructions("Build it", undefined)).toBe("Build it");
    expect(withInstructions("Build it", "  ")).toBe("Build it");
    expect(withInstructions("Build it", "Use Tailwind")).toContain("Build it\n\n## Standing instructions from the human (AI settings)\n\nUse Tailwind");
  });

  it("passes the standing instructions and the allow-commands flag to Claude Code", async () => {
    await fakeClaude();
    await saveAgentSettings({ engine: "claude", allowCommands: true, customInstructions: "Always use Tailwind" });
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "A page" });
    await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    const log = JSON.parse(await readFile(process.env.FAKE_LOG!, "utf8")) as { args: string[]; input: string };
    expect(log.args).toContain("--allowedTools");
    expect(log.input).toContain("Always use Tailwind");
    ed.close();
  }, 20_000);
});

/** A local stand-in for Ollama's /api/tags (and, with `chat`, the OpenAI-compatible endpoint). */
async function fakeHttp(handler: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => handler(req, raw, res));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const closeHttp = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));

describe("Ollama detection", () => {
  it("lists the installed models, and reports a closed port as not running", async () => {
    let calls = 0;
    const { server, url } = await fakeHttp((req, _body, res) => {
      calls++;
      res.writeHead(req.url === "/api/tags" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }, { model: "qwen2.5-coder:7b" }, { name: 5 }] }));
    });
    try {
      expect(await detectOllama(url)).toEqual({ running: true, models: ["llama3.2:latest", "qwen2.5-coder:7b"] });
      await detectOllama(url);
      expect(calls).toBe(1); // cached
      clearOllamaCache();
      await detectOllama(url);
      expect(calls).toBe(2);
    } finally {
      await closeHttp(server);
    }
    clearOllamaCache();
    expect(await detectOllama(url)).toEqual({ running: false, models: [] });

    // Ollama is "available" for the API engine only while it answers; its first model is the default.
    const up = await fakeHttp((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
    });
    try {
      await saveAgentSettings({ engine: "api", api: { provider: "ollama", baseUrl: up.url } });
      srv = await startServer({ dir, port: 0 });
      const info = (await (await fetch(`${srv.url}/api/agent`)).json()) as { engine: string; api: { model: string; ollama: unknown } };
      expect(info.engine).toBe("api");
      expect(info.api.model).toBe("llama3.2:latest");
      expect(info.api.ollama).toEqual({ baseUrl: up.url, running: true, models: ["llama3.2:latest"] });
    } finally {
      await closeHttp(up.server);
    }
  }, 20_000);
});

describe("OpenAI-compatible engine", () => {
  let fake: { server: Server; url: string };
  let requests: { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[];
  let reply: (n: number) => { status: number; chunks?: unknown[]; body?: unknown };

  beforeEach(async () => {
    requests = [];
    fake = await fakeHttp((req, raw, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
        return;
      }
      requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      const r = reply(requests.length);
      if (!r.chunks) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of r.chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  afterEach(async () => {
    await closeHttp(fake.server);
  });

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const toolTurn = (path: string, contents: string) => ({
    status: 200,
    chunks: [
      chunk({ role: "assistant", content: "Writing the page\n" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path, contents }).slice(0, 10) } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path, contents }).slice(10) } }] }),
      chunk({}, "tool_calls"),
    ],
  });
  const doneTurn = { status: 200, chunks: [chunk({ content: "Made the page." }), chunk({}, "stop")] };

  const run = async () => {
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    await post("/api/request", { text: "A page" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    return { ed, end };
  };

  it("runs the tool loop against OpenAI's Chat Completions", async () => {
    process.env.OPENAI_BASE_URL = `${fake.url}/v1`;
    await saveAgentSettings({ engine: "api", api: { provider: "openai", keys: { openai: "sk-openai-test" } }, quality: "best" });
    reply = (n) => (n === 1 ? toolTurn("index.html", "<h1>From GPT</h1>") : doneTurn);
    const { ed, end } = await run();
    expect(end).toMatchObject({ event: "done", engine: "api", text: "Made the page." });
    expect(ed.messages.find((m) => m.type === "agent-run" && m.event === "start")).toMatchObject({ text: "OpenAI · gpt-5" });
    expect(ed.messages.filter((m) => m.type === "agent-run" && m.event === "output").map((m) => m.text)).toEqual(["Writing the page", "Editing index.html", "Made the page."]);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>From GPT</h1>");

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first!.url).toBe("/v1/chat/completions");
    expect(first!.headers.authorization).toBe("Bearer sk-openai-test");
    expect(first!.body).toMatchObject({ model: "gpt-5", stream: true, reasoning_effort: "high" });
    expect((first!.body.tools as { type: string; function: { name: string } }[]).map((t) => [t.type, t.function.name])).toEqual([
      ["function", "list_files"],
      ["function", "read_file"],
      ["function", "write_file"],
      ["function", "delete_file"],
    ]);
    const msgs = second!.body.messages as { role: string; tool_call_id?: string; content?: unknown; tool_calls?: unknown[] }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2]!.tool_calls).toHaveLength(1);
    expect(msgs[3]).toMatchObject({ tool_call_id: "call_1", content: "Wrote index.html" });
    ed.close();
  }, 20_000);

  it("runs a local Ollama model without a key, and stops after the step limit", async () => {
    await saveAgentSettings({ engine: "api", api: { provider: "ollama", baseUrl: fake.url }, maxSteps: 2, customInstructions: "Use Tailwind" });
    reply = () => toolTurn("index.html", "<h1>Again</h1>");
    const { ed, end } = await run();
    expect(end).toMatchObject({ event: "error", text: "Stopped after 2 steps without finishing" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({ model: "llama3.2:latest" });
    expect(requests[0]!.body.reasoning_effort).toBeUndefined();
    const user = (requests[0]!.body.messages as { role: string; content: unknown }[])[1]!;
    expect(typeof user.content).toBe("string");
    expect(user.content).toContain("Use Tailwind");
    ed.close();
  }, 20_000);

  it("explains a rejected key and an unknown model", async () => {
    process.env.OPENAI_BASE_URL = `${fake.url}/v1`;
    await saveAgentSettings({ engine: "api", api: { provider: "openai", keys: { openai: "sk-bad" } } });
    reply = () => ({ status: 401, body: { error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } } });
    let { ed, end } = await run();
    expect(end).toMatchObject({ event: "error", text: "The OpenAI API key was rejected" });
    ed.close();
    await srv!.close();
    srv = undefined;

    await saveAgentSettings({ api: { model: "gpt-nope" } });
    reply = () => ({ status: 404, body: { error: { message: "The model `gpt-nope` does not exist", type: "invalid_request_error", code: "model_not_found" } } });
    ({ ed, end } = await run());
    expect(end).toMatchObject({ event: "error", text: 'OpenAI doesn\'t know the model "gpt-nope": pick another in the AI settings' });
    ed.close();
  }, 30_000);

  it("explains that Ollama isn't running", async () => {
    // Ollama answered the detection, then went away before the run.
    await saveAgentSettings({ engine: "api", api: { provider: "ollama", baseUrl: fake.url, model: "llama3.2" } });
    srv = await startServer({ dir, port: 0 });
    await fetch(`${srv.url}/api/agent`);
    await closeHttp(fake.server);
    fake.server = createServer();
    fake.server.listen(0);
    const ed = await editor();
    await post("/api/request", { text: "A page" });
    const end = await ed.until((m) => m.type === "agent-run" && (m.event === "done" || m.event === "error"));
    expect(end).toMatchObject({ event: "error" });
    expect(String(end.text)).toMatch(/^Ollama isn't running at http:\/\/127\.0\.0\.1:\d+/);
    ed.close();
  }, 20_000);

  it("never returns or broadcasts a key, for any provider", async () => {
    srv = await startServer({ dir, port: 0 });
    const ed = await editor();
    const secrets = { anthropic: "sk-ant-SECRET1", openai: "sk-SECRET2", gemini: "AIzaSECRET3", openrouter: "sk-or-SECRET4" };
    const res = await post("/api/agent/settings", { engine: "api", api: { provider: "gemini", keys: secrets } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/SECRET/);
    const info = JSON.parse(text);
    expect(info.api).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro", keysSaved: { anthropic: true, openai: true, gemini: true, openrouter: true } });
    expect(info.engine).toBe("api");
    expect(JSON.stringify(await (await fetch(`${srv.url}/api/agent`)).json())).not.toMatch(/SECRET/);
    await ed.until((m) => m.type === "agent-info" && (m.info as { api: { provider: string } }).api.provider === "gemini");
    expect(JSON.stringify(ed.messages)).not.toMatch(/SECRET/);
    expect((await post("/api/agent/settings", { api: { baseUrl: "http://evil.example" } })).status).toBe(400);
    expect((await post("/api/agent/settings", { api: { keys: { openai: "two words" } } })).status).toBe(400);
    const cleared = await (await post("/api/agent/settings", { api: { keys: { gemini: null } } })).json();
    expect(cleared.api.keysSaved.gemini).toBe(false);
    expect(cleared.available.api).toBe(false);
    ed.close();
  }, 20_000);
});
