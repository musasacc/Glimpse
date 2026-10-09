import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** What `glimpse open`, the MCP server and the desktop app write into <project>/.glimpse/server.json. */
export interface ServerInfo {
  url: string;
  pid: number;
  token?: string;
}

/** Key for comparing project folders: canonical (symlinks resolved), and case-insensitive where the file system usually is. */
export function projectDirKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  let p = resolve(dir);
  try {
    p = realpathSync.native(p);
  } catch {
    // keep the resolved path
  }
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

/**
 * The Glimpse that `<dir>/.glimpse/server.json` describes, if it still answers and still serves this
 * project. A file left behind by a crashed Glimpse can point at a port another project's Glimpse took
 * since; that one is not ours, and attaching to it would hand this agent the other project's edits.
 */
export async function findRunningServer(dir: string, opts: { timeoutMs?: number } = {}): Promise<ServerInfo | null> {
  try {
    const info = JSON.parse(await readFile(join(dir, ".glimpse", "server.json"), "utf8")) as Partial<ServerInfo>;
    if (typeof info.url !== "string") return null;
    const res = await fetch(`${info.url}/api/session`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) return null;
    const session = (await res.json()) as { project?: { dir?: unknown } };
    const served = session.project?.dir;
    if (typeof served !== "string" || projectDirKey(served) !== projectDirKey(dir)) return null;
    return { url: info.url, pid: typeof info.pid === "number" ? info.pid : 0, ...(typeof info.token === "string" && { token: info.token }) };
  } catch {
    return null; // missing, unreadable, or nothing answers
  }
}
