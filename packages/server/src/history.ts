import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

/** Folders Glimpse never versions nor writes into: its own state, git and dependencies. */
const PROTECTED_DIRS = ["node_modules", ".git", ".glimpse"];
/**
 * Build output, caches and virtualenvs: generated, often thousands of files,
 * and (dot-folders) early in the walk, where they would crowd the real
 * source out of a capped snapshot.
 */
const GENERATED_DIRS = ["dist", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", ".yarn", ".turbo", ".cache", ".parcel-cache", ".pnpm-store", "coverage"];
const IGNORED_DIRS = new Set([...PROTECTED_DIRS, ...GENERATED_DIRS]);
/** What the OS and editors drop next to the user's files (Finder, Explorer, vim, emacs, JetBrains). Lower case. */
const JUNK_FILE = /^(\.ds_store|thumbs\.db|ehthumbs\.db|desktop\.ini|\..+\.sw[a-p]|.+~|\.#.+|#.+#|.+___jb_(tmp|old)___)$/;

/**
 * Whether a project-relative path is outside what Glimpse watches, versions
 * and writes: an ignored folder, or OS and editor junk. Names compare without
 * case and trailing dots or spaces, the way macOS and Windows resolve them
 * (".GIT" and ".git." are ".git" there).
 */
export function isIgnored(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.some((part, i) => {
    const name = part.toLowerCase();
    return IGNORED_DIRS.has(name.replace(/[. ]+$/, "")) || (i === parts.length - 1 && JUNK_FILE.test(name));
  });
}

/**
 * Files that hold secrets (environment files with keys, private keys, package-registry and login tokens): never
 * copied into the version history, which lives in the project folder where `git add -A` or a zip would pick it up.
 * Example env files are fine. Lower case.
 */
const SECRET_FILE = /^(\.env(?!\.(example|sample|template|dist)$)(\..*)?|\.npmrc|\.yarnrc\.yml|\.pypirc|\.netrc|_netrc|\.htpasswd|.+\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(_sk)?)$/;

/** Whether a file name (not a path) looks like it holds secrets (see SECRET_FILE). */
export function isSecretFile(name: string): boolean {
  return SECRET_FILE.test(name.toLowerCase().replace(/[. ]+$/, ""));
}

/** Bigger files (videos, datasets) aren't versioned. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Keeps a snapshot cheap even when Glimpse is pointed at a huge folder. */
export const MAX_FILES = 2000;
/** Thumbnails and handoff screenshots. */
const MAX_PNG_BYTES = 5 * 1024 * 1024;
/**
 * Saves less than this far apart belong to the same AI round, unless the agent
 * waited for the human in between: an agent saves once per tool call, and its
 * calls are seconds apart.
 */
const ROUND_GAP_MS = 60_000;
/**
 * AI rounds kept in the history; older ones are pruned (with the file contents
 * only they held). Every other kind of version (the human's, handoffs, Glimpse's
 * own writes) is kept. Pruning waits for some slack, so it runs now and then.
 */
const KEEP_AI_ROUNDS = 200;
const PRUNE_SLACK = 20;

/**
 * - `initial`: the project as it was when Glimpse opened it
 * - `ai`: the files after an AI round (the agent's saves, until it waits for the human again)
 * - `handoff`: what the human saw when they sent edits or a request
 * - `source`: right after Edit source wrote into the files
 * - `restore` / `variant`: the files right after Glimpse restored a version or used a variant
 *   (and a backup before, when the files weren't saved yet)
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
  /**
   * Set when the project had more than MAX_FILES files: the last path the
   * snapshot holds, in walk order. Files after it were never looked at, so
   * their absence from `files` means nothing.
   */
  cappedAfter?: string;
}

/** What the API lists: everything but the (potentially large) files map. */
export type PublicSnapshot = Omit<Snapshot, "files"> & { fileCount: number };

export function publicSnapshot(s: Snapshot): PublicSnapshot {
  const { files, ...rest } = s;
  return { ...rest, fileCount: Object.keys(files).length };
}

type Files = Record<string, string>;

/** The project's files as one walk saw them. */
export interface Scan {
  files: Files;
  cappedAfter?: string;
}

export interface HistoryOptions {
  warn?: (message: string) => void;
  /** A snapshot was created, or changed in place (an AI round grew, a thumbnail arrived). */
  onSnapshot?: (snapshot: Snapshot, change: "created" | "updated") => void;
  /** Old AI rounds were pruned (see KEEP_AI_ROUNDS). */
  onPruned?: (ids: string[]) => void;
  /** Override KEEP_AI_ROUNDS (tests). */
  keepAiRounds?: number;
}

/** What a snapshot Glimpse takes around its own writes is called. */
export interface SnapshotLabel {
  kind: SnapshotKind;
  label: string;
}

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
  private baseline: Scan | null = null;
  /** The newest snapshot is an AI round the agent may still be adding to (it hasn't waited for the human since). */
  private roundOpen = false;
  private hashes = new Map<string, { size: number; mtimeMs: number; sha: string; at: number }>();
  private objects = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private warnedCap = false;
  private readonly warn: (message: string) => void;
  private readonly onSnapshot: (snapshot: Snapshot, change: "created" | "updated") => void;
  private readonly onPruned: (ids: string[]) => void;
  private readonly keepAiRounds: number;

  constructor(
    private readonly dir: string,
    opts: HistoryOptions = {},
  ) {
    this.root = join(dir, ".glimpse", "history");
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.onSnapshot = opts.onSnapshot ?? (() => undefined);
    this.onPruned = opts.onPruned ?? (() => undefined);
    this.keepAiRounds = opts.keepAiRounds ?? KEEP_AI_ROUNDS;
  }

  async load(): Promise<void> {
    const file = join(this.root, "snapshots.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return; // no history yet
    }
    try {
      const raw = JSON.parse(text) as unknown;
      if (!Array.isArray(raw)) throw new Error("not a list of snapshots");
      // Each entry holds its files in full (`files`) or as changes from the entry before it (see save).
      const loaded: Snapshot[] = [];
      let prev: Files | null = null;
      for (const s of raw as (Partial<Snapshot> & { changes?: Record<string, string | null> })[]) {
        // Ids end up in file names (thumbnails), so only ever "s<n>".
        const ok = !!s && typeof s.id === "string" && /^s\d+$/.test(s.id) && typeof s.seq === "number";
        let files: Files | null = null;
        if (ok && !!s.files && typeof s.files === "object") files = s.files;
        else if (ok && prev && !!s.changes && typeof s.changes === "object") files = applyChanges(prev, s.changes);
        prev = files;
        if (!files) continue;
        const { changes: _, ...meta } = s;
        loaded.push({ ...(meta as Snapshot), files });
      }
      this.snapshots = loaded.sort((a, b) => a.seq - b.seq);
    } catch (err) {
      // Starting over must not destroy what may still be recoverable by hand.
      const kept = `${file}.unreadable-${Date.now()}`;
      await rename(file, kept).catch(() => undefined);
      this.warn(`glimpse: couldn't read the version history (${err instanceof Error ? err.message : String(err)}); kept it as ${kept} and started a new one.`);
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

  /**
   * Snapshot the project now. AI changes not recorded yet (the quiet period
   * hasn't passed) are saved as their AI round first, so another kind of
   * snapshot never swallows them. Returns the latest snapshot when nothing
   * changed; `created` says whether anything new was recorded.
   */
  snapshot(kind: SnapshotKind, label: string): Promise<{ snapshot: Snapshot; created: boolean }> {
    return this.exclusive(() => this.take(kind, label));
  }

  /**
   * Called once the project's files have been quiet for a while. Records them
   * as an AI round if they differ from what Glimpse last saw: a new snapshot,
   * or the open round grown. Null when nothing changed.
   */
  aiRound(): Promise<Snapshot | null> {
    return this.exclusive(async () => this.recordAiRound(await this.scan()));
  }

  /**
   * The agent waits for the human again, so its round is over: record what it
   * saved since the last snapshot (`flush`, when saves are pending) and start a
   * new snapshot with its next save.
   */
  endRound(flush: boolean): Promise<Snapshot | null> {
    if (!flush && !this.roundOpen) return Promise.resolve(null);
    return this.exclusive(async () => {
      const s = flush ? await this.recordAiRound(await this.scan()) : null;
      this.roundOpen = false;
      return s;
    });
  }

  /**
   * Let Glimpse write into the project. Pending AI changes are recorded and the
   * files backed up first (`before`; usually that is just the latest snapshot),
   * then `write` runs with the files as they are, and the result is saved as
   * `after`. So the timeline holds the state the AI starts from next, and
   * Glimpse's own writes are never mistaken for an AI round.
   */
  guardedWrite<T>(
    before: SnapshotLabel | null,
    after: SnapshotLabel | ((result: T | undefined) => SnapshotLabel),
    write: (current: Scan) => Promise<T>,
  ): Promise<{ backup: Snapshot | undefined; snapshot: Snapshot | undefined; result: T }> {
    return this.exclusive(async () => {
      const current = await this.scan();
      let backup: Snapshot | undefined;
      if (before) backup = (await this.take(before.kind, before.label, current)).snapshot;
      else {
        await this.recordAiRound(current);
        this.baseline = current;
        backup = this.snapshots.at(-1);
      }
      let snapshot: Snapshot | undefined;
      let result: T | undefined;
      try {
        result = await write(current);
      } finally {
        // Whatever got written, even partly, is the new state.
        try {
          const { kind, label } = typeof after === "function" ? after(result) : after;
          snapshot = (await this.take(kind, label, undefined, false)).snapshot;
        } catch (err) {
          this.warn(`glimpse: couldn't save a version (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return { backup, snapshot, result: result as T };
    });
  }

  /**
   * Put the project back to snapshot `id`: delete versioned files the snapshot
   * doesn't have and write every file whose content differs. Files Glimpse
   * can't vouch for are left alone and reported as `skipped`: anything no
   * backup holds (too big, past the file cap, a symlink) and anything the
   * snapshot can't speak for (past its own cap).
   */
  async restore(id: string): Promise<{
    target: Snapshot;
    backup: Snapshot | undefined;
    snapshot: Snapshot | undefined;
    written: string[];
    deleted: string[];
    skipped: string[];
  }> {
    const target = this.get(id);
    if (!target) throw new Error(`No such snapshot: ${id}`);
    const before = { kind: "restore" as const, label: `Before restoring ${target.label}` };
    const after = { kind: "restore" as const, label: `Restored ${target.label}` };
    const { backup, snapshot, result } = await this.guardedWrite(before, after, async (current) => {
      const written: string[] = [];
      const deleted: string[] = [];
      const skipped: string[] = [];
      // Deletions first: on macOS and Windows "Logo.svg" and "logo.svg" are one
      // file, so deleting after writing could remove what was just restored.
      for (const path of Object.keys(current.files)) {
        if (Object.hasOwn(target.files, path)) continue;
        const known = target.cappedAfter === undefined || comparePaths(path, target.cappedAfter) <= 0;
        const dest = known ? await writablePath(this.dir, path) : null;
        if (!dest) {
          skipped.push(path);
          continue;
        }
        await rm(dest, { force: true });
        await removeEmptyFolders(this.dir, dirname(dest));
        deleted.push(path);
      }
      for (const [path, sha] of Object.entries(target.files)) {
        if (current.files[path] === sha) continue;
        const dest = await writablePath(this.dir, path);
        const data = dest && (await this.readObject(sha));
        // Something unversioned is there (too big, past the cap): no backup would hold it.
        if (!dest || !data || (!Object.hasOwn(current.files, path) && (await lexists(dest)))) {
          skipped.push(path);
          continue;
        }
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, data);
        written.push(path);
      }
      return { written, deleted, skipped };
    });
    return { target, backup, snapshot, ...result };
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

  /**
   * The path snapshot `id` stores `path` under: itself, or (`foldCase`, for
   * macOS and Windows, where the live page finds "Logo.PNG" as "logo.png")
   * the one that matches ignoring case and Unicode normalization.
   */
  findPath(id: string, path: string, foldCase: boolean): string | null {
    const snap = this.get(id);
    if (!snap) return null;
    if (Object.hasOwn(snap.files, path)) return path;
    if (!foldCase) return null;
    const want = fold(path);
    return Object.keys(snap.files).find((p) => fold(p) === want) ?? null;
  }

  setThumb(id: string, png: Buffer): Promise<Snapshot> {
    return this.exclusive(async () => {
      const snap = this.get(id);
      if (!snap) throw new Error(`No such snapshot: ${id}`);
      await mkdir(this.root, { recursive: true });
      await writeFile(this.thumbFile(id), png);
      snap.thumb = true;
      await this.save();
      this.onSnapshot(snap, "updated");
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

  /**
   * Snapshot `scan` (or the project now). Unless `flush` is off (it is for
   * "ai" and "initial", and for the state right after Glimpse's own writes),
   * changes since the baseline are recorded as an AI round first.
   */
  private async take(
    kind: SnapshotKind,
    label: string,
    scan?: Scan,
    flush = kind !== "ai" && kind !== "initial",
  ): Promise<{ snapshot: Snapshot; created: boolean }> {
    const now = scan ?? (await this.scan());
    const round = flush ? await this.recordAiRound(now) : null;
    // Anything else marks a point the AI's next saves start over from (a handoff, a checkpoint, Glimpse's own writes).
    if (kind !== "ai") this.roundOpen = false;
    this.baseline = now;
    const last = this.snapshots.at(-1);
    if (last && sameFiles(last.files, now.files)) return { snapshot: last, created: round !== null };
    const seq = (last?.seq ?? 0) + 1;
    const snapshot: Snapshot = { id: `s${seq}`, seq, at: new Date().toISOString(), kind, label, files: now.files, thumb: false };
    if (now.cappedAfter !== undefined) snapshot.cappedAfter = now.cappedAfter;
    this.snapshots.push(snapshot);
    await this.save();
    this.onSnapshot(snapshot, "created");
    await this.prune();
    return { snapshot, created: true };
  }

  /**
   * Record `now` as an AI round if it differs from what Glimpse last saw. While
   * the round is open (the newest snapshot is it, the agent hasn't waited for
   * the human since, and it saved less than ROUND_GAP_MS ago) the snapshot
   * grows instead of a new one starting, so one round is one version.
   */
  private async recordAiRound(now: Scan): Promise<Snapshot | null> {
    const last = this.snapshots.at(-1);
    const changed = changedPaths(this.baseline?.files ?? last?.files ?? {}, now.files);
    if (changed.length === 0) return null;
    if (last?.kind === "ai" && this.roundOpen && Date.now() - Date.parse(last.at) < ROUND_GAP_MS) {
      const whole = changedPaths(this.snapshots.at(-2)?.files ?? {}, now.files);
      last.files = now.files;
      last.at = new Date().toISOString();
      last.label = aiLabel(whole.length > 0 ? whole : changed);
      last.thumb = false;
      if (now.cappedAfter !== undefined) last.cappedAfter = now.cappedAfter;
      else delete last.cappedAfter;
      this.baseline = now;
      await this.save();
      this.onSnapshot(last, "updated");
      return last;
    }
    const { snapshot, created } = await this.take("ai", aiLabel(changed), now);
    this.roundOpen = created;
    return created ? snapshot : null;
  }

  /**
   * Write snapshots.json. Consecutive snapshots share almost all their files, so
   * each one after the first is stored as its changes from the one before it
   * (path → sha, or null when deleted): the index stays small although it is
   * rewritten with every version. Older Glimpse versions skip those entries.
   */
  private async save(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let prev: Files | null = null;
    const entries = this.snapshots.map((s) => {
      const { files, ...meta } = s;
      const entry = prev ? { ...meta, changes: fileChanges(prev, files) } : s;
      prev = files;
      return entry;
    });
    await writeFileAtomic(join(this.root, "snapshots.json"), JSON.stringify(entries));
  }

  /**
   * Drop the oldest AI rounds beyond keepAiRounds (never the newest version),
   * their thumbnails, and every stored file content no remaining version (nor
   * the files as Glimpse last saw them) refers to.
   */
  private async prune(): Promise<void> {
    const rounds = this.snapshots.filter((s) => s.kind === "ai" && s !== this.snapshots.at(-1));
    if (rounds.length <= this.keepAiRounds + PRUNE_SLACK) return;
    const drop = new Set(rounds.slice(0, rounds.length - this.keepAiRounds));
    this.snapshots = this.snapshots.filter((s) => !drop.has(s));
    await this.save();
    const ids = [...drop].map((s) => s.id);
    for (const id of ids) await rm(this.thumbFile(id), { force: true });
    this.onPruned(ids);
    const used = new Set<string>(Object.values(this.baseline?.files ?? {}));
    for (const s of this.snapshots) for (const sha of Object.values(s.files)) used.add(sha);
    const objects = join(this.root, "objects");
    for (const name of await readdir(objects).catch(() => [] as string[])) {
      if (!SHA.test(name) || used.has(name)) continue;
      await rm(join(objects, name), { force: true });
      this.objects.delete(name);
    }
    // A cached hash says its content is stored; that no longer holds for the ones just removed.
    for (const [path, h] of this.hashes) if (!used.has(h.sha)) this.hashes.delete(path);
  }

  /** Hash every versioned file of the project (storing new contents as objects). */
  private async scan(): Promise<Scan> {
    // No prototype, so a file named "__proto__" is just a key.
    const files = Object.create(null) as Files;
    let count = 0;
    let last: string | undefined;
    let capped = false;
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => compareNames(a.name, b.name));
      for (const entry of entries) {
        if (isIgnored(entry.name)) continue;
        if (count >= MAX_FILES) {
          capped = true;
          return;
        }
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        // Symlinks are skipped: they could loop, or point outside the project.
        if (entry.isDirectory()) await walk(join(abs, entry.name), path);
        else if (entry.isFile()) {
          if (isSecretFile(entry.name)) continue;
          const sha = await this.hashFile(join(abs, entry.name), path);
          if (sha) {
            files[path] = sha;
            last = path;
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
    return capped && last !== undefined ? { files, cappedAfter: last } : { files };
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
}

/**
 * Where Glimpse may write (or delete) project file `rel`, or null: inside
 * `dir`, not ignored (git, dependencies, Glimpse's state, junk) and not
 * through a symlink, which could lead outside the project where no backup
 * covers it. Folders that don't exist yet are fine; mkdir makes real ones.
 */
export async function writablePath(dir: string, rel: string): Promise<string | null> {
  if (isIgnored(rel)) return null;
  // Windows 8.3 aliases ("GIT~1") name other files; nothing Glimpse versions is called that.
  if (process.platform === "win32" && rel.split(/[\\/]/).some((p) => /~\d/.test(p))) return null;
  const root = resolve(dir);
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep)) return null;
  let cur = root;
  for (const part of relative(root, full).split(sep)) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (!st) return full;
    if (st.isSymbolicLink()) return null;
    if (cur === full ? !st.isFile() : !st.isDirectory()) return null;
  }
  return full;
}

/** Remove `folder` and its parents up to (not including) `dir` while they are empty. */
async function removeEmptyFolders(dir: string, folder: string): Promise<void> {
  const root = resolve(dir);
  for (let cur = folder; cur.startsWith(root + sep); cur = dirname(cur)) {
    if (!(await rmdir(cur).then(() => true, () => false))) return;
  }
}

/**
 * Write a file so a crash never leaves it half-written: to a temp file, then
 * renamed over it. Windows refuses the rename while another process (a virus
 * scanner, the indexer) has the file open; that passes, so it retries.
 */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((ok) => setTimeout(ok, 40 * attempt));
    }
  }
}
let tmpSeq = 0;

/** Order of names in a folder walk: plain names first, then dot-files and dot-folders (mostly tooling). */
function compareNames(a: string, b: string): number {
  const da = a.startsWith(".");
  if (da !== b.startsWith(".")) return da ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order of two project paths in the walk. */
function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = compareNames(pa[i]!, pb[i]!);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function aiLabel(changed: string[]): string {
  const shown = changed.slice(0, 3).join(", ");
  const more = changed.length > 3 ? ` +${changed.length - 3} more` : "";
  return `AI edited ${shown}${more}`;
}

function sameFiles(a: Files, b: Files): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** What changed from `before` to `after`: path → its new sha, or null when it was deleted. */
function fileChanges(before: Files, after: Files): Record<string, string | null> {
  const out = Object.create(null) as Record<string, string | null>;
  for (const k of Object.keys(after)) if (!Object.hasOwn(before, k) || before[k] !== after[k]) out[k] = after[k]!;
  for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) out[k] = null;
  return out;
}

/** `before` with fileChanges applied. */
function applyChanges(before: Files, changes: Record<string, string | null>): Files {
  const out = Object.assign(Object.create(null) as Files, before);
  for (const [k, sha] of Object.entries(changes)) {
    if (sha === null) delete out[k];
    else if (typeof sha === "string") out[k] = sha;
  }
  return out;
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

/** Whether anything (a file, folder or link, even a dangling one) is at `p`. */
export async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
