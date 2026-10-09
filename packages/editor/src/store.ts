import { useSyncExternalStore } from "react";
import { buildChangeList, deleteManyOps, liveRegions, removeRegionOp, duplicateManyOps, OpLog, type Change, type ChangeList, type NodeType, type Op, type Scene, type SceneNode } from "@glimpse/core";
import { DomBridge, tagFor } from "./dom";
import { followMoves, followOps, isVitePage, repeatedSources, sameEdit, undoAll } from "./hmr";
import { shownPane } from "./scene-geometry";
import { domSurface, type Surface } from "./surface";
import { engineName, RunFeed, type AgentInfo, type AgentRun, type AgentRunMessage, type Engine } from "./agent";

export type Device = "desktop" | "tablet" | "mobile";

/** Steps of unsent edits (with the page they were made on) to put back after Edit source wrote the others. */
export interface KeptEdits {
  entries: { ops: Op[] }[];
  before: Scene | null;
}

export const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, mobile: 390 };

/** Canvas tool: select and move elements, or draw a box prompt ("AI, put X here"). */
export type Tool = "select" | "region";

export interface ActivityItem {
  id: number;
  at: number;
  kind: "ai-file" | "ai-status" | "handoff" | "info" | "warn";
  text: string;
}

export type View = "home" | "editor" | "history";

export interface HandoffSummary {
  seq: number;
  kind: "ai" | "source" | "request" | "variants";
  createdAt: string;
  title: string;
  count: number;
  delivered: boolean;
  /** Withdrawn before an agent got it (its variants were chosen or discarded). */
  cancelled?: boolean;
  /** A screenshot of the edited page went with it (newer servers). */
  screenshot?: boolean;
}

export interface ProjectInfo {
  dir: string;
  target: string;
  entry: string;
}

interface State {
  project: ProjectInfo | null;
  connected: boolean;
  /** The primary selected element (Inspector, talk, resize handle). */
  selected: string | null;
  /** Every selected element, the primary included. Setting only `selected` resets it to that one. */
  multi: string[];
  hovered: string | null;
  /** The selected box prompt (its region op's id); selecting elements clears it, and the other way round. */
  note: string | null;
  tool: Tool;
  device: Device;
  activity: ActivityItem[];
  view: View;
  /** An agent is currently waiting for something from Glimpse (glimpse wait / MCP). */
  agentWaiting: boolean;
  /** What runs the AI (newer servers run it themselves); null: unknown, or a server that can't (an external agent's). */
  agentInfo: AgentInfo | null;
  /** The AI Glimpse runs is building right now. */
  agentRun: AgentRun | null;
  /** The AI settings dialog is open. */
  aiSettingsOpen: boolean;
  /** The project's entry page exists yet (false until the agent builds it). */
  entryExists: boolean;
  /** Why the React preview can't run (e.g. "… run npm install"); null when it's fine. */
  previewError: string | null;
  handoffs: HandoffSummary[];
  /** Handoff shown in the History view. */
  openHandoff: number | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  /** Bumped to force the preview iframe to reload. */
  reloadKey: number;
  /** The page changed under unsent edits (e.g. the AI saved a file). */
  stale: boolean;
  /** Bumped on every change so React re-renders. */
  rev: number;
}

/**
 * Editor state: the op log of human edits on top of the live page, plus UI state.
 * Every edit goes through `edit()`, which updates the DOM and records the op.
 */
