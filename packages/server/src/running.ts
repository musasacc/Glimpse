import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

/** Whether two paths name the same folder: symlinks resolved, and case-insensitive on macOS and Windows. */
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return projectDirKey(a, platform) === projectDirKey(b, platform);
}

/**
 * Whether the Glimpse at `url` answers and shows the project in `dir`. A `.glimpse/server.json` left behind by a
 * Glimpse that was killed can point at a port another project's Glimpse has taken since.
 */
export async function servesProject(url: string, dir: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { project?: { dir?: unknown } };
    return typeof body.project?.dir === "string" && sameDir(body.project.dir, dir);
  } catch {
    return false;
  }
}

/**
 * The Glimpse that `<dir>/.glimpse/server.json` describes, if it still answers and still serves this
 * project (see servesProject); null when the file is missing, unreadable, or points at another Glimpse.
 */
export async function findRunningServer(dir: string, opts: { timeoutMs?: number } = {}): Promise<ServerInfo | null> {
  let info: Partial<ServerInfo>;
  try {
    info = JSON.parse(await readFile(join(dir, ".glimpse", "server.json"), "utf8")) as Partial<ServerInfo>;
  } catch {
    return null;
  }
  if (!info || typeof info.url !== "string" || !(await servesProject(info.url, dir, opts.timeoutMs))) return null;
  return { url: info.url, pid: typeof info.pid === "number" ? info.pid : 0, ...(typeof info.token === "string" && { token: info.token }) };
}

/**
 * Run `fn` (find a running Glimpse for `dir`, or start one and write `.glimpse/server.json`) while holding
 * `.glimpse/server.lock`, so two tools opening one project at once (the MCP server and the desktop app) don't both
 * start a server: the second waits, then finds the first one's server.json. A lock whose process is gone, or that
 * is held longer than `waitMs`, is taken over. In a folder Glimpse can't write to, `fn` runs without a lock.
 */
export async function withProjectLock<T>(dir: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const file = join(dir, ".glimpse", "server.lock");
  const deadline = Date.now() + waitMs;
  let locked = false;
  try {
    await mkdir(dirname(file), { recursive: true });
    while (!locked) {
      try {
        await writeFile(file, String(process.pid), { flag: "wx" });
        locked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = Number(await readFile(file, "utf8").catch(() => ""));
        const age = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? 0);
        // An empty lock was just created and its pid isn't written yet.
        const held = pidAlive(holder) || (!(holder > 0) && age < 2000);
        if (!held || Date.now() > deadline) await rm(file, { force: true });
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch {
    // read-only folder: no lock
  }
  try {
    return await fn();
  } finally {
    if (locked) await rm(file, { force: true }).catch(() => undefined);
  }
}

/** Whether a process with this pid exists (0 or garbage: no). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
