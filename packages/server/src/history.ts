import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

/**
 * Paths Glimpse never watches as project files nor puts into the history: dependencies, build output, its own
 * state, and what Python writes while the app runs in Glimpse's terminal (bytecode caches, virtualenvs).
 */
export const IGNORED = /(^|[\\/])(node_modules|\.git|\.glimpse|dist|__pycache__|\.venv)([\\/]|$)/;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".glimpse", "dist", "__pycache__", ".venv"]);

/** Bigger files (videos, datasets) aren't versioned. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Keeps a snapshot cheap even when Glimpse is pointed at a huge folder. */
export const MAX_FILES = 2000;
/** Thumbnails and handoff screenshots. */
export const MAX_PNG_BYTES = 5 * 1024 * 1024;

/**
 * - `initial`: the project as it was when Glimpse opened it
 * - `ai`: the files after an AI round (a burst of saves that has gone quiet)
 * - `handoff`: what the human saw when they sent edits or a request
 * - `source`: right after Edit source wrote into the files
 * - `restore` / `variant`: automatic backups before Glimpse overwrites files
 * - `manual`: saved by the human
 */
export type SnapshotKind = "initial" | "ai" | "handoff" | "source" | "restore" | "variant" | "manual";

export interface Snapshot {
  id: string;
  seq: number;
  at: string;
  kind: SnapshotKind;
  label: string;
  /** Project-relative path (forward slashes) → sha256 of its contents in objects/. */
  files: Record<string, string>;
  /** Whether the editor stored a thumbnail (<id>.png). */
  thumb: boolean;
}

/** What the API lists: everything but the (potentially large) files map. */
export type PublicSnapshot = Omit<Snapshot, "files"> & { fileCount: number };

export function publicSnapshot(s: Snapshot): PublicSnapshot {
  const { files, ...rest } = s;
  return { ...rest, fileCount: Object.keys(files).length };
}

type Files = Record<string, string>;

/** mtime-based caching is only trusted once a file was hashed well after its last write (the "racy git" problem). */
const RACY_MS = 2000;
const SHA = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Content-addressed version history of a project's files, stored in
 * `.glimpse/history/`: `objects/<sha256>` holds each distinct file content once,
 * `snapshots.json` lists the snapshots. Every operation is serialized, so
 * snapshots, restores and the AI-round detector never interleave.
 */
export class History {
  readonly root: string;
  private snapshots: Snapshot[] = [];
  /**
   * The files as Glimpse last saw them: at the latest snapshot, or right after
   * Glimpse itself wrote into the project. An AI round is a difference from this,
   * so Glimpse's own writes (restore, variants) are never mistaken for the AI's.
   */
  private baseline: Files | null = null;
  private hashes = new Map<string, { size: number; mtimeMs: number; sha: string; at: number }>();
  private objects = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private warnedCap = false;

