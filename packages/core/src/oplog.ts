import { applyOp, invertOp, type Op } from "./ops.js";
import { cloneScene, type Scene } from "./scene.js";

export interface LogEntry {
  /** Ops applied together (e.g. a multi-select drag) undo and redo as one step. */
  ops: Op[];
  at: number;
}

/** Applies one op to a scene. The editor swaps this to also update the live DOM. */
export type Applier = (scene: Scene, op: Op) => void;

/**
 * Append-only history of human edits on top of a base scene, with undo/redo.
 * `done` is what the change list is built from; `undone` is the redo stack.
 */
export class OpLog {
  readonly base: Scene;
  private current: Scene;
  private done: LogEntry[] = [];
  private undone: LogEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(
    base: Scene,
    private readonly applier: Applier = applyOp,
  ) {
    this.base = cloneScene(base);
    this.current = cloneScene(base);
  }

  get scene(): Scene {
    return this.current;
  }

  get entries(): readonly LogEntry[] {
    return this.done;
  }

  get ops(): Op[] {
    return this.done.flatMap((e) => e.ops);
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  apply(...ops: Op[]): void {
    if (ops.length === 0) return;
    for (const op of ops) this.applier(this.current, op);
    this.done.push({ ops, at: Date.now() });
    this.undone = [];
    this.emit();
  }

  undo(): boolean {
    const entry = this.done.pop();
    if (!entry) return false;
    for (const op of [...entry.ops].reverse()) this.applier(this.current, invertOp(op));
    this.undone.push(entry);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.undone.pop();
    if (!entry) return false;
    for (const op of entry.ops) this.applier(this.current, op);
    this.done.push(entry);
    this.emit();
    return true;
  }

  /** Drop all edits and return to the base scene. */
  discard(): void {
    this.current = cloneScene(this.base);
    this.done = [];
    this.undone = [];
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
