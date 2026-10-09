import { useSyncExternalStore } from "react";
import type { Change } from "@glimpse/core";
import { capturePreview, captureUrl, drawMarkers, within } from "./capture";
import { marksFor, pageToView } from "./markers";
import { DEVICE_WIDTH, store } from "./store";

/**
 * The version loop: snapshots of the project files (the timeline), viewing and
 * comparing them, and design variants the agent prepares for one element.
 * Kept apart from the edit store; the server owns the data, this mirrors it.
 */

export type SnapshotKind = "initial" | "ai" | "handoff" | "source" | "restore" | "variant" | "manual";

export interface PublicSnapshot {
  id: string;
  seq: number;
  at: string;
  kind: SnapshotKind;
  label: string;
  fileCount: number;
  thumb: boolean;
}

export interface VariantJob {
  id: string;
  src?: string;
  /** e.g. `button "Order now"` */
  label: string;
  count: number;
  hint?: string;
  createdAt: string;
  /** Variants (1-based) the agent has written files for. */
  ready: number[];
}

/** The project file a variants job is about (`src` is "file:line:col"); the entry page when unknown. */
export function variantPage(job: VariantJob): string {
  const file = job.src?.match(/^(.+):\d+:\d+$/)?.[1] ?? "";
  return file.split("/").map(encodeURIComponent).join("/");
}

/** What the canvas area shows instead of the live page. */
export type LoopView =
  | { kind: "live" }
  | { kind: "snapshot"; id: string }
  /** `after: null` means the page as it is now. `back` is where Esc returns to. */
  | { kind: "compare"; before: string; after: string | null; back: LoopView }
  | { kind: "variants"; job: string };

interface LoopState {
  timelineOpen: boolean;
  snapshots: PublicSnapshot[];
  /** False when the server has no version history (an older Glimpse): the UI says so instead of failing. */
  historyAvailable: boolean;
  view: LoopView;
  jobs: VariantJob[];
  /** Element the "Variants…" dialog is open for. */
  variantsFor: string | null;
  /** Snapshot whose restore awaits confirmation. */
  confirmRestore: string | null;
  /** Bumped per snapshot id when its thumbnail arrives, to get past the image cache. */
  thumbRev: Record<string, number>;
  /** Bumped per variant cell ("job:k") when the agent saves a file of it. */
  cellRev: Record<string, number>;
}

const TIMELINE_KEY = "glimpse.timeline";
const UNSUPPORTED = "This Glimpse server doesn't support that yet. Update glimpse-ui and restart it.";

