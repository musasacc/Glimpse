import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalDir, dirKey, folderName } from "./paths.js";

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

interface StoreFile {
  version: 1;
  projects: RecentProject[];
}

/**
 * Recently opened project folders, most recent first, persisted as JSON
 * (the desktop app keeps it in `<userData>/recent-projects.json`).
 */
export class RecentProjects {
  private items: RecentProject[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    readonly max = 12,
  ) {}

  /** Read the file; a missing or unreadable file is an empty list. */
  async load(): Promise<RecentProject[]> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoreFile>;
      const seen = new Set<string>();
      this.items = (Array.isArray(data.projects) ? data.projects : [])
        .filter((p): p is RecentProject => !!p && typeof p.path === "string" && p.path.length > 0)
        .map((p) => ({ path: p.path, name: typeof p.name === "string" && p.name ? p.name : folderName(p.path), openedAt: String(p.openedAt ?? "") }))
        .filter((p) => {
          const key = dirKey(p.path);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, this.max);
    } catch {
      this.items = [];
    }
    return this.list();
  }

  list(): RecentProject[] {
    return this.items.map((p) => ({ ...p }));
  }

  /** The list with whether each folder still exists. */
  withStatus(): (RecentProject & { exists: boolean })[] {
    return this.items.map((p) => ({ ...p, exists: isDir(p.path) }));
  }

  has(path: string): boolean {
    const key = dirKey(path);
    return this.items.some((p) => dirKey(p.path) === key);
  }

  /** Move (or add) a folder to the top. */
  async add(path: string, now = new Date()): Promise<void> {
    const dir = canonicalDir(path);
    const key = dirKey(dir);
    this.items = [{ path: dir, name: folderName(dir), openedAt: now.toISOString() }, ...this.items.filter((p) => dirKey(p.path) !== key)].slice(
      0,
      this.max,
    );
    await this.save();
  }

  async remove(path: string): Promise<void> {
    const key = dirKey(path);
    this.items = this.items.filter((p) => dirKey(p.path) !== key);
    await this.save();
  }

  async clear(): Promise<void> {
    this.items = [];
    await this.save();
  }

  /** Writes are serialized and atomic (temp file + rename), so a crash never leaves half a file. */
  private save(): Promise<void> {
    const snapshot: StoreFile = { version: 1, projects: this.list() };
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