class Store {
  state: State = {
    project: null,
    connected: false,
    selected: null,
    multi: [],
    hovered: null,
    note: null,
    tool: "select",
    device: "desktop",
    activity: [],
    view: "home",
    agentWaiting: false,
    agentInfo: null,
    agentRun: null,
    aiSettingsOpen: false,
    entryExists: true,
    previewError: null,
    handoffs: [],
    openHandoff: null,
    sidebarOpen: true,
    inspectorOpen: true,
    reloadKey: 0,
    stale: false,
    rev: 0,
  };
  bridge: DomBridge | null = null;
  /** Set while a terminal UI or native GUI mock is edited instead of a live page (see scene-mode.ts). */
  sceneSurface: Surface | null = null;
  log: OpLog | null = null;
  /**
   * Unsent edits taken off the page while it changes under them, until they are replayed: around an HTML page's
   * live morph (see beforeMorph) and a React page's HMR update (see beforeUpdate, which also keeps the page before it).
   */
  private held: readonly { ops: Op[] }[] | null = null;
  private heldBase: Scene | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  /** React pages: edits already handed off. They stay on screen until React next updates the page. */
  private sent: OpLog[] = [];
  /**
   * React pages in Interact mode: the unsent edits, recorded on the scene only, while the app runs on the DOM
   * React made (see interact). Counting and sending them works as usual; they come back on leaving the mode.
   */
  private frozen: OpLog | null = null;
  private listeners = new Set<() => void>();
  private hoverListeners = new Set<() => void>();
  /** The pending change count for a revision of the op log (diffing the scenes is too slow to repeat per render). */
  private pendingCache: { log: OpLog; revision: number; count: number } | null = null;
  private activitySeq = 0;
  /** While Edit source writes the files, replayed edits that are already in them can't apply; that's expected. */
  private writing = 0;
  private morphedWhileWriting = false;
  /** Edit source wrote the files and the page becomes the new base once their morph has come through. */
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The step a control that fires while dragged (a color picker) made last, which its next value replaces. */
  private merging: { key: string; entry: unknown } | null = null;
  /**
   * Edits Edit source left out of the files and didn't send: once the page shows the written files, only these
   * are replayed on it, and they stay unsent (see writingSource). `applied` once that happened.
   */
  private keepAfterWrite: (KeptEdits & { applied: boolean }) | null = null;
  /** What the running AI prints, as activity rows (coalesced, see RunFeed). */
  private runFeed = new RunFeed((...texts) => this.activity("info", ...texts));
  /** Runs once the AI settings are saved with something that can run it (Home's request that waited for it). */
  private afterSettings: (() => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  /** Hears hover changes only (see useHovered). */
  subscribeHover = (fn: () => void) => {
    this.hoverListeners.add(fn);
    return () => this.hoverListeners.delete(fn);
  };

  set(patch: Partial<State>): void {
    // A plain single selection (most callers) replaces the multi-selection.
    if ("selected" in patch && !("multi" in patch)) patch = { ...patch, multi: patch.selected ? [patch.selected] : [] };
    // Selecting (or clearing) elements leaves the selected box prompt too.
    if (("selected" in patch || "multi" in patch) && !("note" in patch)) patch = { ...patch, note: null };
    const hoverChanged = "hovered" in patch && patch.hovered !== this.state.hovered;
    // The pointer moving onto another element only re-renders what draws the hover box, not the whole editor.
    if (Object.keys(patch).length === 1 && "hovered" in patch) {
      if (!hoverChanged) return;
      this.state = { ...this.state, hovered: patch.hovered ?? null };
      for (const fn of this.hoverListeners) fn();
      return;
    }
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    for (const fn of this.listeners) fn();
    if (hoverChanged) for (const fn of this.hoverListeners) fn();
  }

  get scene(): Scene | null {
    return this.log?.scene ?? null;
  }

  /** What edits land on: the scene mock, or the live page. */
  get surface(): Surface | null {
    return this.sceneSurface ?? (this.bridge ? domSurface(this.bridge) : null);
  }

  get pendingCount(): number {
    const log = this.log;
    if (!log || this.commitTimer !== undefined) return 0;
    const c = this.pendingCache;
    if (c?.log === log && c.revision === log.revision) return c.count;
    const count = buildChangeList(log).changes.length;
    this.pendingCache = { log, revision: log.revision, count };
    return count;
  }

  /**
   * (Re)attach to the preview document. If the human had unsent edits (the page
   * reloaded because the AI saved a file), replay them on top of the new page.
   */
  attach(doc: Document): void {
    // React renders a reloaded page anew, reusing nothing; follow the elements as after an update.
    if (this.frozen && this.log === this.frozen) {
      // Interacting: the edits stay off the new page until editing resumes.
      this.sent = [];
      this.bridge = new DomBridge(doc);
      this.set({});
      return;
    }
    // Likewise a reloaded HTML page: its new ids follow document order, so an element the AI added or removed
    // above the edited ones would otherwise shift every replayed edit onto its neighbour.
    const before = this.heldBase ?? this.log?.base ?? null;
    const pending = this.unsent();
    this.sent = [];
    this.bridge = new DomBridge(doc);
    const kept = this.keptAfterWrite();
    this.rebase(kept?.entries ?? pending, kept ? kept.before : before);
    if (this.commitTimer !== undefined) this.finishWrite();
  }

  /**
   * The AI saved the page and the live client is about to morph it into the new
   * source. The morph pairs elements by position, so the human's edits come off
   * the page first: otherwise a group's new box is morphed into a sibling, the
   * elements after it shift, and replayed edits land on the wrong ones.
   */
  beforeMorph(): void {
    // Edit source's own write: the page already shows what was written (deletes, moves in the
    // tree…), so it is morphed as it is and only the rest is replayed.
    if (!this.log || this.held || this.writing || this.frozen) return;
    this.held = [...this.log.entries];
    // A step the page's own scripts made impossible is dropped; the rest come off.
    undoAll(this.log);
  }

  /**
   * The AI changed the page in place (live morph). The DOM now matches the new
   * source, so rebuild the scene from it and replay unsent human edits on top.
   */
  pageChanged(): void {
    if (!this.bridge) return;
    if (this.writing) this.morphedWhileWriting = true;
    // A React page only changes under us after beforeUpdate took the edits off; otherwise they are still on it.
    const held = this.held;
    if (!held && isVitePage(this.bridge.doc)) {
      if (this.commitTimer !== undefined) this.finishWrite();
      return;
    }
    // An HTML page's morph pairs elements by position too: follow them from the page the edits were made on.
    const before = this.heldBase ?? this.log?.base ?? null;
    const pending = this.unsent();
    // Edits made while React was updating went onto the page it was changing: take them off too, then replay all.
    if (held && this.log) undoAll(this.log);
    const kept = this.keptAfterWrite();
    this.rebase(kept?.entries ?? pending, kept ? kept.before : before);
    if (this.commitTimer !== undefined) this.finishWrite();
  }

  /**
   * React pages: Vite is about to apply an HMR update. React diffs against its
   * own record of the DOM, so our edits must be off the page first (otherwise it
   * removes the wrong elements); pageChanged replays them once it has settled.
   * Edits already handed off come off for good: the source has (or will have) them.
   */
  beforeUpdate(): void {
    if (!this.bridge || this.held) return;
    if (this.frozen) {
      // Interacting: the unsent edits are already off the page.
      for (const log of this.sent.reverse()) undoAll(log);
      this.sent = [];
      return;
    }
    this.held = [...(this.log?.entries ?? [])];
    this.heldBase = this.log?.base ?? null;
    if (this.log) undoAll(this.log);
    for (const log of this.sent.reverse()) undoAll(log);
    this.sent = [];
    // Normally "after-update" follows within ~2 s; never keep the edits off the page for good.
    clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => this.pageChanged(), 6000);
  }