class Loop {
  state: LoopState = {
    timelineOpen: readFlag(TIMELINE_KEY, true),
    snapshots: [],
    historyAvailable: true,
    view: { kind: "live" },
    jobs: [],
    variantsFor: null,
    confirmRestore: null,
    thumbRev: {},
    cellRev: {},
  };
  private listeners = new Set<() => void>();
  private capturing = new Set<string>();
  /** Versions the backfill already tried: one that can't be pictured isn't loaded again on every reconnect. */
  private backfilled = new Set<string>();
  /** Set while we restore: the backup snapshot shows the old page, not the reloading one. */
  private restoring = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  set(patch: Partial<LoopState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  snapshot(id: string): PublicSnapshot | undefined {
    return this.state.snapshots.find((s) => s.id === id);
  }

  /** The canvas shows the live, editable page (not a version, comparison or variants). */
  get live(): boolean {
    return this.state.view.kind === "live";
  }

  /** Editor shortcuts (delete, nudge, undo…) would act on a page that isn't on screen, or under a dialog. */
  get blocksEditorKeys(): boolean {
    return !this.live || this.state.variantsFor !== null || this.state.confirmRestore !== null;
  }

  toggleTimeline(open = !this.state.timelineOpen): void {
    writeFlag(TIMELINE_KEY, open);
    this.set({ timelineOpen: open });
  }

  // ── Views ────────────────────────────────────────────

  viewSnapshot(id: string): void {
    // Selection belongs to the live page; don't leave its outline over another version.
    if (store.state.selected || store.state.hovered) store.set({ selected: null, hovered: null });
    this.set({ view: { kind: "snapshot", id } });
  }

  compare(before: string, after: string | null = null): void {
    this.leaveLivePage();
    const cur = this.state.view;
    this.set({ view: { kind: "compare", before, after, back: cur.kind === "compare" ? cur.back : cur } });
  }

  showVariants(job: string): void {
    this.leaveLivePage();
    this.set({ view: { kind: "variants", job } });
  }

  /** The Inspector would otherwise keep editing the hidden live page, unseen. */
  private leaveLivePage(): void {
    if (store.state.selected || store.state.hovered || store.state.multi.length) store.set({ selected: null, hovered: null });
  }

  backToLive(): void {
    if (!this.live) this.set({ view: { kind: "live" } });
  }

  /** Leave the comparison for wherever it was opened from. */
  exitCompare(): void {
    const v = this.state.view;
    if (v.kind !== "compare") return;
    const back = v.back.kind === "snapshot" && !this.snapshot(v.back.id) ? { kind: "live" as const } : v.back;
    this.set({ view: back });
  }

  /** Before/after of the AI's last round: the version before the newest "ai" one. */
  lastRound(): { before: PublicSnapshot; after: PublicSnapshot } | null {
    const list = this.state.snapshots;
    for (let i = list.length - 1; i > 0; i--) if (list[i]!.kind === "ai") return { before: list[i - 1]!, after: list[i]! };
    return null;
  }

  // ── History ──────────────────────────────────────────

  async refreshHistory(): Promise<void> {
    try {
      const body = await api<{ snapshots?: PublicSnapshot[] }>("/api/history");
      this.set({ historyAvailable: true, snapshots: bySeq(body.snapshots ?? []) });
      void this.backfillThumbs();
    } catch (e) {
      // An older server has no history. Unreachable: keep what we have; the reconnect refreshes.
      if (message(e) === UNSUPPORTED) this.set({ historyAvailable: false, snapshots: [] });
    }
    this.dropMissingView();
  }

  /** "Save version": snapshot the files as they are now. Unchanged files give back the latest version instead of a new one. */
  async saveVersion(label?: string): Promise<void> {
    try {
      const res = await api<{ snapshot: PublicSnapshot; created: boolean }>("/api/history/snapshot", label ? { label } : {});
      this.onSnapshot(res.snapshot);
      if (!res.created) store.activity("info", `Nothing changed since “${res.snapshot.label}”, so no new version was saved.`);
    } catch (e) {
      store.activity("warn", `Couldn't save a version: ${message(e)}`);
    }
  }

  /** Put the project files back to snapshot `id`. The server backs up the current files first. */
  async restore(id: string): Promise<void> {
    const s = this.snapshot(id);
    this.restoring = true;
    try {
      // `backup` is the files as they were (usually a version saved already), `snapshot` the restored state.
      const res = await api<{ restored: PublicSnapshot; backup?: PublicSnapshot; snapshot?: PublicSnapshot; skipped?: string[] }>(
        `/api/history/${enc(id)}/restore`,
        {},
      );
      for (const x of [res.backup, res.snapshot]) if (x) this.onSnapshot(x);
      store.activity("info", `Restored “${s?.label ?? id}”.${res.backup ? ` The files before it are kept as “${res.backup.label}”.` : ""}`);
      if (res.skipped?.length) store.activity("warn", leftAlone(res.skipped));
      this.set({ view: { kind: "live" }, confirmRestore: null });
    } finally {
      // The server reloads the preview right after; let that settle before capturing it again.
      setTimeout(() => (this.restoring = false), 2500);
    }
  }

  /** A snapshot was created (WebSocket or our own request): add it and give it a thumbnail. */
  onSnapshot(s: PublicSnapshot): void {
    if (!s?.id) return;
    const merged = { ...s, thumb: s.thumb || !!this.snapshot(s.id)?.thumb };
    this.set({ historyAvailable: true, snapshots: bySeq([...this.state.snapshots.filter((x) => x.id !== s.id), merged]) });
    if (!merged.thumb) void this.captureThumb(merged);
  }

  /**
   * Versions made while no editor was listening (always the "Opened in
   * Glimpse" one, taken when the server starts) get their thumbnails now,
   * newest first and one at a time, each from its own snapshot page.
   */
  private async backfillThumbs(): Promise<void> {
    const missing = this.state.snapshots.filter((s) => !s.thumb && !this.backfilled.has(s.id)).slice(-BACKFILL_MAX).reverse();
    for (const s of missing) {
      this.backfilled.add(s.id);
      await this.captureThumb(s, false);
    }
  }

  /**
   * Thumbnails are rendered here, in the browser. Normally that's the live
   * preview a moment after the snapshot (once the AI's change has morphed in).
   * When the live page isn't what the snapshot holds (a version is on screen,
   * unsent edits, a just-sent handoff, a backup taken before a restore or a
   * chosen variant) the snapshot is loaded off-screen and captured instead.
   */
  private async captureThumb(s: PublicSnapshot, fromLive = true): Promise<void> {
    if (this.capturing.has(s.id) || this.snapshot(s.id)?.thumb) return;
    this.capturing.add(s.id);
    let outdated = false;
    try {
      const doc = store.bridge?.doc;
      await sleep(600);
      // Rendering a page to a picture holds the main thread: wait for a quiet moment (not mid-drag).
      await idle();
      const liveMatches =
        fromLive &&
        this.live &&
        !this.restoring &&
        store.state.view === "editor" &&
        store.pendingCount === 0 &&
        // Backups taken right before Glimpse writes files: the live page moves on at once.
        s.kind !== "handoff" &&
        s.kind !== "restore" &&
        s.kind !== "variant" &&
        !!doc?.defaultView &&
        store.bridge?.doc === doc;
      const width = DEVICE_WIDTH[store.state.device] ?? Math.max(800, doc?.documentElement.clientWidth ?? 1280);
      const opts = { maxWidth: THUMB_WIDTH, maxHeight: Math.round(width * 0.75), maxElements: THUMB_MAX_ELEMENTS };
      // A terminal UI or native GUI: the version's scene file, drawn the way the canvas draws it.
      const sceneThumb = store.sceneSurface?.thumbnail;
      // A React app's snapshot is source that Vite has to build: served as static files it renders blank, so only the live page pictures it.
      const staticPage = store.state.project?.target !== "react";
      const dataUrl = sceneThumb
        ? await sceneThumb(s.id, THUMB_WIDTH)
        : ((liveMatches ? await capturePreview(doc, opts) : null) ??
          (staticPage ? await captureUrl(`/snapshot/${enc(s.id)}/`, { width, height: Math.round(width * 0.75) }, opts) : null));
      if (!dataUrl || !this.snapshot(s.id)) return;
      // An AI round that grew while we captured needs a new picture.
      if (this.snapshot(s.id)!.at !== s.at) return void (outdated = true);
      const res = await fetch(`/api/history/${enc(s.id)}/thumb`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) return;
      this.set({
        snapshots: this.state.snapshots.map((x) => (x.id === s.id ? { ...x, thumb: true } : x)),
        thumbRev: { ...this.state.thumbRev, [s.id]: (this.state.thumbRev[s.id] ?? 0) + 1 },
      });
    } catch {
      // thumbnails are a nicety; the card shows a placeholder instead
    } finally {
      this.capturing.delete(s.id);
    }
    const now = this.snapshot(s.id);
    if (outdated && now) void this.captureThumb(now, fromLive);
  }

  // ── Variants ─────────────────────────────────────────

  async refreshVariants(): Promise<void> {
    try {
      const body = await api<{ jobs?: VariantJob[] }>("/api/variants");
      this.set({ jobs: body.jobs ?? [] });
    } catch (e) {
      if (message(e) === UNSUPPORTED) this.set({ jobs: [] });
    }
    this.dropMissingView();
  }

  openVariants(nodeId: string): void {
    this.set({ variantsFor: nodeId });
  }

  async requestVariants(input: { src?: string; label: string; count: number; hint?: string }): Promise<void> {
    const res = await api<{ job: VariantJob; seq: number }>("/api/variants", input);
    this.upsertJob(res.job);
    store.activity("handoff", `Asked the AI for ${input.count} variants of ${input.label} (#${res.seq})`);
    void store.refreshHandoffs();
  }

  /** Copy variant k into the project and go back to the (now updated) live page. */
  async choose(id: string, k: number): Promise<void> {
    const job = this.state.jobs.find((j) => j.id === id);
    const res = await api<{ files?: string[]; skipped?: string[]; backup?: PublicSnapshot; snapshot?: PublicSnapshot }>(`/api/variants/${enc(id)}/choose`, { k });
    for (const x of [res.backup, res.snapshot]) if (x) this.onSnapshot(x);
    const files = res.files ?? [];
    store.activity("info", `Used variant ${k} of ${job?.label ?? "the element"}${files.length ? `: wrote \`${files.join("`, `")}\`` : ""}`);
    if (res.skipped?.length) store.activity("warn", leftAlone(res.skipped));
    this.removeJob(id);
    this.backToLive();
  }

  async discard(id: string): Promise<void> {
    try {
      await api(`/api/variants/${enc(id)}/discard`, {});
    } catch (e) {
      store.activity("warn", `Couldn't discard the variants: ${message(e)}`);
      return;
    }
    this.removeJob(id);
  }

