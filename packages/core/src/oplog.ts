import { applyOp, invertOp, type Op } from "./ops.js";
import { cloneScene, type Scene } from "./scene.js";

export interface LogEntry {
  /** Ops applied together (e.g. a multi-select drag) undo and redo as one step. */
  ops: Op[];
  at: number;
}

/**
 * Applies one op to a scene. The editor swaps this to also update the live DOM.
 * `undo` is set when the op is the inverse of one applied earlier (undo, or a
 * rollback), so the DOM can put things back exactly where they were.
 */
export type Applier = (scene: Scene, op: Op, undo: boolean) => void;

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

  /**
   * Apply ops as one undo step. All or nothing: if an op fails (e.g. an edit
   * replayed after the AI changed the page), the ones before it are rolled back.
   */
  apply(...ops: Op[]): void {
    if (ops.length === 0) return;
    this.run(ops, false);
    this.done.push({ ops, at: Date.now() });
    this.undone = [];
    this.emit();
  }

  /** Undo the last step. All or nothing too: if an inverse fails, the step stays done (and the error is thrown). */
  undo(): boolean {
    const entry = this.done.at(-1);
    if (!entry) return false;
    this.run(entry.ops, true);
    this.undone.push(this.done.pop()!);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.undone.at(-1);
    if (!entry) return false;
    this.run(entry.ops, false);
    this.done.push(this.undone.pop()!);
    this.emit();
    return true;
  }

  /** Apply `ops` (or, `backwards`, their inverses in reverse order), rolling back the ones before a failure. */
  private run(ops: Op[], backwards: boolean): void {
    const steps = backwards ? [...ops].reverse().map(invertOp) : ops;
    let i = 0;
    try {
      for (; i < steps.length; i++) this.applier(this.current, steps[i]!, backwards);
    } catch (err) {
      while (i-- > 0) this.applier(this.current, invertOp(steps[i]!), !backwards);
      throw err;
    }
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