  /** Unsent edits: those held during a React update, then any made since. Ends the hold. */
  private unsent(): readonly { ops: Op[] }[] {
    const entries = [...(this.held ?? []), ...(this.log?.entries ?? [])];
    this.held = this.heldBase = null;
    clearTimeout(this.heldTimer);
    return entries;
  }

  /**
   * The unsent steps behind some of the pending changes (matched by element and kind), for
   * writingSource to keep unsent when the files get the rest. Call before any edits come off.
   * (A step that also made a written change keeps only its other ops.)
   */
  editsFor(changes: readonly Change[]): KeptEdits {
    const entries = [...(this.held ?? []), ...(this.log?.entries ?? [])]
      .map((e) => ({ ops: e.ops.filter((op) => changes.some((c) => sameEdit(c, op))) }))
      .filter((e) => e.ops.length > 0);
    return { entries, before: this.heldBase ?? this.log?.base ?? null };
  }

  /** While Edit source writes, the edits to replay on the page once it shows the written files (see writingSource). */
  private keptAfterWrite(): KeptEdits | null {
    const keep = this.writing ? this.keepAfterWrite : null;
    if (keep) keep.applied = true;
    return keep;
  }

  /** After a handoff, the current page (with the human's edits) becomes the new base. */
  commitHandoff(): void {
    if (!this.surface) return;
    const keep = this.keepAfterWrite;
    this.keepAfterWrite = null;
    if (keep) {
      // The page shows the written files with the edits that weren't sent on top: they stay unsent.
      if (keep.applied) return this.set({ stale: false });
      // The written files haven't reached the page yet: keep every edit unsent rather than lose some. Those the
      // files have now change nothing once they arrive. (React has them all off the page: they go back on.)
      if (this.isVitePage) this.putBackEdits();
      return;
    }
    // Edits taken off the page for a morph go back on before the page becomes the new base.
    if (this.held && !this.isVitePage) this.rebase(this.unsent());
    // React still renders the page without them: they come off before its next update (see beforeUpdate).
    if (this.log?.canUndo && this.isVitePage && this.log !== this.frozen) this.sent.push(this.log);
    this.log = this.newLog();
    this.set({ stale: false });
  }

