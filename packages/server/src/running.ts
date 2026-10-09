import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** What `glimpse open`, the MCP server and the desktop app write into <project>/.glimpse/server.json. */
export interface ServerInfo {
  url: string;
  pid: number;
  token?: string;
}

/**
 * Write `<dir>/.glimpse/server.json`. It holds the token that lets local tools run commands, so only this user may
 * read it (also when an older Glimpse left the file readable to others).
 */
export async function writeServerInfo(dir: string, info: ServerInfo): Promise<void> {
  const file = join(dir, ".glimpse", "server.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(info, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
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

/** How often the holder of a project lock touches it, so others can tell it is still at work. */
const LOCK_HEARTBEAT_MS = 2000;

/**
 * Run `fn` (find a running Glimpse for `dir`, or start one and write `.glimpse/server.json`) while holding
 * `.glimpse/server.lock`, so two tools opening one project at once (the MCP server and the desktop app) don't both
 * start a server: the second waits, then finds the first one's server.json. The holder touches the lock while it
 * works (starting Vite can take long), and it is never taken from a live holder that does; a lock whose process is
 * gone, or that hasn't been touched for `staleMs` (a pid reused by another program), is taken over. In a folder
 * Glimpse can't write to, `fn` runs without a lock.
 */
export async function withProjectLock<T>(dir: string, fn: () => Promise<T>, staleMs = 30_000): Promise<T> {
  const file = join(dir, ".glimpse", "server.lock");
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
        const held = holder > 0 ? pidAlive(holder) && age < staleMs : age < 2000;
        if (!held) await rm(file, { force: true });
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch {
    // read-only folder: no lock
  }
  const heartbeat = locked
    ? setInterval(() => {
        const now = new Date();
        utimes(file, now, now).catch(() => undefined);
      }, Math.min(LOCK_HEARTBEAT_MS, Math.max(50, staleMs / 3)))
    : undefined;
  heartbeat?.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
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
