import { useSyncExternalStore } from "react";
import {
  applyOp,
  cloneScene,
  followRenumbered,
  OpLog,
  rebaseOps,
  Scrollback,
  type LogEntry,
  type Op,
  type Scene,
  type SceneFileExtras,
  type SceneNode,
  type SceneTheme,
} from "@glimpse/core";
import { followOps } from "./hmr";
import { onLive, sendLive, type LiveMessage } from "./live";
import { absBox, DEFAULT_CELL, hostTheme, isSceneContainer, isSceneTarget, measureCell, placeWidget, type Cell, type SceneTarget } from "./scene-geometry";
import { store } from "./store";
import type { Surface } from "./surface";

/**
 * Scene mode: editing the mock of a terminal UI or native GUI that the agent
 * described in glimpse.scene.json, instead of a live page. The scene file is
 * the base of a plain op log (no DOM bridge); the canvas draws it. When the
 * agent rewrites the file, unsent edits are replayed on the new version by
 * node id. Edit source and Send to AI write the edited scene back; the echo of
 * those writes is recognised by version. Also holds the state of the real
 * app running in Glimpse's terminal.
 */

/** GET /api/scene, and the websocket's "scene" message. */
export interface ScenePayload {
  exists: boolean;
  file: string;
  scene?: Scene;
  errors?: string[];
  format?: "nested" | "flat";
  extras?: SceneFileExtras;
  version?: string;
  invalid?: { message: string; line?: number; column?: number };
}

/** The real app in Glimpse's terminal (websocket hello + term-* messages). */
export interface TerminalInfo {
  /** What runs (or ran) there; null until something was started. */
  command: string | null;
  running: boolean;
  mode: "pty" | "pipe";
  /** Why there is no real terminal (pipe mode). */
  fallbackReason: string | null;
  /** A terminal UI restarts when its code is saved. */
  autoRestart: boolean;
  /** A real terminal (node-pty) is available. */
  pty?: boolean;
  exit: { code: number | null; signal: string | null } | null;
  error: string | null;
}

interface SceneState {
  /** The project is a terminal UI or native GUI. */
  active: boolean;
  target: SceneTarget;
  status: "loading" | "ready" | "missing" | "error";
  /** The scene file, project-relative. */
  file: string;
  extras: SceneFileExtras;
  /** Problems in the file that were patched over; shown as warnings. */
  errors: string[];
  /** The file isn't valid JSON right now: the last good scene stays on screen. */
  invalid: { message: string; line?: number; column?: number } | null;
  /** Couldn't load the scene at all (server unreachable, …). */
  loadError: string | null;
  /** Which platform's look a native mock is drawn in (a preview choice; not written anywhere). */
  theme: SceneTheme;
  /** Node whose text is being edited in place. */
  editing: string | null;
  cell: Cell;
  terminal: TerminalInfo;
  /** The terminal (or log) pane next to the mock; `size` is its width or height in px (unset: 45%). */
  dock: Dock;
}

interface Dock {
  open: boolean;
  side: "right" | "bottom";
  size?: number;
}

const NO_TERMINAL: TerminalInfo = { command: null, running: false, mode: "pty", fallbackReason: null, autoRestart: true, exit: null, error: null };
/** Keep this much terminal output for a pane that mounts later (the server keeps 256 KB). */
const TERM_BUFFER = 512 * 1024;

const DOCK_KEY = "glimpse.dock";

/** How long after Glimpse writes the scene file its file event can still come in (the watcher waits for writes to settle). */
const OWN_ECHO_MS = 10_000;