  /**
   * Run Edit source's write, then make the page the new base (the files have
   * the edits now; they must never be written twice). Rebases meanwhile replay
   * edits the new source already has, so those not applying isn't a loss. The
   * write morphs the page; when that hasn't come through yet, the commit waits
   * for it (briefly), so the edits that went to the AI instead are replayed
   * through the morph rather than wiped by it.
   */
  async writingSource<T>(write: () => Promise<T>, keep?: KeptEdits): Promise<T> {
    this.writing++;
    this.morphedWhileWriting = false;
    // A scene mock is the new base as it is: the scene file has every edit (the code still has to follow).
    this.keepAfterWrite = keep && keep.entries.length > 0 && !this.sceneSurface ? { ...keep, applied: false } : null;
    try {
      const result = await write().catch((e: unknown) => {
        this.keepAfterWrite = null;
        throw e;
      });
      // A scene mock shows the edits itself: no page morphs, so it is the new base right away.
      if (this.morphedWhileWriting || this.sceneSurface) this.commitHandoff();
      else {
        this.writing++;
        this.commitTimer = setTimeout(() => this.finishWrite(), 1500);
        this.set({});
      }
      return result;
    } finally {
      this.writing--;
    }
  }

  private finishWrite(): void {
    if (this.commitTimer === undefined) return;
    clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    this.writing--;
    this.commitHandoff();
  }

  /**
   * React pages, Interact mode: the app runs, and its own state updates (a click, a timer, a fetch) reconcile
   * against the DOM just like an HMR update, so the edits come off the page (React would otherwise trip over
   * elements the editor removed or moved) and are replayed on whatever the app shows when editing resumes.
   */
  interact(on: boolean): void {
    if (on) {
      const log = this.log;
      if (this.frozen || !log || !this.isVitePage || this.held) return;
      const frozen = new OpLog(log.base);
      for (const entry of log.entries) frozen.apply(...entry.ops);
      undoAll(log);
      for (const sent of this.sent.reverse()) undoAll(sent);
      this.sent = [];
      this.log = this.frozen = frozen;
      this.set({ hovered: null });
      return;
    }
    const frozen = this.frozen;
    if (!frozen) return;
    this.frozen = null;
    // Sent or discarded meanwhile: nothing to put back.
    if (this.log === frozen && this.bridge) this.rebase(frozen.entries, frozen.base);
  }

  /**
   * React pages, Edit source: take the edits off the page before Glimpse writes
   * them into the files, so the update Vite sends (maybe before the write's
   * response) finds the DOM as React left it. They stay on the redo stack.
   */
  takeOffEdits(): void {
    if (this.log) undoAll(this.log);
    this.set({});
  }

  /** The write failed: put the edits taken off by takeOffEdits back. */
  putBackEdits(): void {
    try {
      while (this.log?.redo()) {}
    } catch {
      // Redo is all or nothing: a step the page no longer takes stays on the redo stack.
      this.activity("warn", "Some of your edits couldn't be put back on the page; use Redo to try again.");
    }
    this.set(this.existingSelection());
  }

  /** The page shows a React app (served by Vite), not a static HTML page. */
  get isVitePage(): boolean {
    return !this.sceneSurface && isVitePage(this.bridge?.doc);
  }

