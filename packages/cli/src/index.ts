#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Target } from "@glimpse/core";
import { openBrowser, servesProject, startServer, withProjectLock, type Handoff } from "@glimpse/server";
import { runStdio } from "@glimpse/mcp";
import { VERSION } from "./lib.js";

const HELP = `glimpse — see what your AI built, edit it visually, hand the changes back.

Usage
  glimpse open [dir]        Open a project in Glimpse (default: current directory)
      --port <n>            Port (default 4321, falls back to a free port)
      --target <t>          html | react | tui | native (auto-detected)
      --entry <file>        Page or scene file to open (default index.html)
      --run <command>       Run the real app (TUI/native) inside Glimpse, e.g. --run "python app.py"
                            (default: meta.command, started from the editor)
      --no-browser          Don't open a browser window
  glimpse wait [dir]        Block until the human sends something (a build request or edits), then print it
      --after <seq>         Only return handoffs newer than this number (default: the next undelivered one)
      --timeout <sec>       Give up after this long and print {"status":"editing"} (default 300)
      --json                Print the full handoff as JSON
  glimpse changes [dir]     Print the latest handoff (add --json for JSON)
  glimpse status <message>  Show a status line in Glimpse's live activity feed
      --dir <dir>           Project directory (default: current directory)
  glimpse mcp               Run as an MCP server (stdio) for Claude Code, Codex, Cursor, …
      --no-browser          Don't open a browser window when a project is opened
      --port <n>            Preferred port (default 4321)

Agents: add the MCP server (\`claude mcp add glimpse -- npx -y glimpse-ui mcp\`), or run
\`glimpse open\` once and loop on \`glimpse wait\`, applying what it prints.
`;

/** <project>/.glimpse/server.json: how local tools (glimpse wait, the MCP server) find a running Glimpse. */
interface ServerInfo {
  url: string;
  pid: number;
  /** For privileged requests (x-glimpse-token), e.g. POST /api/terminal/run. */
  token?: string;
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  switch (command) {
    case "open":
      return open(rest);
    case "wait":
      return wait(rest);
    case "changes":
      return changes(rest);
    case "status":
      return status(rest);
    case "mcp":
      return mcp(rest);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function open(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      target: { type: "string" },
      entry: { type: "string" },
      run: { type: "string" },
      "no-browser": { type: "boolean", default: false },
    },
  });
  const dir = resolve(positionals[0] ?? ".");
  if (!existsSync(dir)) throw new Error(`No such directory: ${dir}`);
  const command = values.run?.trim() || undefined;

  const editorDir = join(dirname(fileURLToPath(import.meta.url)), "editor");
  const base = {
    dir,
    target: targetArg(values.target),
    entry: values.entry,
    command,
    editorDir: existsSync(editorDir) ? editorDir : undefined,
  };
  const wanted = values.port ? intArg("--port", values.port, 0, 65535) : 4321;
  const infoFile = join(dir, ".glimpse", "server.json");
  // Under the project's lock, so the MCP server or the desktop app opening it at the same moment waits and reuses this one.
  const srv = await withProjectLock(dir, async () => {
    const srv = await startServer({ ...base, port: wanted }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !values.port) return startServer({ ...base, port: 0 });
      throw err;
    });
    await mkdir(dirname(infoFile), { recursive: true });
    // The token lets local tools ask this server to run commands; keep the file private to this user.
    await writeFile(infoFile, JSON.stringify({ url: srv.url, pid: process.pid, token: srv.token } satisfies ServerInfo, null, 2), { mode: 0o600 });
    return srv;
  });

  process.stdout.write(
    [
      "",
      `  ◉ glimpse  ${srv.url}`,
      `    project  ${dir}`,
      `    target   ${srv.project.target} (${srv.project.entry})`,
      ...(command ? [`    run      ${command}`] : []),
      "",
      "  Live mode is on: file changes appear in Glimpse instantly.",
      "  Agents: run `glimpse wait` to receive the human's edits.",
      "",
    ].join("\n") + "\n",
  );
  if (!values["no-browser"]) openBrowser(srv.url);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1); // a second Ctrl+C: don't wait any longer
    stopping = true;
    await rm(infoFile, { force: true });
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function mcp(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "no-browser": { type: "boolean", default: false }, port: { type: "string" } } });
  const editorDir = join(dirname(fileURLToPath(import.meta.url)), "editor");
  await runStdio({
    editorDir: existsSync(editorDir) ? editorDir : undefined,
    browser: !values["no-browser"],
    port: values.port ? intArg("--port", values.port, 0, 65535) : undefined,
  });
}