class SceneMode {
  state: SceneState = {
    active: false,
    target: "tui",
    status: "loading",
    file: "glimpse.scene.json",
    extras: {},
    errors: [],
    invalid: null,
    loadError: null,
    theme: hostTheme(),
    editing: null,
    cell: DEFAULT_CELL,
    terminal: NO_TERMINAL,
    dock: { open: true, side: "bottom", ...readDock() },
  };
  /** Version (content hash) of the scene file the op log's base came from; null when it didn't exist. */
  version: string | null = null;
  /**
   * Versions Glimpse wrote itself (Edit source, Send to AI), with when: their file events are echoes, not news.
   * Each is an echo once, and only shortly after the write: the agent writing the same content later (say,
   * reverting to it) is news.
   */
  private own = new Map<string, number>();
  /** Requests that may write the scene file are in flight: scene messages wait for them. */
  private writing = 0;
  private queued: ScenePayload[] = [];
  /** Unsent edits kept while the scene file is missing, replayed when it comes back. */
  private orphaned: readonly LogEntry[] = [];
  private loadSeq = 0;
  private nextId = 1;
  private themeChosen = false;
  private listeners = new Set<() => void>();
  /** Terminal output since the last start, for a pane that mounts later. */
  private term = new Scrollback(TERM_BUFFER);
  private termListeners = new Set<(data: string | null) => void>();
  /** Set by the canvas: pictures of the mock for handoffs and the timeline. */
  capture: { screenshot(): Promise<string | null>; thumbnail(id: string, maxWidth: number): Promise<string | null> } | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  set(patch: Partial<SceneState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Follow the project (it can become a terminal UI later) and the server's messages. */
  init(): () => void {
    let target: string | undefined;
    let reloadKey = store.state.reloadKey;
    void measureCell().then((cell) => this.set({ cell }));
    const sync = () => {
      const t = store.state.project?.target;
      if (t !== target) {
        target = t;
        if (isSceneTarget(t)) this.activate(t);
        else this.deactivate();
      }
      // Discard (or a reload from the server): read the file again. Discard already dropped the edits.
      if (store.state.reloadKey !== reloadKey) {
        reloadKey = store.state.reloadKey;
        if (this.state.active) void this.reload();
      }
    };
    sync();
    const offStore = store.subscribe(sync);
    const offLive = onLive((msg) => this.onMessage(msg));
    return () => {
      offStore();
      offLive();
    };
  }

  private activate(target: SceneTarget): void {
    store.sceneSurface = this.surface;
    store.log = null;
    this.orphaned = [];
    this.version = null;
    // A native app opens its own window: its log pane starts closed unless the human opened it before.
    const dock = target === "native" && readDock().open === undefined ? { ...this.state.dock, open: this.state.terminal.running } : this.state.dock;
    this.set({ active: true, target, status: "loading", errors: [], invalid: null, loadError: null, editing: null, dock });
    void this.reload();
  }

  private deactivate(): void {
    if (!this.state.active) return;
    if (store.sceneSurface === this.surface) store.sceneSurface = null;
    store.log = null;
    this.set({ active: false, editing: null });
    store.set({ selected: null, hovered: null });
  }

  /** Read the scene file again; unsent edits are replayed on top (none after Discard). */
  async reload(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const res = await fetch("/api/scene");
      const body = (await res.json()) as ScenePayload & { error?: string };
      if (seq !== this.loadSeq || !this.state.active) return;
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      this.receive(body);
    } catch (e) {
      if (seq === this.loadSeq) this.set({ status: store.log ? "ready" : "error", loadError: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A scene from the server: make it the base and replay unsent edits on it. */
  private receive(p: ScenePayload): void {
    const fresh = { file: p.file, loadError: null };
    if (!p.exists || !p.scene) {
      // Gone for a moment (the agent deletes and writes it again): its unsent edits wait for it to come back.
      if (store.log?.entries.length) this.orphaned = store.log.entries;
      store.log = null;
      this.version = null;
      this.set({ ...fresh, status: "missing", errors: [], invalid: null, editing: null });
      store.set({ selected: null, hovered: null });
      return;
    }
    if (p.invalid) {
      // Keep the last good scene (the agent is probably halfway through writing the file).
      if (!store.log) this.adopt(p.scene, []);
      this.set({ ...fresh, status: "ready", invalid: p.invalid, errors: [] });
      return;
    }
    this.version = p.version ?? null;
    const extras = p.extras ?? {};
    const log = store.log;
    // The file now says exactly what is on screen: only the notes for the AI are left to replay.
    const entries = !log ? this.orphaned : sameScene(p.scene, log.scene) ? notesOnly(log.entries) : log.entries;
    this.orphaned = [];
    this.adopt(p.scene, entries);
    const theme = !this.themeChosen && extras.theme ? { theme: extras.theme } : {};
    this.set({ ...fresh, ...theme, status: "ready", invalid: null, errors: p.errors ?? [], extras });
  }

  /**
   * Start a new op log on `base` and replay `entries` on it, re-targeted by node id (following widgets
   * without an id in the file that the agent's change renumbered).
   */
  private adopt(base: Scene, entries: readonly LogEntry[]): void {
    const before = store.log?.base;
    const { moved, ambiguous } = before && entries.length ? followRenumbered(before, base) : { moved: new Map<string, string>(), ambiguous: new Set<string>() };
    const log = new OpLog(base);
    let dropped = 0;
    for (const entry of entries) {
      let ops: Op[] | null;
      try {
        ops = rebaseOps(log.scene, followOps(entry.ops, moved, log.scene));
      } catch {
        ops = null;
      }
      if (!ops) {
        dropped++;
        continue;
      }
      try {
        log.apply(...ops);
      } catch {
        dropped++;
      }
    }
    store.log = log;
    if (dropped) store.activity("warn", `${dropped} of your edits no longer fit the scene after the AI's change and were dropped`);
    if (entries.some((e) => e.ops.some((op) => "node" in op && ambiguous.has(op.node))))
      store.activity("warn", "The AI's change renumbered widgets that have no id in the scene file: check that your edits are still on the right ones");
    const nodes = log.scene.nodes;
    const multi = store.state.multi.filter((id) => nodes[id]);
    const selected = store.state.selected && nodes[store.state.selected] ? store.state.selected : (multi[0] ?? null);
    if (this.state.editing && !nodes[this.state.editing]) this.set({ editing: null });
    store.set({ selected, multi, hovered: null, stale: dropped > 0 });
  }

  private onMessage(msg: LiveMessage): void {
    switch (msg.type) {
      case "hello": {
        // The terminal's catch-up (term-start, term-data, term-exit) follows.
        this.term.clear();
        this.emitTerm(null);
        const t = msg.terminal as Partial<TerminalInfo> | undefined;
        if (t) this.set({ terminal: { ...NO_TERMINAL, ...t, exit: null, error: null } });
        // Reconnected (the server may have restarted): the file may have changed meanwhile.
        if (this.state.active && store.log) void this.reload();
        break;
      }
      case "scene":
        if (!this.state.active) break;
        if (this.writing > 0) this.queued.push(msg as unknown as ScenePayload);
        else this.onScene(msg as unknown as ScenePayload);
        break;
      case "term-start":
        this.term.clear();
        this.emitTerm(null);
        this.set({
          terminal: { ...this.state.terminal, command: String(msg.command ?? ""), running: true, mode: msg.mode === "pipe" ? "pipe" : "pty", exit: null, error: null },
        });
        break;
      case "term-data": {
        const data = String(msg.data ?? "");
        this.term.push(data);
        this.emitTerm(data);
        break;
      }
      case "term-exit":
        this.set({ terminal: { ...this.state.terminal, running: false, exit: { code: (msg.code as number | null) ?? null, signal: (msg.signal as string | null) ?? null } } });
        break;
      case "term-error":
        this.set({ terminal: { ...this.state.terminal, error: String(msg.message ?? "") } });
        break;
      case "term-auto-restart":
        this.set({ terminal: { ...this.state.terminal, autoRestart: msg.enabled !== false } });
        break;
    }
  }

  /** The scene file changed on disk. */
  private onScene(p: ScenePayload): void {
    const ownAt = p.version ? this.own.get(p.version) : undefined;
    if (p.version) this.own.delete(p.version);
    const echo = ownAt !== undefined && Date.now() - ownAt < OWN_ECHO_MS;
    if (p.exists && !p.invalid && p.version && (echo || p.version === this.version)) {
      // Our own write coming back (or no change): the edits on screen already match it.
      if (this.state.invalid) this.set({ invalid: null });
      this.set({ errors: p.errors ?? [] });
      return;
    }
    this.receive(p);
  }

  /**
   * Wrap a request that may write the scene file (Edit source, Send to AI).
   * Scene updates arriving meanwhile wait for its answer, so the echo of our own
   * write is told from the agent's by the version the server returns. A 409
   * (the file changed since it was read) loads the new version, replays the
   * edits on it and says so.
   */
  async writes(request: Promise<Response>): Promise<Response> {
    if (!this.state.active) return request;
    this.writing++;
    let written: string | null = null;
    try {
      const res = await request;
      if (res.ok) {
        const body = (await res.clone().json().catch(() => ({}))) as { version?: string | null; sceneVersion?: string | null };
        written = body.version ?? body.sceneVersion ?? null;
        return res;
      }
      if (res.status !== 409) return res;
      const refused = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      const was = this.version;
      await this.reload();
      // Only a new version on disk is news; a file that is still broken keeps the server's reason.
      const message =
        this.version !== was && !this.state.invalid
          ? `${this.state.file} changed on disk while you were editing. Glimpse loaded the new version and replayed your edits on it: check them and try again.`
          : (refused ?? `${this.state.file} can't be written right now.`);
      return new Response(JSON.stringify({ error: message }), { status: 409, headers: { "content-type": "application/json" } });
    } finally {
      this.writing--;
      if (written) {
        this.version = written;
        this.own.set(written, Date.now());
      }
      if (this.writing === 0) {
        const queued = this.queued.splice(0);
        for (const p of queued) this.onScene(p);
      }
    }
  }

  /**
   * Extra body fields for Edit source and Send to AI: the edited scene and the version it is based on. A handoff
   * while the file isn't valid JSON goes without it (nothing can be written into the file), so notes and edits
   * still reach the agent, as instructions.
   */
  body(opts: { handoff?: boolean } = {}): { scene?: Scene; sceneVersion?: string } {
    if (!this.state.active || !store.log) return {};
    if (opts.handoff && this.state.invalid) return {};
    return { scene: store.log.scene, ...(this.version !== null && { sceneVersion: this.version }) };
  }

  /** Show, hide, move or resize the terminal pane (remembered in this browser). */
  setDock(patch: Partial<Dock>): void {
    const dock = { ...this.state.dock, ...patch };
    this.set({ dock });
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(dock));
    } catch {
      // storage blocked: the pane just isn't remembered
    }
  }

  setTheme(theme: SceneTheme): void {
    this.themeChosen = true;
    this.set({ theme });
  }

  /* ── Terminal ─────────────────────────────────────────────────────── */

  /** Hear terminal output as it arrives; null means a new run started (clear the screen). */
  onTerm(fn: (data: string | null) => void): () => void {
    this.termListeners.add(fn);
    return () => this.termListeners.delete(fn);
  }

  get termBuffer(): string {
    return this.term.text();
  }

  private emitTerm(data: string | null): void {
    for (const fn of this.termListeners) fn(data);
  }

  /** Run (or restart) the real app. The command itself comes from the server, never from here. */
  run(): void {
    this.set({ terminal: { ...this.state.terminal, error: null } });
    if (!sendLive({ type: "term-restart" })) this.set({ terminal: { ...this.state.terminal, error: "Not connected to Glimpse" } });
  }

  stop(): void {
    sendLive({ type: "term-stop" });
  }

  input(data: string): void {
    sendLive({ type: "term-input", data });
  }

  /** The terminal pane's size. `focus`: this window is the one the human is using now, so its size wins. */
  resize(cols: number, rows: number, focus = false): void {
    sendLive({ type: "term-resize", cols, rows, ...(focus && { focus: true }) });
  }

  setAutoRestart(enabled: boolean): void {
    sendLive({ type: "term-auto-restart", enabled });
  }

  /* ── The surface the store and arrange helpers edit through ───────── */

  readonly surface: Surface = {
    newId: () => {
      const taken = (id: string) => !!(store.log?.scene.nodes[id] || store.log?.base.nodes[id]);
      let id: string;
      do id = `n${this.nextId++}`;
      while (taken(id));
      return id;
    },
    buildScene: () => cloneScene(store.log!.scene),
    apply: (scene, op) => applyOp(scene, op),
    rect: (id) => {
      const b = store.scene ? absBox(store.scene, id) : null;
      return b ? { left: b.x, top: b.y, width: b.w, height: b.h } : null;
    },
    box: (id) => (store.scene ? absBox(store.scene, id) : null),
    positioned: true,
    isContainer: (n) => isSceneContainer(n),
    place: (node: SceneNode, parent: string, after?: string) => {
      if (!node.tag) delete node.tag;
      if (store.scene) node.layout = placeWidget(store.scene, node, parent, after, this.state.target);
    },
    editText: (id) => {
      const n = store.scene?.nodes[id];
      if (n && n.parent !== null) this.set({ editing: id });
    },
    screenshot: async () => (this.capture ? this.capture.screenshot() : null),
    thumbnail: async (id, maxWidth) => (this.capture ? this.capture.thumbnail(id, maxWidth) : null),
  };
}

/** Edits that never reach the scene file: comments, behaviors, box prompts and locks. */
function notesOnly(entries: readonly LogEntry[]): LogEntry[] {
  const keep = new Set(["comment", "behavior", "region", "setLocked"]);
  return entries.map((e) => ({ ...e, ops: e.ops.filter((op) => keep.has(op.op)) })).filter((e) => e.ops.length > 0);
}

/** Two scenes are the same, apart from editor-only locks (key order and unset flags don't count). */
function sameScene(a: Scene, b: Scene): boolean {
  const ids = Object.keys(a.nodes);
  if (a.rootId !== b.rootId || a.target !== b.target || ids.length !== Object.keys(b.nodes).length) return false;
  return ids.every((id) => {
    const m = a.nodes[id]!;
    const n = b.nodes[id];
    return !!n && same({ ...m, locked: false, hidden: !!m.hidden }, { ...n, locked: false, hidden: !!n.hidden });
  });
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function readDock(): Partial<Dock> {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "{}") as Partial<Dock>;
    return {
      ...(typeof v.open === "boolean" && { open: v.open }),
      ...((v.side === "right" || v.side === "bottom") && { side: v.side }),
      ...(typeof v.size === "number" && v.size >= 140 && { size: v.size }),
    };
  } catch {
    return {};
  }
}

export const sceneMode = new SceneMode();

export function useSceneMode(): SceneState {
  return useSyncExternalStore(sceneMode.subscribe, sceneMode.getSnapshot);
}