  /** Source locations the page renders more than once, with how often (see repeatedSources). */
  get repeats(): Map<string, number> {
    if (this.sceneSurface) return new Map();
    return repeatedSources([...this.sent, ...(this.log ? [this.log] : [])].map((l) => l.base));
  }

  /** `before`: the page React rendered before an update or reload, so edits follow the elements it moved (see followMoves). */
  private rebase(entries: readonly { ops: Op[] }[], before: Scene | null = null): void {
    this.log = this.newLog();
    const moved = before ? followMoves(before, this.log.base) : new Map<string, string>();
    let dropped = 0;
    for (const entry of entries) {
      try {
        this.log.apply(...followOps(entry.ops, moved, this.log.scene));
      } catch {
        dropped++;
      }
    }
    const lost = dropped > 0 && this.writing === 0;
    if (lost) this.activity("warn", `${dropped} of your edits no longer match the page after the AI's change and were dropped`);
    this.set({ ...this.existingSelection(moved), hovered: null, stale: lost });
  }

  private newLog(): OpLog {
    const surface = this.surface!;
    return new OpLog(surface.buildScene(), (scene, op, undo) => surface.apply(scene, op, undo));
  }

  edit(...ops: Op[]): void {
    if (!this.log || ops.length === 0) return;
    this.log.apply(...ops);
    this.set({});
  }

  /**
   * A style edit from a control that fires continuously while dragged (a color picker): values with the same `key`
   * in a row replace each other's step, so the whole drag is one undo step. `endMerge` ends the run (picker closed).
   */
  editMerged(key: string, op: Extract<Op, { op: "setStyle" }>): void {
    const log = this.log;
    if (!log) return;
    const last = log.entries.at(-1);
    const prev = last?.ops.length === 1 ? last.ops[0] : undefined;
    if (this.merging?.key === key && last === this.merging.entry && prev?.op === "setStyle") {
      try {
        log.undo();
      } catch {
        this.merging = null;
        return this.edit(op);
      }
      op = { ...op, from: prev.from };
      if (op.from === op.to) {
        // Dragged back to where it started: no step at all.
        this.merging = null;
        return this.set({});
      }
    }
    log.apply(op);
    this.merging = { key, entry: log.entries.at(-1) };
    this.set({});
  }

  endMerge(): void {
    this.merging = null;
  }

  undo(): void {
    this.step(() => this.log?.undo() ?? false, "undo");
  }

  redo(): void {
    this.step(() => this.log?.redo() ?? false, "redo");
  }

  /** Undo or redo one step; it is all or nothing, so a failure leaves the step where it was. */
  private step(run: () => boolean, what: string): void {
    try {
      if (run()) this.set(this.existingSelection());
    } catch {
      this.activity("warn", `Couldn't ${what} that step: the page changed under it (its own scripts may have removed an element).`);
    }
  }

  /** The selected elements that are on the page (never the root), primary included. */
  get selection(): string[] {
    const scene = this.scene;
    if (!scene) return [];
    return this.state.multi.filter((id) => id !== scene.rootId && scene.nodes[id]);
  }

  /** Select one element, or nothing. */
  select(id: string | null): void {
    this.set({ selected: id });
  }

  /** Shift+click: add an element to the selection (it becomes the primary) or take it out. */
  toggleSelect(id: string): void {
    const has = this.state.multi.includes(id);
    const multi = has ? this.state.multi.filter((x) => x !== id) : [...this.state.multi, id];
    const selected = !has ? id : this.state.selected !== id ? this.state.selected : (multi.at(-1) ?? null);
    this.set({ selected, multi });
  }

  /** Select several elements; the first one is the primary. */
  selectMany(ids: string[]): void {
    const multi = [...new Set(ids)];
    this.set({ selected: multi[0] ?? null, multi });
  }

  /** Forget selected elements that are gone (e.g. undoing the step that created them); follow those that `moved`. */
  private existingSelection(moved?: Map<string, string>): Pick<State, "selected" | "multi" | "note"> {
    const nodes = this.scene?.nodes ?? {};
    const follow = (id: string) => moved?.get(id) ?? id;
    const multi = this.state.multi.map(follow).filter((id) => nodes[id]);
    const current = this.state.selected && follow(this.state.selected);
    const selected = current && nodes[current] ? current : (multi[0] ?? null);
    const note = this.state.note && this.regions.some((r) => r.id === this.state.note) ? this.state.note : null;
    return { selected, multi, note };
  }

