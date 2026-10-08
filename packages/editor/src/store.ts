import { useSyncExternalStore } from "react";
import { buildChangeList, deleteOp, duplicateOp, OpLog, type ChangeList, type NodeType, type Op, type Scene, type SceneNode } from "@glimpse/core";
import { DomBridge, tagFor } from "./dom";

export type Device = "desktop" | "tablet" | "mobile";

export const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, mobile: 390 };

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
  /** A screenshot of the edited page went with it (newer servers). */
  screenshot?: boolean | string;
}

export interface ProjectInfo {
  dir: string;
  target: string;
  entry: string;
}

interface State {
  project: ProjectInfo | null;
  connected: boolean;
  selected: string | null;
  hovered: string | null;
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
    hovered: null,
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

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    for (const fn of this.listeners) fn();
  }

  get scene(): Scene | null {
    return this.log?.scene ?? null;
  }

  get pendingCount(): number {
    return this.log ? buildChangeList(this.log).changes.length : 0;
  }

  /**
   * (Re)attach to the preview document. If the human had unsent edits (the page
   * reloaded because the AI saved a file), replay them on top of the new page.
   */
  attach(doc: Document): void {
    const pending = this.log?.entries ?? [];
    this.bridge = new DomBridge(doc);
    this.rebase(pending);
  }

  /**
   * The AI changed the page in place (live morph). The DOM now matches the new
   * source, so rebuild the scene from it and replay unsent human edits on top.
   */
  pageChanged(): void {
    if (!this.bridge) return;
    this.rebase(this.log?.entries ?? []);
  }

  /** After a handoff, the current page (with the human's edits) becomes the new base. */
  commitHandoff(): void {
    if (!this.bridge) return;
    this.log = this.newLog();
    this.set({ stale: false });
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
    if (dropped) this.activity("warn", `${dropped} of your edits no longer match the page after the AI's change and were dropped`);
    const selected = this.state.selected && this.log.scene.nodes[this.state.selected] ? this.state.selected : null;
    this.set({ selected, hovered: null, stale: dropped > 0 });
  }

  private newLog(): OpLog {
    const bridge = this.bridge!;
    return new OpLog(bridge.buildScene(), (scene, op) => bridge.apply(scene, op));
  }

  edit(...ops: Op[]): void {
    if (!this.log || ops.length === 0) return;
    this.log.apply(...ops);
    this.set({});
  }

  undo(): void {
    if (this.log?.undo()) this.set({});
  }

  redo(): void {
    if (this.log?.redo()) this.set({});
  }

  deleteSelected(): void {
    const id = this.state.selected;
    if (!id || !this.log || id === this.log.scene.rootId) return;
    this.edit(deleteOp(this.log.scene, id));
    this.set({ selected: null });
  }

  duplicateSelected(): void {
    const id = this.state.selected;
    if (!id || !this.log || !this.bridge || id === this.log.scene.rootId) return;
    const bridge = this.bridge;
    const op = duplicateOp(this.log.scene, id, () => bridge.newId());
    this.edit(op);
    if (op.op === "add") this.set({ selected: op.nodes[0]!.id });
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
    return this.log ? buildChangeList(this.log, note) : null;
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