async function wait(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      after: { type: "string" },
      timeout: { type: "string", default: "300" },
      json: { type: "boolean", default: false },
    },
  });
  const dir = resolve(positionals[0] ?? ".");
  const server = await findServer(dir);
  // Without --after, the server hands out the oldest message no agent has received yet.
  const afterParam = values.after !== undefined ? `&after=${intArg("--after", values.after, 0)}` : "";
  const timeout = intArg("--timeout", values.timeout, 1);

  // Long-poll in chunks so proxies and agent tool timeouts don't cut the request.
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const chunk = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
    const res = await fetch(`${server.url}/api/handoff/next?timeout=${chunk}${afterParam}`).catch(() => {
      throw new Error(`Glimpse at ${server.url} stopped. Run \`glimpse open ${dir}\` again.`);
    });
    const body = await apiJson<{ status: string; handoff?: Handoff }>(res);
    if (body.status === "ready" && body.handoff) {
      printHandoff(body.handoff, values.json, dir);
      return;
    }
  }
  process.stdout.write(values.json ? `${JSON.stringify({ status: "editing" })}\n` : "Still editing — nothing sent yet. Run `glimpse wait` again.\n");
}

async function changes(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const dir = resolve(positionals[0] ?? ".");
  const file = join(dir, ".glimpse", "latest.json");
  if (!existsSync(file)) {
    process.stdout.write(values.json ? `${JSON.stringify({ status: "none" })}\n` : "Nothing has been sent from Glimpse yet.\n");
    return;
  }
  printHandoff(JSON.parse(await readFile(file, "utf8")) as Handoff, values.json, dir);
}

async function status(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { dir: { type: "string", default: "." } } });
  const message = positionals.join(" ").trim();
  if (!message) throw new Error("Usage: glimpse status <message>");
  const server = await findServer(resolve(values.dir));
  await apiJson(
    await fetch(`${server.url}/api/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
}

/** A response's JSON body; an error with the server's message when it refused the request. */
async function apiJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok || body === null) {
    const why = body && typeof body.error === "string" ? body.error : `HTTP ${res.status} ${res.statusText}`.trim();
    throw new Error(`Glimpse refused the request: ${why}`);
  }
  return body;
}

/** A whole-number option in [min, max], or a clear error. */
function intArg(name: string, value: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!/^\s*\d+\s*$/.test(value) || n < min || n > max) {
    throw new Error(`${name} expects a whole number${max < Number.MAX_SAFE_INTEGER ? ` from ${min} to ${max}` : ` of at least ${min}`}, not "${value}"`);
  }
  return n;
}

const TARGETS: readonly Target[] = ["html", "react", "tui", "native"];

function targetArg(value: string | undefined): Target | undefined {
  if (value === undefined) return undefined;
  if (!(TARGETS as readonly string[]).includes(value)) throw new Error(`--target expects one of ${TARGETS.join(", ")}, not "${value}"`);
  return value as Target;
}

function printHandoff(h: Handoff, json: boolean, dir: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: "ready", handoff: h }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${h.prompt}\n\n(Handoff #${h.seq}. Full JSON with source locations: ${join(dir, ".glimpse", "handoffs", `${h.seq}.json`)})\n`,
  );
}

async function findServer(dir: string): Promise<ServerInfo> {
  const file = join(dir, ".glimpse", "server.json");
  if (!existsSync(file)) throw new Error(`Glimpse isn't open for ${dir}. Run \`glimpse open ${dir}\` first.`);
  const info = JSON.parse(await readFile(file, "utf8")) as ServerInfo;
  // A Glimpse that was killed leaves server.json behind, and another project's Glimpse may have its port now.
  if (typeof info.url !== "string" || !(await servesProject(info.url, dir))) {
    throw new Error(`Glimpse isn't running for ${dir} anymore (nothing at ${String(info.url)} shows it). Run \`glimpse open ${dir}\` again.`);
  }
  return info;
}

main().catch((err: unknown) => {
  process.stderr.write(`glimpse: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
