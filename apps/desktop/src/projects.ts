import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDir, dirKey } from "./paths.js";

/** A Glimpse server this app started (the desktop app passes startGlimpse from glimpse-ui). */
export interface StartedServer {
  url: string;
  /** The server's token for local tools (x-glimpse-token), written into `.glimpse/server.json` next to the URL. */
  token?: string;
  close(): Promise<void>;
}

export interface OpenProject {
  dir: string;
  url: string;
  /** True when this process runs the server; false when it reuses one started elsewhere (e.g. `glimpse open`). */
  owned: boolean;
}

export interface ProjectServersOptions {
  /** Start a Glimpse server for a folder. */
  start: (dir: string) => Promise<StartedServer>;
  /** Written into `.glimpse/server.json` so `glimpse wait` and the MCP server find this Glimpse (default: this process). */
  pid?: number;
  /** How long to wait for a running Glimpse to answer before starting our own. */
  probeTimeoutMs?: number;
  /**
   * Runs finding or starting a folder's server under the folder's lock (glimpse-ui's withProjectLock), so an agent's
   * MCP server or `glimpse open` starting at the same moment doesn't start a second one. Default: no lock.
   */
  lock?: <T>(dir: string, fn: () => Promise<T>) => Promise<T>;
}

interface Entry extends OpenProject {
  server?: StartedServer;
}

/**
 * One Glimpse server per project folder. Opening a folder twice returns the same server; a Glimpse that is
 * already running for the folder (its `.glimpse/server.json` answers) is reused instead of starting a second one,
 * because two servers on one project would hand out conflicting handoff numbers.
 */
export class ProjectServers {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<OpenProject>>();
  private readonly closing = new Set<Promise<void>>();
  private readonly pid: number;

  constructor(private readonly opts: ProjectServersOptions) {
    this.pid = opts.pid ?? process.pid;
  }

  get size(): number {
    return this.entries.size;
  }

  get(dir: string): OpenProject | undefined {
    const e = this.entries.get(dirKey(dir));
    return e && { dir: e.dir, url: e.url, owned: e.owned };
  }

  list(): OpenProject[] {
    return [...this.entries.values()].map((e) => ({ dir: e.dir, url: e.url, owned: e.owned }));
  }

  /** Start (or reuse) the Glimpse server for a folder. Concurrent calls for one folder share one server. */
  open(dirArg: string): Promise<OpenProject> {
    const dir = canonicalDir(dirArg);
    const key = dirKey(dir);
    const known = this.entries.get(key);
    if (known) return Promise.resolve({ dir: known.dir, url: known.url, owned: known.owned });
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = this.start(dir, key).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  /** Servers still running or still stopping (quitting waits for them, so their server.json is removed). */
  get active(): boolean {
    return this.entries.size > 0 || this.pending.size > 0 || this.closing.size > 0;
  }

  /** Stop the server we started for a folder (a reused one keeps running) and forget the folder. */
  close(dirArg: string): Promise<void> {
    const task = this.closeNow(dirArg);
    this.closing.add(task);
    void task.then(
      () => this.closing.delete(task),
      () => this.closing.delete(task),
    );
    return task;
  }

  private async closeNow(dirArg: string): Promise<void> {
    const key = dirKey(dirArg);
    await this.pending.get(key)?.catch(() => undefined);
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    if (!e.server) return;
    try {
      await e.server.close();
    } finally {
      await this.removeInfo(e.dir);
    }
  }

  /** Whether the folder's server still answers: always for one we run, and for a reused one while it keeps running. */
  async answers(dirArg: string): Promise<boolean> {
    const e = this.entries.get(dirKey(dirArg));
    if (!e || e.owned) return true;
    return (await this.findRunning(e.dir)) === e.url;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.closing, ...[...this.entries.values()].map((e) => this.close(e.dir))]);
  }

  private async start(dir: string, key: string): Promise<OpenProject> {
    if (!isDir(dir)) throw new Error(`Folder not found: ${dir}`);
    return this.opts.lock ? this.opts.lock(dir, () => this.startUnlocked(dir, key)) : this.startUnlocked(dir, key);
  }

  private async startUnlocked(dir: string, key: string): Promise<OpenProject> {
    const running = await this.findRunning(dir);
    if (running) {
      const entry: Entry = { dir, url: running, owned: false };
      this.entries.set(key, entry);
      return { dir, url: running, owned: false };
    }
    const server = await this.opts.start(dir);
    const entry: Entry = { dir, url: server.url, owned: true, server };
    this.entries.set(key, entry);
    try {
      const info = join(dir, ".glimpse", "server.json");
      await mkdir(join(dir, ".glimpse"), { recursive: true });
      // The token lets local tools (MCP) ask the server to run commands; keep the file private to this user.
      const data = { url: server.url, pid: this.pid, ...(server.token && { token: server.token }) };
      await writeFile(info, JSON.stringify(data, null, 2), { mode: 0o600 });
      // Also when an older Glimpse left the file readable to others (mode only applies to a new file).
      await chmod(info, 0o600).catch(() => undefined);
    } catch {
      // A read-only folder still works in the app; agents just can't discover it.
    }
    return { dir, url: server.url, owned: true };
  }

  /** URL of a Glimpse another process runs for this folder, if it answers. */
  private async findRunning(dir: string): Promise<string | undefined> {
    try {
      const info = JSON.parse(await readFile(join(dir, ".glimpse", "server.json"), "utf8")) as { url?: unknown; pid?: unknown };
      if (typeof info.url !== "string" || info.pid === this.pid) return undefined;
      const res = await fetch(`${info.url}/api/session`, { signal: AbortSignal.timeout(this.opts.probeTimeoutMs ?? 1500) });
      if (!res.ok) return undefined;
      // A Glimpse that was killed leaves server.json behind, and another project's Glimpse may have its port now.
      const session = (await res.json()) as { project?: { dir?: unknown } };
      return typeof session.project?.dir === "string" && dirKey(session.project.dir) === dirKey(dir) ? info.url : undefined;
    } catch {
      return undefined; // missing, stale or unreadable
    }
  }

  /** Remove `.glimpse/server.json` if it still describes this process. */
  private async removeInfo(dir: string): Promise<void> {
    const file = join(dir, ".glimpse", "server.json");
    try {
      const info = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
      if (info.pid === this.pid) await rm(file, { force: true });
    } catch {
      // already gone
    }
  }
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