  private upsertJob(job: VariantJob): void {
    if (!job?.id) return;
    const i = this.state.jobs.findIndex((j) => j.id === job.id);
    const jobs = i < 0 ? [...this.state.jobs, job] : this.state.jobs.map((j) => (j.id === job.id ? job : j));
    this.set({ jobs });
  }

  private removeJob(id: string): void {
    this.set({ jobs: this.state.jobs.filter((j) => j.id !== id) });
    this.dropMissingView();
  }

  /** If what's on screen no longer exists (discarded, history reset), go back to the live page. */
  private dropMissingView(): void {
    const v = this.state.view;
    const gone =
      (v.kind === "snapshot" && !this.snapshot(v.id)) ||
      (v.kind === "compare" && (!this.snapshot(v.before) || (v.after !== null && !this.snapshot(v.after)))) ||
      (v.kind === "variants" && !this.state.jobs.some((j) => j.id === v.job));
    if (gone) this.set({ view: { kind: "live" } });
  }

  // ── Live updates ─────────────────────────────────────

  /** Messages from the Glimpse server's websocket (see live.ts). */
  onMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case "snapshot":
        this.onSnapshot(msg.snapshot as PublicSnapshot);
        break;
      case "snapshot-updated": {
        // A thumbnail arrived (maybe from another editor tab): show it, past the image cache.
        // Or the AI's round grew: its old thumbnail is gone, so take a new one.
        const s = msg.snapshot as PublicSnapshot;
        if (!s?.id || !this.snapshot(s.id)) break;
        this.set({
          snapshots: this.state.snapshots.map((x) => (x.id === s.id ? { ...x, ...s } : x)),
          thumbRev: { ...this.state.thumbRev, [s.id]: (this.state.thumbRev[s.id] ?? 0) + 1 },
        });
        if (!s.thumb) void this.captureThumb(this.snapshot(s.id)!);
        break;
      }
      case "snapshots-pruned": {
        // The server dropped its oldest AI rounds (it keeps a few hundred).
        const ids = new Set(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
        this.set({ snapshots: this.state.snapshots.filter((x) => !ids.has(x.id)) });
        this.dropMissingView();
        break;
      }
      case "variants":
        this.upsertJob(msg.job as VariantJob);
        break;
      case "variant-updated": {
        const key = `${String(msg.id)}:${Number(msg.k)}`;
        this.set({ cellRev: { ...this.state.cellRev, [key]: (this.state.cellRev[key] ?? 0) + 1 } });
        break;
      }
      case "variants-removed":
        this.removeJob(String(msg.id));
        break;
    }
  }
}