  /** The box prompts on the page now, numbered in this order. */
  get regions() {
    return liveRegions(this.log?.ops ?? []);
  }

  /** Select a box prompt (and no elements), or none. */
  selectNote(id: string | null): void {
    this.set({ note: id, selected: null, multi: [] });
  }

  /** Take a box prompt away as one undo step; its instruction no longer goes to the AI. */
  removeNote(id: string): void {
    const region = this.regions.find((r) => r.id === id);
    if (!region) return;
    this.edit(removeRegionOp(region));
    if (this.state.note === id) this.set({ note: null });
  }

  setTool(tool: Tool): void {
    if (tool !== this.state.tool) this.set({ tool });
  }

  /** Delete every selected element as one undo step. */
  deleteSelected(): void {
    if (!this.log) return;
    const ops = deleteManyOps(this.log.scene, this.selection);
    if (ops.length === 0) return;
    this.edit(...ops);
    this.set({ selected: null });
  }

  /** Duplicate every selected element (each copy right after its original) and select the copies. */
  duplicateSelected(): void {
    const surface = this.surface;
    if (!this.log || !surface) return;
    const ops = duplicateManyOps(this.log.scene, this.selection, () => surface.newId());
    if (ops.length === 0) return;
    this.edit(...ops);
    this.selectMany(ops.flatMap((op) => (op.op === "add" ? [op.nodes[0]!.id] : [])));
  }

  /**
   * Drop every unsent edit (and the redo stack): forget the op log and reload
   * the page from source. `attach` then starts a fresh log with nothing to replay.
   */
  discard(): void {
    if (this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
      this.writing--;
    }
    this.log = this.frozen = null;
    this.held = this.heldBase = null;
    clearTimeout(this.heldTimer);
    this.set({ selected: null, note: null, hovered: null, tool: "select", stale: false, reloadKey: this.state.reloadKey + 1 });
  }

  /**
   * Add a new element from the palette: inside the selected element when it is a
   * container, otherwise right after it, or at the end of the page.
   */
  addElement(type: NodeType, tag: string = tagFor(type), defaults: Partial<SceneNode> = {}): void {
    const scene = this.scene;
    const surface = this.surface;
    if (!scene || !surface) return;
    let sel = this.state.selected ? scene.nodes[this.state.selected] : undefined;
    let into = !!sel && surface.isContainer(sel);
    // A tabs node (mocks) draws one pane, its children: a new widget goes into the shown pane, or next to
    // the tabs, never in as another pane nobody would see.
    if (sel?.type === "tabs") {
      const pane = scene.nodes[shownPane(sel) ?? ""];
      into = !!pane && surface.isContainer(pane);
      if (pane && into) sel = pane;
    } else if (!into && sel?.parent && scene.nodes[sel.parent]?.type === "tabs") {
      sel = scene.nodes[sel.parent];
    }
    let parent = scene.rootId;
    let index = scene.nodes[scene.rootId]!.children.length;
    if (sel && into) {
      parent = sel.id;
      index = sel.children.length;
    } else if (sel?.parent) {
      parent = sel.parent;
      index = scene.nodes[sel.parent]!.children.indexOf(sel.id) + 1;
    }
    // Match the look of the selected element (or a sibling) of the same kind,
    // so a new button next to the page's buttons looks like one of them.
    const twin =
      sel?.tag === tag ? sel
      : scene.nodes[parent]!.children.map((c) => scene.nodes[c]!).find((c) => c.tag === tag);
    if (twin?.props.class) defaults = { ...defaults, props: { ...defaults.props, class: twin.props.class } };
    const node: SceneNode = {
      id: surface.newId(),
      type,
      tag,
      parent,
      children: [],
      layout: { x: 0, y: 0, w: 0, h: 0 },
      style: {},
      props: {},
      ...defaults,
    };
    surface.place?.(node, parent, sel && sel.id !== parent ? sel.id : undefined);
    this.edit({ op: "add", parent, index, nodes: [node] });
    this.set({ selected: node.id });
  }