  constructor(
    private readonly dir: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {
    this.root = join(dir, ".glimpse", "history");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, "snapshots.json"), "utf8")) as unknown;
      if (Array.isArray(raw)) {
        this.snapshots = raw
          .filter((s): s is Snapshot => !!s && typeof s.id === "string" && typeof s.seq === "number" && !!s.files && typeof s.files === "object")
          .sort((a, b) => a.seq - b.seq);
      }
    } catch {
      // no history yet (or unreadable): start fresh
    }
  }

  list(): PublicSnapshot[] {
    return this.snapshots.map(publicSnapshot);
  }

  get(id: string): Snapshot | undefined {
    return this.snapshots.find((s) => s.id === id);
  }

  /** Resolves once every queued operation has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Snapshot the project now; returns the latest snapshot instead when nothing changed since it. */
  snapshot(kind: SnapshotKind, label: string): Promise<{ snapshot: Snapshot; created: boolean }> {
    return this.exclusive(() => this.take(kind, label));
  }

  /**
   * Called once the project's files have been quiet for a while. Snapshots them
   * as an AI round if they differ from what Glimpse last saw; null otherwise.
   */
  aiRound(): Promise<Snapshot | null> {
    return this.exclusive(async () => {
      const files = await this.scan();
      const changed = changedPaths(this.baseline ?? this.snapshots.at(-1)?.files ?? {}, files);
      if (changed.length === 0) return null;
      const shown = changed.slice(0, 3).join(", ");
      const more = changed.length > 3 ? ` +${changed.length - 3} more` : "";
      const { snapshot, created } = await this.take("ai", `AI edited ${shown}${more}`, files);
      return created ? snapshot : null;
    });
  }

  /**
   * Take a backup snapshot, let `write` change the project's files (it gets the
   * files map as they are now), then re-read them so the AI-round detector
   * doesn't count Glimpse's own writes.
   */
  guardedWrite<T>(
    kind: SnapshotKind,
    label: string,
    write: (current: Files) => Promise<T>,
  ): Promise<{ backup: Snapshot; created: boolean; result: T }> {
    return this.exclusive(async () => {
      const { snapshot: backup, created } = await this.take(kind, label);
      const current = this.baseline ?? {};
      try {
        return { backup, created, result: await write(current) };
      } finally {
        this.baseline = await this.scan();
      }
    });
  }

  /**
   * Put the project back to snapshot `id`: write every file whose content differs
   * and delete versioned files the snapshot doesn't have. Takes a backup first.
   */
  async restore(id: string): Promise<{ target: Snapshot; backup: Snapshot; created: boolean; written: string[]; deleted: string[] }> {
    const target = this.get(id);
    if (!target) throw new Error(`No such snapshot: ${id}`);
    const { backup, created, result } = await this.guardedWrite("restore", `Before restoring ${target.label}`, async (current) => {
      const written: string[] = [];
      const deleted: string[] = [];
      for (const [path, sha] of Object.entries(target.files)) {
        if (current[path] === sha) continue;
        const dest = this.resolveProjectPath(path);
        const data = dest && (await this.readObject(sha));
        if (!dest || !data) continue;
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, data);
        written.push(path);
      }
      for (const path of Object.keys(current)) {
        if (Object.hasOwn(target.files, path)) continue;
        const dest = this.resolveProjectPath(path);
        if (!dest) continue;
        await rm(dest, { force: true });
        deleted.push(path);
      }
      return { written, deleted };
    });
    return { target, backup, created, ...result };
  }

  /** The content of `path` in snapshot `id`, or null. */
  async readFile(id: string, path: string): Promise<Buffer | null> {
    const snap = this.get(id);
    if (!snap || !Object.hasOwn(snap.files, path)) return null;
    return this.readObject(snap.files[path]!);
  }

  /** Whether snapshot `id` has a file at `path`. */
  has(id: string, path: string): boolean {
    const snap = this.get(id);
    return !!snap && Object.hasOwn(snap.files, path);
  }

  setThumb(id: string, png: Buffer): Promise<Snapshot> {
    return this.exclusive(async () => {
      const snap = this.get(id);
      if (!snap) throw new Error(`No such snapshot: ${id}`);
      await mkdir(this.root, { recursive: true });
      await writeFile(this.thumbFile(id), png);
      snap.thumb = true;
      await this.save();
      return snap;
    });
  }

  thumbFile(id: string): string {
    return join(this.root, `${id}.png`);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async take(kind: SnapshotKind, label: string, scanned?: Files): Promise<{ snapshot: Snapshot; created: boolean }> {
    const files = scanned ?? (await this.scan());
    this.baseline = files;
    const last = this.snapshots.at(-1);
    if (last && sameFiles(last.files, files)) return { snapshot: last, created: false };
    const seq = (last?.seq ?? 0) + 1;
    const snapshot: Snapshot = { id: `s${seq}`, seq, at: new Date().toISOString(), kind, label, files, thumb: false };
    this.snapshots.push(snapshot);
    await this.save();
    return { snapshot, created: true };
  }

  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, "snapshots.json"), JSON.stringify(this.snapshots));
  }

  /** Hash every versioned file of the project (storing new contents as objects). */
  private async scan(): Promise<Files> {
    // No prototype, so a file named "__proto__" is just a key.
    const files = Object.create(null) as Files;
    let count = 0;
    let capped = false;
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (count >= MAX_FILES) {
          capped = true;
          return;
        }
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        // Symlinks are skipped: they could loop, or point outside the project.
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(join(abs, entry.name), path);
        } else if (entry.isFile()) {
          const sha = await this.hashFile(join(abs, entry.name), path);
          if (sha) {
            files[path] = sha;
            count++;
          }
        }
      }
    };
    await walk(this.dir, "");
    if (capped && !this.warnedCap) {
      this.warnedCap = true;
      this.warn(`glimpse: ${this.dir} has more than ${MAX_FILES} files; version history only keeps the first ${MAX_FILES}.`);
    }
    return files;
  }

  private async hashFile(abs: string, path: string): Promise<string | null> {
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) return null;
      const cached = this.hashes.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.at - st.mtimeMs > RACY_MS) return cached.sha;
      const data = await readFile(abs);
      if (data.length > MAX_FILE_BYTES) return null;
      const sha = createHash("sha256").update(data).digest("hex");
      await this.storeObject(sha, data);
      this.hashes.set(path, { size: st.size, mtimeMs: st.mtimeMs, sha, at: Date.now() });
      return sha;
    } catch {
      return null; // vanished or unreadable mid-scan
    }
  }

  private async storeObject(sha: string, data: Buffer): Promise<void> {
    if (this.objects.has(sha)) return;
    const file = join(this.root, "objects", sha);
    if (!(await exists(file))) {
      await mkdir(dirname(file), { recursive: true });
      // Write then rename, so a crash never leaves a truncated object behind.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file).catch(async (err: unknown) => {
        await rm(tmp, { force: true });
        if (!(await exists(file))) throw err;
      });
    }
    this.objects.add(sha);
  }

  private async readObject(sha: string): Promise<Buffer | null> {
    if (!SHA.test(sha)) return null;
    return readFile(join(this.root, "objects", sha)).catch(() => null);
  }

  /** Map a stored path back into the project, refusing anything that escapes it or lands in an ignored folder. */
  private resolveProjectPath(path: string): string | null {
    if (IGNORED.test(path)) return null;
    const root = resolve(this.dir);
    const full = normalize(join(root, path));
    return full.startsWith(root + sep) ? full : null;
  }
}

function sameFiles(a: Files, b: Files): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** Paths added, changed or deleted between two files maps, sorted. */
function changedPaths(before: Files, after: Files): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(after)) if (!Object.hasOwn(before, k) || before[k] !== after[k]) out.add(k);
  for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) out.add(k);
  return [...out].sort();
}

/** Decode a `data:image/png;base64,…` URL; null unless it really is a PNG of at most MAX_PNG_BYTES. */
export function decodePngDataUrl(value: unknown): Buffer | null {
  const prefix = "data:image/png;base64,";
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  const b64 = value.slice(prefix.length);
  if (b64.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 4) return null;
  const png = Buffer.from(b64, "base64");
  if (png.length > MAX_PNG_BYTES || png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return png;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