export const loop = new Loop();

export function useLoop(): LoopState {
  return useSyncExternalStore(loop.subscribe, loop.getSnapshot);
}

/** Whether the live page is on screen (no version, comparison or variants over it). */
export function useLoopLive(): boolean {
  return useSyncExternalStore(loop.subscribe, () => loop.live);
}

/** Just the timeline toggle, so the whole editor doesn't re-render on every loop update. */
export function useTimelineOpen(): boolean {
  return useSyncExternalStore(loop.subscribe, () => loop.state.timelineOpen);
}

/** Load history and variant jobs now and after every reconnect (the server may have restarted). */
export function initLoop(): () => void {
  let connected = store.state.connected;
  const refresh = () => {
    void loop.refreshHistory();
    void loop.refreshVariants();
  };
  refresh();
  return store.subscribe(() => {
    if (store.state.connected && !connected) refresh();
    connected = store.state.connected;
  });
}

export interface HandoffShots {
  /** The edited UI with a numbered marker on every change that has a box. */
  after: string | null;
  /** The same view before the edits, without markers, when Glimpse can draw it. */
  before: string | null;
}

/**
 * Screenshots for a handoff: the page (or mock) the human is editing with a
 * numbered outline on each change (the numbers are the changes' `mark`s), and
 * a clean picture of the same view before the edits: the latest version from
 * the timeline for a static page, the unedited mock for a scene. Each never
 * holds sending up for more than 3 s; React pages get no "before" (their
 * snapshots only render through Vite).
 */