  async refreshHandoffs(): Promise<void> {
    try {
      const res = await fetch("/api/handoffs");
      const body = (await res.json()) as { handoffs: HandoffSummary[] };
      this.set({ handoffs: body.handoffs });
    } catch {
      // server not reachable yet; the live connection retries
    }
  }

  changeList(note?: string): ChangeList | null {
    return this.log && this.commitTimer === undefined ? buildChangeList(this.log, note) : null;
  }

  /** The server's agent info changed (or there is none: an older server). */
  setAgentInfo(info: AgentInfo | null): void {
    const patch: Partial<State> = { agentInfo: info };
    // The info knows what runs: a run that ended while we were away isn't shown as running any more.
    if (info && !info.running && this.state.agentRun) patch.agentRun = null;
    this.set(patch);
  }

  /** The run the server is in as we (re)connect (hello): show it, with its latest lines, unless we already do. */
  catchUpRun(run: (AgentRun & { output?: string[] }) | null): void {
    if (!run) {
      if (this.state.agentRun) {
        this.runFeed.flush();
        this.set({ agentRun: null });
      }
      return;
    }
    if (this.state.agentRun?.seq === run.seq) return;
    this.runFeed.reset();
    this.activity("ai-status", `${engineName(run.engine)} is building…`);
    for (const line of run.output ?? []) this.runFeed.push(line);
    this.runFeed.flush();
    this.set({ agentRun: { seq: run.seq, engine: run.engine, startedAt: run.startedAt } });
  }

  /** A run of the AI Glimpse runs started, printed something, finished or failed (or was stopped). */
  agentRunEvent(msg: AgentRunMessage): void {
    const current = this.state.agentRun;
    switch (msg.event) {
      case "start":
        this.runFeed.reset();
        this.activity("ai-status", `${engineName(msg.engine)} is building…`);
        this.set({ agentRun: { seq: msg.seq, engine: msg.engine, startedAt: msg.at ?? new Date().toISOString() } });
        break;
      case "output":
        if (msg.text) this.runFeed.push(msg.text);
        // Output of a run whose start we missed (reconnected mid-run): it is running.
        if (!current) this.set({ agentRun: { seq: msg.seq, engine: msg.engine, startedAt: msg.at ?? new Date().toISOString() } });
        break;
      case "done":
      case "error": {
        this.runFeed.flush();
        const text = msg.text?.trim();
        if (msg.event === "done") this.activity("handoff", "Done");
        else if (text === "Stopped") this.activity("info", "Stopped");
        else this.activity("warn", text || `${engineName(msg.engine)} stopped with an error`);
        // An older run's end doesn't end a newer one.
        if (!current || current.seq <= msg.seq) this.set({ agentRun: null });
        break;
      }
    }
  }

  /** Open the AI settings; `then` runs once they're saved with an AI that can run (e.g. send the waiting request). */
  openAiSettings(then?: () => void): void {
    this.afterSettings = then ?? null;
    this.set({ aiSettingsOpen: true });
  }

  /** Close the AI settings; `saved`: what the server says now, after saving. */
  closeAiSettings(saved?: AgentInfo): void {
    const then = this.afterSettings;
    this.afterSettings = null;
    if (saved) this.setAgentInfo(saved);
    this.set({ aiSettingsOpen: false });
    if (saved && saved.engine !== "none") then?.();
  }

  /** Add rows to the activity feed (several at once re-render once), newest last. */
  activity(kind: ActivityItem["kind"], ...texts: string[]): void {
    if (texts.length === 0) return;
    const at = Date.now();
    const items = texts.map((text) => ({ id: ++this.activitySeq, at, kind, text })).reverse();
    this.set({ activity: [...items, ...this.state.activity].slice(0, 200) });
  }
}

export const store = new Store();

/** What runs the AI now; an older server (no agent info) means an external agent, as before. */
export function currentEngine(state: Pick<State, "agentInfo">): Engine {
  return state.agentInfo?.engine ?? "external";
}

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** The hovered element; re-renders on hover changes, which useStore() alone doesn't (see Store.set). */
export function useHovered(): string | null {
  return useSyncExternalStore(store.subscribeHover, () => store.state.hovered);
}
