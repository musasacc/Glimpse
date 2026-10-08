import { useSyncExternalStore } from "react";
import { buildChangeList, deleteManyOps, duplicateManyOps, OpLog, type ChangeList, type NodeType, type Op, type Scene, type SceneNode } from "@glimpse/core";
import { DomBridge, tagFor } from "./dom";

export type Device = "desktop" | "tablet" | "mobile";

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
  tool: Tool;
  device: Device;
  activity: ActivityItem[];
  view: View;
  /** An agent is currently waiting for something from Glimpse (glimpse wait / MCP). */
  agentWaiting: boolean;
  /** The project's entry page exists yet (false until the agent builds it). */
  entryExists: boolean;
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
    tool: "select",
    device: "desktop",
    activity: [],
    view: "home",
    agentWaiting: false,
    entryExists: true,
    handoffs: [],
    openHandoff: null,
    sidebarOpen: true,
    inspectorOpen: true,
    reloadKey: 0,
    stale: false,
    rev: 0,
  };
  bridge: DomBridge | null = null;
  log: OpLog | null = null;
  private listeners = new Set<() => void>();
  private activitySeq = 0;
  /** Unsent edits taken off the page for a live morph (see beforeMorph), until they are replayed. */
  private parked: readonly { ops: Op[] }[] | null = null;
  /** While Edit source writes the files, replayed edits that are already in them can't apply; that's expected. */
  private writing = 0;
  private morphedWhileWriting = false;
  /** Edit source wrote the files and the page becomes the new base once their morph has come through. */
  private commitTimer: ReturnType<typeof setTimeout> | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  set(patch: Partial<State>): void {
    // A plain single selection (most callers) replaces the multi-selection.
    if ("selected" in patch && !("multi" in patch)) patch = { ...patch, multi: patch.selected ? [patch.selected] : [] };
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    for (const fn of this.listeners) fn();
  }

  get scene(): Scene | null {
    return this.log?.scene ?? null;
  }

  get pendingCount(): number {
    return this.log && this.commitTimer === undefined ? buildChangeList(this.log).changes.length : 0;
  }

  /**
   * (Re)attach to the preview document. If the human had unsent edits (the page
   * reloaded because the AI saved a file), replay them on top of the new page.
   */
  attach(doc: Document): void {
    const pending = this.unsent();
    this.bridge = new DomBridge(doc);
    this.rebase(pending);
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
    if (!this.log || this.parked || this.writing) return;
    this.parked = [...this.log.entries];
    try {
      while (this.log.undo());
    } catch {
      // The page's own scripts took something away; what's left on stays on, as before.
    }
  }

  /**
   * The AI changed the page in place (live morph). The DOM now matches the new
   * source, so rebuild the scene from it and replay unsent human edits on top.
   */
  pageChanged(): void {
    if (!this.bridge) return;
    if (this.writing) this.morphedWhileWriting = true;
    this.rebase(this.unsent());
    if (this.commitTimer !== undefined) this.finishWrite();
  }

  /** After a handoff, the current page (with the human's edits) becomes the new base. */
  commitHandoff(): void {
    if (!this.bridge) return;
    if (this.parked) this.rebase(this.unsent());
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
  async writingSource<T>(write: () => Promise<T>): Promise<T> {
    this.writing++;
    this.morphedWhileWriting = false;
    try {
      const result = await write();
      if (this.morphedWhileWriting) this.commitHandoff();
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

  /** The unsent edits, wherever they are right now. */
  private unsent(): readonly { ops: Op[] }[] {
    const entries = this.parked ?? this.log?.entries ?? [];
    this.parked = null;
    return entries;
  }

  private rebase(entries: readonly { ops: Op[] }[]): void {
    this.log = this.newLog();
    let dropped = 0;
    for (const entry of entries) {
      try {
        this.log.apply(...entry.ops);
      } catch {
        dropped++;
      }
    }
    const lost = dropped > 0 && this.writing === 0;
    if (lost) this.activity("warn", `${dropped} of your edits no longer match the page after the AI's change and were dropped`);
    this.set({ ...this.existingSelection(), hovered: null, stale: lost });
  }

  private newLog(): OpLog {
    const bridge = this.bridge!;
    return new OpLog(bridge.buildScene(), (scene, op, undo) => bridge.apply(scene, op, undo));
  }

  edit(...ops: Op[]): void {
    if (!this.log || ops.length === 0) return;
    this.log.apply(...ops);
    this.set({});
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

  /** Forget selected elements that are gone (e.g. undoing the step that created them). */
  private existingSelection(): Pick<State, "selected" | "multi"> {
    const nodes = this.scene?.nodes ?? {};
    const multi = this.state.multi.filter((id) => nodes[id]);
    const selected = this.state.selected && nodes[this.state.selected] ? this.state.selected : (multi[0] ?? null);
    return { selected, multi };
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
    if (!this.log || !this.bridge) return;
    const bridge = this.bridge;
    const ops = duplicateManyOps(this.log.scene, this.selection, () => bridge.newId());
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
    this.log = null;
    this.parked = null;
    this.set({ selected: null, hovered: null, tool: "select", stale: false, reloadKey: this.state.reloadKey + 1 });
  }

  /**
   * Add a new element from the palette: inside the selected element when it is a
   * container, otherwise right after it, or at the end of the page.
   */
  addElement(type: NodeType, tag: string = tagFor(type), defaults: Partial<SceneNode> = {}): void {
    const scene = this.scene;
    const bridge = this.bridge;
    if (!scene || !bridge) return;
    const sel = this.state.selected ? scene.nodes[this.state.selected] : undefined;
    let parent = scene.rootId;
    let index = scene.nodes[scene.rootId]!.children.length;
    if (sel && isContainer(sel)) {
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
      id: bridge.newId(),
      type,
      tag,
      parent,
      children: [],
      layout: { x: 0, y: 0, w: 0, h: 0 },
      style: {},
      props: {},
      ...defaults,
    };
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

  activity(kind: ActivityItem["kind"], text: string): void {
    const item = { id: ++this.activitySeq, at: Date.now(), kind, text };
    this.set({ activity: [item, ...this.state.activity].slice(0, 200) });
  }
}

const CONTAINER_TAGS = new Set(["div", "section", "main", "header", "footer", "nav", "article", "aside", "form", "ul", "ol"]);

function isContainer(n: SceneNode): boolean {
  return CONTAINER_TAGS.has(n.tag ?? "") || n.type === "root";
}

export const store = new Store();

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