export async function handoffScreenshots(changes: readonly Change[]): Promise<HandoffShots> {
  const scene = store.sceneSurface;
  if (scene?.screenshot) {
    const [after, before] = await Promise.all([
      within(scene.screenshot(changes), 3000, null),
      scene.screenshotBefore ? within(scene.screenshotBefore(), 3000, null) : Promise.resolve(null),
    ]);
    return { after, before: after ? before : null };
  }
  const doc = store.bridge?.doc;
  const win = doc?.defaultView;
  const width = doc?.documentElement.clientWidth ?? 0;
  const scroll = { x: win?.scrollX ?? 0, y: win?.scrollY ?? 0 };
  // One screen of a tall window is plenty, and keeps the PNG well under the server's 5 MB.
  const opts = { maxWidth: 1280, maxHeight: 1600 };
  const after = capturePreview(doc, { ...opts, atScroll: true }).then((png) =>
    png ? drawMarkers(png, marksFor(changes, (b) => pageToView(b, scroll)), width) : null,
  );
  const latest = loop.state.snapshots.at(-1);
  const before =
    latest && win && store.state.project?.target !== "react"
      ? captureUrl(`/snapshot/${enc(latest.id)}/`, { width: win.innerWidth, height: win.innerHeight }, { ...opts, scrollTo: scroll })
      : Promise.resolve(null);
  const [a, b] = await Promise.all([within(after, 3000, null), within(before, 3000, null)]);
  return { after: a, before: a ? b : null };
}

/** The changes numbered for the screenshot's markers (1, 2, … in list order). */
export function numbered(changes: readonly Change[]): Change[] {
  return changes.map((c, i) => ({ ...c, mark: i + 1 }));
}

/**
 * Versions and variants are for looking, not using: keep links and forms in
 * them from navigating away, and let Esc work while focus is inside the page.
 * The pages are same-origin, so we can listen inside them.
 */
export function readOnly(doc: Document | null | undefined, onEscape?: () => void): void {
  if (!doc) return;
  for (const type of ["click", "submit", "auxclick"]) {
    doc.addEventListener(
      type,
      (e) => {
        const t = e.target as Element | null;
        if (type === "submit" || t?.closest?.("a[href], button[type=submit], input[type=submit]")) e.preventDefault();
      },
      true,
    );
  }
  if (onEscape) doc.addEventListener("keydown", (e) => e.key === "Escape" && onEscape());
}

/** "just now", "5m ago", "3h ago", "2d ago" (the sidebar's `ago`, phrased for a timeline). */
export function since(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const THUMB_WIDTH = 320;
/** At most this many missing thumbnails are filled in when the history loads. */
const BACKFILL_MAX = 12;
/** Pages bigger than this get no thumbnail: copying the whole DOM into a picture would freeze the editor. */
const THUMB_MAX_ELEMENTS = 6000;

export const KIND_TITLE: Record<SnapshotKind, string> = {
  initial: "First version",
  ai: "AI round",
  handoff: "Sent to AI",
  source: "Edit source",
  restore: "Restore",
  variant: "Variant",
  manual: "Saved by you",
};

export function enc(id: string): string {
  return encodeURIComponent(id);
}

/**
 * JSON API call (POST when `body` is given). A Glimpse server that predates
 * an endpoint answers with the editor's HTML instead of JSON; report that
 * plainly rather than as a parse error.
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new Error(res.ok || res.status === 404 ? UNSUPPORTED : res.statusText);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? (res.status === 404 ? UNSUPPORTED : res.statusText));
  return data;
}

/** Why a restore or variant didn't touch some files. */
function leftAlone(paths: string[]): string {
  const one = paths.length === 1;
  const shown = paths.slice(0, 3).map((p) => `\`${p}\``).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return `Left ${shown} as ${one ? "it is" : "they are"}: Glimpse has no backup of ${one ? "it" : "them"} (too big, past the file limit, a link, or its own folders), so it doesn't overwrite or delete ${one ? "it" : "them"}.`;
}

function bySeq(list: PublicSnapshot[]): PublicSnapshot[] {
  return [...list].sort((a, b) => a.seq - b.seq);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves once the browser is idle (or after `timeout` ms at the latest). */
function idle(timeout = 3000): Promise<void> {
  return new Promise((r) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => r(), { timeout }) : setTimeout(r, 0)));
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // private mode or storage blocked: the toggle just isn't remembered
  }
}
