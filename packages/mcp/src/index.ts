import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Target } from "@glimpse/core";
import { findRunningServer, openBrowser, startServer, withProjectLock, type GlimpseServer, type Handoff, type ServerInfo } from "@glimpse/server";
import { registerSceneTools } from "./scene-tool.js";

export { registerSceneTools, sceneExamplesText, type SceneToolOptions } from "./scene-tool.js";

/** Set to glimpse-ui's version when bundled (packages/cli/scripts/bundle.mjs). */
declare const __GLIMPSE_VERSION__: string | undefined;

/** The version this MCP server reports: glimpse-ui's when bundled, else this package's. */
const VERSION: string = typeof __GLIMPSE_VERSION__ === "string" ? __GLIMPSE_VERSION__ : ownVersion();

function ownVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0-dev";
  }
}

export interface McpOptions {
  /** Directory with the built editor UI, served by Glimpse. */
  editorDir?: string;
  /** Open the browser when a project is opened (default true). */
  browser?: boolean;
  /** Preferred port (default 4321; falls back to a free one). */
  port?: number;
}

interface Project {
  dir: string;
  url: string;
  /** Set when this MCP process hosts the Glimpse server itself. */
  own?: GlimpseServer;
  /** For a Glimpse started elsewhere: its token from .glimpse/server.json, for POST /api/terminal/run. */
  token?: string;
}

/**
 * How long glimpse_wait_for_done waits by default: under the 60 s that MCP clients commonly allow a
 * tool call, so the call returns "still editing" instead of being cut off.
 */
const DEFAULT_WAIT_SEC = 45;

const AGENT_GUIDE = `How to work with Glimpse:
1. glimpse_open your project once. The human sees your UI in Glimpse and every file you save appears live.
2. Call glimpse_wait_for_done. It returns when the human sends you something:
   - a build request typed on Glimpse's home screen ("a website with 5 buttons"),
   - the edits they made visually, as numbered instructions with exact file:line:col locations
     (often with a screenshot of their edited version), or
   - a request for design variants of one element: write each variant into .glimpse/variants/<id>/<k>/
     exactly as the message says, never into the real files; the human picks one in Glimpse.
   If it returns "still editing", just call it again.
   For a terminal UI or desktop GUI, also write glimpse.scene.json next to the code (glimpse_scene_schema for the
   format, glimpse_scene_validate to check) and pass the run command to glimpse_open.
3. Do what it says in the real source code. Apply edits 1:1, preferring idiomatic layout
   (flex/grid order, gap, alignment) over hard-coded pixel offsets. Optionally report progress
   with glimpse_status.
4. Go back to step 2.`;

