import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Target } from "@glimpse/core";
import { openBrowser, startServer, type GlimpseServer, type Handoff } from "@glimpse/server";

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
}

const AGENT_GUIDE = `How to work with Glimpse:
1. glimpse_open your project once. The human sees your UI in Glimpse and every file you save appears live.
2. Call glimpse_wait_for_done. It returns when the human sends you something:
   - a build request typed on Glimpse's home screen ("a website with 5 buttons"), or
   - the edits they made visually, as numbered instructions with exact file:line:col locations.
   If it returns "still editing", just call it again.
3. Do what it says in the real source code. Apply edits 1:1, preferring idiomatic layout
   (flex/grid order, gap, alignment) over hard-coded pixel offsets. Optionally report progress
   with glimpse_status.
4. Go back to step 2.`;

/** Build the Glimpse MCP server (not yet connected to a transport). */
export function createGlimpseMcp(opts: McpOptions = {}): { mcp: McpServer; close: () => Promise<void> } {
  const projects = new Map<string, Project>();
  let current: string | undefined;

  const mcp = new McpServer({ name: "glimpse", version: "0.1.0" }, { instructions: AGENT_GUIDE });

  async function ensure(dirArg?: string, target?: Target, entry?: string): Promise<{ project: Project; opened: boolean }> {
    const dir = resolve(dirArg ?? current ?? process.cwd());
    const known = projects.get(dir);
    if (known) {
      current = dir;
      return { project: known, opened: false };
    }
    // Reuse a Glimpse that is already running for this project (e.g. `glimpse open`).
    const infoFile = join(dir, ".glimpse", "server.json");
    if (existsSync(infoFile)) {
      try {
        const info = JSON.parse(await readFile(infoFile, "utf8")) as { url: string };
        const res = await fetch(`${info.url}/api/session`);
        if (res.ok) {
          const project = { dir, url: info.url };
          projects.set(dir, project);
          current = dir;
          return { project, opened: true };
        }
      } catch {
        // stale file; start our own below
      }
    }
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const base = { dir, target, entry, editorDir: opts.editorDir };
    const own = await startServer({ ...base, port: opts.port ?? 4321 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") return startServer({ ...base, port: 0 });
      throw err;
    });
    await mkdir(dirname(infoFile), { recursive: true });
    await writeFile(infoFile, JSON.stringify({ url: own.url, pid: process.pid }, null, 2));
    const project = { dir, url: own.url, own };
    projects.set(dir, project);
    current = dir;
    if (opts.browser !== false) openBrowser(own.url);
    return { project, opened: true };
  }

  const api = async <T>(p: Project, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${p.url}${path}`, body === undefined ? undefined : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  };

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
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
      },
    },
    async ({ dir, target, entry }) => {
      const { project } = await ensure(dir, target, entry);
      const session = await api<{ project: { target: string; entry: string }; entryExists: boolean }>(project, "/api/session");
      return text(
        [
          `Glimpse is open at ${project.url} (project ${project.dir}, ${session.project.target}, entry ${session.project.entry}).`,
          session.entryExists
            ? "The human can now see and edit it."
            : `${session.project.entry} doesn't exist yet; create it and it appears live.`,
          "Next: call glimpse_wait_for_done to receive the human's request or edits.",
        ].join("\n"),
      );
    },
  );

  mcp.registerTool(
    "glimpse_wait_for_done",
    {
      title: "Wait for the human",
      description:
        "Block until the human sends something from Glimpse: a build request, or their visual edits (as numbered instructions with file:line:col). Returns 'still editing' after the timeout; then call it again.",
      inputSchema: {
        dir: dirParam,
        timeout_sec: z.number().int().min(5).max(600).optional().describe("How long to wait (default 240)"),
      },
    },
    async ({ dir, timeout_sec }) => {
      const { project } = await ensure(dir);
      const timeout = timeout_sec ?? 240;
      const deadline = Date.now() + timeout * 1000;
      while (Date.now() < deadline) {
        const chunk = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
        const body = project.own
          ? await project.own.nextHandoff(undefined, chunk * 1000).then((h) => (h ? { status: "ready", handoff: h } : { status: "editing" }))
          : await api<{ status: string; handoff?: Handoff }>(project, `/api/handoff/next?timeout=${chunk}`);
        if (body.status === "ready" && body.handoff) return text(formatHandoff(body.handoff));
      }
      return text("Still editing: the human hasn't sent anything yet. Call glimpse_wait_for_done again.");
    },
  );

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
      return text(formatHandoff(await api<Handoff>(project, `/api/handoffs/${latest.seq}`)));
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
  const json = JSON.stringify(h.changeList.changes.length ? h.changeList : { request: h.request }, null, 2);
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
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // The agent closed the connection (stdin ended): shut down the Glimpse servers we started.
  process.stdin.on("end", () => void stop());
  await mcp.connect(transport);
  mcp.server.onclose = () => void stop();
}
