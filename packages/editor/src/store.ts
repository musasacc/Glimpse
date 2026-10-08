import { useSyncExternalStore } from "react";
import { buildChangeList, deleteOp, duplicateOp, OpLog, type ChangeList, type Op, type Scene } from "@glimpse/core";
import { DomBridge } from "./dom";

export type Device = "desktop" | "tablet" | "mobile";

export const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, mobile: 390 };

export interface ActivityItem {
  id: number;
  at: number;
  kind: "ai-file" | "ai-status" | "handoff" | "info" | "warn";
  text: string;
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

  changeList(note?: string): ChangeList | null {
    return this.log ? buildChangeList(this.log, note) : null;
  }

  activity(kind: ActivityItem["kind"], text: string): void {
    const item = { id: ++this.activitySeq, at: Date.now(), kind, text };
    this.set({ activity: [item, ...this.state.activity].slice(0, 200) });
  }
}

export const store = new Store();

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