/** Build the Glimpse MCP server (not yet connected to a transport). */
export function createGlimpseMcp(opts: McpOptions = {}): { mcp: McpServer; close: () => Promise<void> } {
  const projects = new Map<string, Project>();
  let current: string | undefined;

  const mcp = new McpServer({ name: "glimpse", version: VERSION }, { instructions: AGENT_GUIDE });
  registerSceneTools(mcp, { defaultDir: () => current });

  async function ensure(dirArg?: string, target?: Target, entry?: string, command?: string): Promise<{ project: Project; opened: boolean }> {
    const dir = resolve(dirArg ?? current ?? process.cwd());
    const known = projects.get(dir);
    if (known) {
      current = dir;
      return { project: known, opened: false };
    }
    // One at a time per folder, across processes: a desktop app or `glimpse open` starting at the same moment
    // must not end up with a second server on the project.
    return withProjectLock(dir, async () => {
      const again = projects.get(dir);
      if (again) {
        current = dir;
        return { project: again, opened: false };
      }
      // Reuse a Glimpse that is already running for this project (e.g. `glimpse open`).
      const infoFile = join(dir, ".glimpse", "server.json");
      // Only one that still serves this folder: a crashed Glimpse's file may point at another project's server.
      const info = existsSync(infoFile) ? await findRunningServer(dir) : null;
      if (info) {
        const project: Project = { dir, url: info.url, ...(info.token !== undefined && { token: info.token }) };
        projects.set(dir, project);
        current = dir;
        return { project, opened: true };
      }
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const base = { dir, target, entry, command, editorDir: opts.editorDir };
      const own = await startServer({ ...base, port: opts.port ?? 4321 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") return startServer({ ...base, port: 0 });
        throw err;
      });
      await mkdir(dirname(infoFile), { recursive: true });
      // The token lets other local tools ask this server to run commands; keep the file private to this user.
      await writeFile(infoFile, JSON.stringify({ url: own.url, pid: process.pid, token: own.token } satisfies ServerInfo, null, 2), { mode: 0o600 });
      const project = { dir, url: own.url, own };
      projects.set(dir, project);
      current = dir;
      if (opts.browser !== false) openBrowser(own.url);
      return { project, opened: true };
    });
  }

  const api = async <T>(p: Project, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`${p.url}${path}`, body === undefined ? { signal } : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (!res.ok || json === null) {
      throw new Error(`Glimpse at ${p.url} refused ${path}: ${json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`}`);
    }
    return json;
  };

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  /** Run the real app in the project's Glimpse terminal: in-process, or through the token-guarded endpoint. */
  async function runIn(p: Project, command: string): Promise<string> {
    try {
      if (p.own) {
        await p.own.run(command);
      } else {
        if (!p.token) return `Couldn't run \`${command}\`: the Glimpse at ${p.url} didn't leave a token in .glimpse/server.json. Restart it with --run "${command}".`;
        const res = await fetch(`${p.url}/api/terminal/run`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-glimpse-token": p.token },
          body: JSON.stringify({ command }),
        });
        if (!res.ok) return `Couldn't run \`${command}\`: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`}`;
      }
      return `Running \`${command}\` in Glimpse's terminal.`;
    } catch (err) {
      return `Couldn't run \`${command}\`: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** One line about the scene file of a TUI/native project: missing, broken, or how many problems it has. */
  async function sceneStatus(p: Project): Promise<string> {
    const s = await api<{ exists: boolean; file: string; errors?: string[]; invalid?: { message: string } }>(p, "/api/scene");
    if (!s.exists) return `${s.file} doesn't exist yet: write it (glimpse_scene_schema has the format) and the mock appears live.`;
    if (s.invalid) return `${s.file} isn't valid JSON: ${s.invalid.message}. Fix it (glimpse_scene_validate checks it).`;
    const n = s.errors?.length ?? 0;
    return n === 0
      ? `${s.file} has no problems. The human can now see and edit the mock.`
      : `${s.file} has ${n} problem${n === 1 ? "" : "s"}; the human can edit the mock, but call glimpse_scene_validate for the list and fix them.`;
  }

  /** A handoff as tool output: the instructions, plus the human's screenshot as an image when they sent one. */
  const handoffResult = async (p: Project, h: Handoff) => {
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: formatHandoff(h) },
    ];
    // Only ever Glimpse's own screenshot file, whatever the handoff record says.
    if (h.screenshot && /^\.glimpse\/handoffs\/\d+\.png$/.test(h.screenshot)) {
      const png =
        (await readFile(join(p.dir, ...h.screenshot.split("/"))).catch(() => null)) ??
        (await fetch(`${p.url}/api/handoffs/${h.seq}/screenshot`)
          .then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null))
          .catch(() => null));
      if (png) content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    }
    return { content };
  };

  const dirParam = z.string().optional().describe("Project directory (default: the last opened project, or the current directory)");

  mcp.registerTool(
    "glimpse_open",
    {
      title: "Open in Glimpse",
      description:
        "Open a project in Glimpse so the human can see and visually edit the UI you build. Every file you save shows up live. Call once per project, then use glimpse_wait_for_done.",
      inputSchema: {
        dir: z.string().describe("Project directory with the UI (created if missing)"),
        target: z.enum(["html", "react", "tui", "native"]).optional().describe("Kind of UI (auto-detected)"),
        entry: z.string().optional().describe("Page or scene file to show (default index.html)"),
        command: z
          .string()
          .optional()
          .describe(
            "Shell command that runs the real app (TUI/native), e.g. 'python app.py'; a TUI runs in Glimpse's terminal next to the mock. Defaults to meta.command in glimpse.scene.json.",
          ),
      },
    },
    async ({ dir, target, entry, command }) => {
      type Session = { project: { target: string; entry: string }; entryExists: boolean; previewError?: string | null };
      let { project, opened } = await ensure(dir, target, entry, command);
      let session = await api<Session>(project, "/api/session");
      const entryKey = (e: string) => relative(project.dir, resolve(project.dir, e)).split(sep).join("/");
      const differs = (s: Session) =>
        (target !== undefined && target !== s.project.target) || (entry !== undefined && entryKey(entry) !== entryKey(s.project.entry));
      let notApplied: string | undefined;
      if (differs(session)) {
        if (project.own && !opened) {
          // A Glimpse this agent started earlier with other settings: start it over with these.
          projects.delete(project.dir);
          await shutdown(project);
          ({ project, opened } = await ensure(dir, target, entry, command));
          session = await api<Session>(project, "/api/session");
        } else if (!project.own) {
          const which = [target !== undefined && "target", entry !== undefined && "entry"].filter(Boolean);
          notApplied = `That Glimpse was already running (started elsewhere), so the ${which.join(" and ")} you passed ${which.length > 1 ? "weren't" : "wasn't"} applied. Stop it and call glimpse_open again to change ${which.length > 1 ? "them" : "it"}.`;
        }
      }
      const run = command?.trim();
      // A server this call just started got the command already; one that was running needs to be told.
      const ran = run ? (opened && project.own ? `Running \`${run}\` in Glimpse's terminal.` : await runIn(project, run)) : undefined;
      const { target: kind, entry: file } = session.project;
      const lines = [`Glimpse is open at ${project.url} (project ${project.dir}, ${kind}, entry ${file}).`];
      if (notApplied) lines.push(notApplied);
      if (kind === "tui" || kind === "native") lines.push(await sceneStatus(project));
      else if (session.previewError) lines.push(`The preview can't run yet: ${session.previewError}`);
      else lines.push(session.entryExists ? "The human can now see and edit it." : `${file} doesn't exist yet; create it and it appears live.`);
      if (ran) lines.push(ran);
      lines.push("Next: call glimpse_wait_for_done to receive the human's request or edits.");
      return text(lines.join("\n"));
    },
  );

  mcp.registerTool(
    "glimpse_wait_for_done",
    {
      title: "Wait for the human",
      description: `Block until the human sends something from Glimpse: a build request, or their visual edits (as numbered instructions with file:line:col). Returns 'still editing' after the timeout (default ${DEFAULT_WAIT_SEC} s, under common tool-call timeouts); then call it again.`,
      inputSchema: {
        dir: dirParam,
        timeout_sec: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe(`How long to wait (default ${DEFAULT_WAIT_SEC}). Keep it under your client's tool-call timeout.`),
      },
    },
    async ({ dir, timeout_sec }, { signal }) => {
      const { project } = await ensure(dir);
      const timeout = timeout_sec ?? DEFAULT_WAIT_SEC;
      const deadline = Date.now() + timeout * 1000;
      while (Date.now() < deadline && !signal.aborted) {
        const chunk = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
        // Cancelling the tool call (the client's timeout, or the user pressing Esc) stops the wait, so
        // nothing the human sends meanwhile is handed to a call nobody reads.
        const handoff = project.own
          ? await project.own.nextHandoff(undefined, chunk * 1000, signal)
          : await api<{ status: string; handoff?: Handoff }>(project, `/api/handoff/next?timeout=${chunk}`, undefined, signal).then(
              (body) => (body.status === "ready" ? (body.handoff ?? null) : null),
              (err: unknown) => {
                if (signal.aborted) return null;
                throw err;
              },
            );
        if (!handoff) continue;
        const result = await handoffResult(project, handoff);
        if (signal.aborted) {
          // Cancelled while the reply was being put together: the client won't read it, so the next wait gets it.
          await requeue(project, handoff.seq);
          break;
        }
        return result;
      }
      return text("Still editing: the human hasn't sent anything yet. Call glimpse_wait_for_done again.");
    },
  );

  /** Put a handoff the agent never received back in the queue. */
  async function requeue(p: Project, seq: number): Promise<void> {
    if (p.own) p.own.requeueHandoff(seq);
    else await api(p, `/api/handoffs/${seq}/requeue`, {}).catch(() => {});
  }

  mcp.registerTool(
    "glimpse_get_changes",
    {
      title: "Latest from Glimpse",
      description: "Return the most recent thing the human sent from Glimpse, without waiting.",
      inputSchema: { dir: dirParam },
    },
    async ({ dir }) => {
      const { project } = await ensure(dir);
      const list = await api<{ handoffs: { seq: number }[] }>(project, "/api/handoffs");
      const latest = list.handoffs[0];
      if (!latest) return text("Nothing has been sent from Glimpse yet.");
      return handoffResult(project, await api<Handoff>(project, `/api/handoffs/${latest.seq}`));
    },
  );

  mcp.registerTool(
    "glimpse_status",
    {
      title: "Post status",
      description: "Show a short status line in Glimpse's live activity feed, e.g. 'Applying your 4 changes…' or 'Done'.",
      inputSchema: { message: z.string().min(1), dir: dirParam },
    },
    async ({ message, dir }) => {
      const { project } = await ensure(dir);
      await api(project, "/api/status", { message });
      return text("Posted.");
    },
  );

  mcp.registerTool(
    "glimpse_update",
    {
      title: "Reload preview",
      description: "Force Glimpse to reload the preview. Normally not needed: saved files appear live.",
      inputSchema: { dir: dirParam },
    },
    async ({ dir }) => {
      const { project } = await ensure(dir);
      await api(project, "/api/reload", {});
      return text("Reloaded.");
    },
  );

  mcp.registerTool(
    "glimpse_close",
    {
      title: "Close Glimpse",
      description: "Stop the Glimpse server this agent started for a project.",
      inputSchema: { dir: dirParam },
    },
    async ({ dir }) => {
      const key = resolve(dir ?? current ?? process.cwd());
      const p = projects.get(key);
      if (!p) return text("Glimpse isn't open for that project.");
      projects.delete(key);
      if (current === key) current = undefined;
      if (p.own) await shutdown(p);
      return text(p.own ? "Closed." : "Detached (that Glimpse was started elsewhere and keeps running).");
    },
  );

  const shutdown = async (p: Project) => {
    await p.own?.close();
    const infoFile = join(p.dir, ".glimpse", "server.json");
    try {
      const info = JSON.parse(await readFile(infoFile, "utf8")) as { pid: number };
      if (info.pid === process.pid) await writeFile(infoFile, "{}");
    } catch {
      // ignore
    }
  };

  return {
    mcp,
    async close() {
      for (const p of projects.values()) if (p.own) await shutdown(p);
      projects.clear();
      await mcp.close();
    },
  };
}

function formatHandoff(h: Handoff): string {
  const data = h.changeList.changes.length ? h.changeList : h.variants ? { variants: h.variants } : { request: h.request };
  const json = JSON.stringify(data, null, 2);
  return `${h.prompt}\n\n(Glimpse handoff #${h.seq}, ${h.kind}.) Structured data:\n\n\`\`\`json\n${json}\n\`\`\``;
}

/** Run the MCP server over stdio (what `glimpse mcp` does). */
export async function runStdio(opts: McpOptions = {}): Promise<void> {
  const { mcp, close } = createGlimpseMcp(opts);
  const transport = new StdioServerTransport();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await close().catch(() => {});
    process.exit(0);
  };
  // A second signal while closing: don't wait any longer.
  const onSignal = () => (stopping ? process.exit(1) : void stop());
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // The agent closed the connection (stdin ended): shut down the Glimpse servers we started.
  process.stdin.on("end", () => void stop());
  await mcp.connect(transport);
  mcp.server.onclose = () => void stop();
}
