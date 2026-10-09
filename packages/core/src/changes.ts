import type { Op } from "./ops.js";
import { formatSource, getNode, type Scene, type SceneNode, type Target } from "./scene.js";
import type { OpLog } from "./oplog.js";

/** One entry of the change list handed to the AI (or to the source patcher). */
export type Change = Op & {
  /** "file:line:col" of the node in real source, when known. */
  src?: string;
  /** Short human-readable name of the element, e.g. `button "Buy now"`. */
  label?: string;
  /** Semantic hint so the AI can change layout idiomatically instead of hard-coding pixels. */
  intent?: string;
  /**
   * For `add` and `reorder`: source locations of the neighbours the element now
   * sits between, so it can be placed exactly in the code.
   */
  anchor?: { after?: string; before?: string };
};

export interface ChangeList {
  version: 1;
  target: Target;
  createdAt: string;
  /** Free-text note the human typed before sending. */
  note?: string;
  changes: Change[];
}

/**
 * Compact a session into the minimal list of changes. Structural and property
 * changes are computed by diffing the base scene against the final scene, so
 * edits that cancel out (or were undone) never reach the AI. Annotations
 * (comments, behaviors, regions) come from the op log.
 */
export function buildChangeList(log: OpLog, note?: string): ChangeList {
  return {
    version: 1,
    target: log.base.target,
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    changes: diffScenes(log.base, log.scene, log.ops),
  };
}

export function diffScenes(base: Scene, final: Scene, ops: Op[] = []): Change[] {
  const deletes: Change[] = [];
  const adds: Change[] = [];
  const reorders: Change[] = [];
  const edits: Change[] = [];
  const notes: Change[] = [];

  // Deleted: base nodes missing from final. Only report the top of each deleted subtree.
  for (const id of Object.keys(base.nodes)) {
    if (final.nodes[id]) continue;
    const n = base.nodes[id]!;
    if (n.parent !== null && !final.nodes[n.parent]) continue;
    const parent = getNode(base, n.parent!);
    // Children that were moved out before the delete (ungroup) are not deleted.
    const { nodes, kept } = splitSubtree(base, final, id);
    const change = withMeta(base, n, { op: "delete", parent: n.parent!, index: parent.children.indexOf(id), nodes });
    if (kept.length) {
      // Unwrap: only the tags go. Deleting the element's source range (what a
      // located delete means to the source patcher) would take the children
      // with it, so the location moves into the instruction for the AI.
      change.intent = `unwrap: remove only its tags${change.src ? ` at ${change.src}` : ""} and keep its children ${listNodes(final, kept)} in its place`;
      delete change.src;
    }
    deletes.push(change);
  }

  // Added: final nodes missing from base. Only report the top of each added subtree.
  for (const id of Object.keys(final.nodes)) {
    if (base.nodes[id]) continue;
    const n = final.nodes[id]!;
    if (n.parent !== null && !base.nodes[n.parent]) continue;
    const parent = getNode(final, n.parent!);
    // Existing elements moved into a new one (group) are reported as reorders, not as new.
    const { nodes, kept } = splitSubtree(final, base, id);
    const wraps = kept.length ? `; wraps ${listNodes(final, kept)}` : "";
    adds.push(
      withMeta(final, n, {
        op: "add",
        parent: n.parent!,
        index: parent.children.indexOf(id),
        nodes,
      }, positionIntent(final, n) + wraps, anchorOf(final, n)),
    );
  }

  // Reordered / reparented base nodes.
  for (const id of movedInTree(base, final)) {
    const b = base.nodes[id]!;
    const f = final.nodes[id]!;
    // Into a new parent (group) or out of a removed one (ungroup), the move is part
    // of a structural change the AI does as a whole; neighbours alone can't place it.
    const anchor = base.nodes[f.parent!] && final.nodes[b.parent!] ? anchorOf(final, f) : undefined;
    reorders.push(
      withMeta(final, f, {
        op: "reorder",
        node: id,
        from: { parent: b.parent!, index: getNode(base, b.parent!).children.indexOf(id) },
        to: { parent: f.parent!, index: getNode(final, f.parent!).children.indexOf(id) },
      }, positionIntent(final, f), anchor),
    );
  }

  // Property edits on nodes that exist in both.
  for (const id of Object.keys(base.nodes)) {
    const b = base.nodes[id]!;
    const f = final.nodes[id];
    if (!f) continue;
    const { x: bx, y: by, w: bw, h: bh } = b.layout;
    const { x: fx, y: fy, w: fw, h: fh } = f.layout;
    // A mock (terminal UI, native GUI) places nodes by their layout. One that changed parent (group,
    // ungroup) but kept its place on screen only has new coordinates relative to that parent.
    const moved = b.parent !== f.parent && PLACED.has(final.target) ? !samePlace(base, final, id) : bx !== fx || by !== fy;
    if (bw !== fw || bh !== fh) {
      edits.push(withMeta(final, f, { op: "resize", node: id, from: b.layout, to: f.layout }, resizeIntent(base, final, b, f)));
    } else if (moved) {
      edits.push(
        withMeta(final, f, { op: "move", node: id, from: { x: bx, y: by }, to: { x: fx, y: fy } }, moveIntent(base, final, b, f)),
      );
    }
    if ((b.props.text ?? "") !== (f.props.text ?? "")) {
      edits.push(withMeta(final, f, { op: "setText", node: id, from: b.props.text ?? "", to: f.props.text ?? "" }));
    }
    for (const key of unionKeys(b.style, f.style)) {
      const from = b.style[key] ?? null;
      const to = f.style[key] ?? null;
      if (from !== to) edits.push(withMeta(final, f, { op: "setStyle", node: id, key, from, to }));
    }
    for (const key of unionKeys(b.props, f.props)) {
      if (key === "text") continue;
      const from = b.props[key] ?? null;
      const to = f.props[key] ?? null;
      if (from !== to) edits.push(withMeta(final, f, { op: "setProp", node: id, key, from, to }));
    }
    if (b.type !== f.type) edits.push(withMeta(final, f, { op: "swapType", node: id, from: b.type, to: f.type }));
    if (!!b.hidden !== !!f.hidden) edits.push(withMeta(final, f, { op: "setHidden", node: id, from: !!b.hidden, to: !!f.hidden }));
    if (!!b.locked !== !!f.locked) edits.push(withMeta(final, f, { op: "setLocked", node: id, from: !!b.locked, to: !!f.locked }));
  }

  // Annotations, skipping ones attached to elements that no longer exist.
  for (const op of ops) {
    if (op.op === "comment" || op.op === "behavior") {
      const n = final.nodes[op.node];
      if (n) notes.push(withMeta(final, n, op));
    } else if (op.op === "region") {
      // Named after (and located at) the element the box was drawn in.
      const parent = final.nodes[op.parent];
      if (parent) notes.push(withMeta(final, parent, op));
    }
  }

  return [...deletes, ...adds, ...reorders, ...edits, ...notes];
}

/** Targets whose layout places nodes (rather than being measured from a page that lays itself out). */
const PLACED = new Set<Target>(["tui", "native"]);

/** The node is at the same place relative to the root in both scenes. */
function samePlace(base: Scene, final: Scene, id: string): boolean {
  const a = absPos(base, id);
  const b = absPos(final, id);
  return a.x === b.x && a.y === b.y;
}

/** Where a node is relative to the root: its layout plus every ancestor's offset. */
function absPos(scene: Scene, id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let n = scene.nodes[id]; n && n.parent !== null; n = scene.nodes[n.parent]) {
    x += n.layout.x;
    y += n.layout.y;
  }
  return { x, y };
}

export function describeNode(n: SceneNode): string {
  if (n.type === "root") return "the page";
  const name = n.tag && n.tag !== n.type ? `${n.type}<${n.tag}>` : n.type;
  const text = n.props.text?.trim();
  if (text) return `${name} "${text.length > 32 ? text.slice(0, 31) + "…" : text}"`;
  if (n.props.id) return `${name}#${n.props.id}`;
  // Class names (not Glimpse's own) say more than an editor id, e.g. box<div>.stage
  const classes = (n.props.class ?? "").split(/\s+/).filter((c) => c && !c.startsWith("__glimpse"));
  if (classes.length) return `${name}.${classes.slice(0, 2).join(".")}`;
  return `${name} ${n.id}`;
}

function withMeta<T extends Op>(scene: Scene, n: SceneNode, op: T, intent?: string, anchor?: Change["anchor"]): Change {
  // A new element has no source yet; point at its parent instead.
  const src = formatSource(n.source ?? (n.parent ? scene.nodes[n.parent]?.source : undefined));
  return {
    ...op,
    label: describeNode(n),
    ...(src ? { src } : {}),
    ...(intent ? { intent } : {}),
    ...(anchor && (anchor.after || anchor.before) ? { anchor } : {}),
  };
}

/** Nearest siblings (that exist in source) before and after `n` in the final tree. */
function anchorOf(scene: Scene, n: SceneNode): Change["anchor"] {
  if (n.parent === null) return undefined;
  const siblings = getNode(scene, n.parent).children;
  const i = siblings.indexOf(n.id);
  const withSource = (ids: string[]) => ids.map((id) => scene.nodes[id]?.source).find((s) => s !== undefined);
  const after = formatSource(withSource(siblings.slice(0, i).reverse()));
  const before = formatSource(withSource(siblings.slice(i + 1)));
  return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
}

/**
 * The part of `id`'s subtree in `scene` that is missing from `other` (the
 * nodes really added or deleted), plus the ids where the walk stopped because
 * the node exists in both: elements wrapped by a new group, or kept by an ungroup.
 */
function splitSubtree(scene: Scene, other: Scene, id: string): { nodes: SceneNode[]; kept: string[] } {
  const nodes: SceneNode[] = [];
  const kept: string[] = [];
  const walk = (nid: string) => {
    nodes.push(scene.nodes[nid]!);
    for (const c of scene.nodes[nid]!.children) {
      if (other.nodes[c]) kept.push(c);
      else walk(c);
    }
  };
  walk(id);
  return { nodes, kept };
}

function listNodes(scene: Scene, ids: string[]): string {
  const names = ids.map((id) => describeNode(getNode(scene, id)));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
}

function unionKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/**
 * Base nodes whose parent changed, or whose order among surviving siblings changed.
 * For a plain reorder we report only the nodes outside the longest increasing
 * subsequence, i.e. the minimum set of elements that actually moved.
 */
function movedInTree(base: Scene, final: Scene): string[] {
  const moved: string[] = [];
  for (const id of Object.keys(base.nodes)) {
    const b = base.nodes[id]!;
    const f = final.nodes[id];
    if (f && b.parent !== null && f.parent !== b.parent) moved.push(id);
  }
  for (const pid of Object.keys(base.nodes)) {
    if (!final.nodes[pid]) continue;
    const survivors = (ids: string[]) =>
      ids.filter((c) => base.nodes[c]?.parent === pid && final.nodes[c]?.parent === pid);
    const before = survivors(getNode(base, pid).children);
    const after = survivors(getNode(final, pid).children);
    const rank = new Map(before.map((c, i) => [c, i]));
    const keep = new Set(longestIncreasing(after.map((c) => rank.get(c)!)).map((i) => after[i]!));
    for (const c of after) if (!keep.has(c)) moved.push(c);
  }
  return moved;
}

/** Indices of one longest strictly increasing subsequence of `seq`. */
function longestIncreasing(seq: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.unshift(i);
  return out;
}

function siblingsOf(scene: Scene, n: SceneNode): SceneNode[] {
  if (n.parent === null) return [];
  return getNode(scene, n.parent).children.filter((c) => c !== n.id).map((c) => getNode(scene, c));
}

function positionIntent(scene: Scene, n: SceneNode): string {
  if (n.parent === null) return "";
  const parent = getNode(scene, n.parent);
  const i = parent.children.indexOf(n.id);
  const parts = [`child ${i + 1} of ${parent.children.length} in ${describeNode(parent)}`];
  const prev = i > 0 ? scene.nodes[parent.children[i - 1]!] : undefined;
  const next = scene.nodes[parent.children[i + 1]!];
  if (prev) parts.push(`after ${describeNode(prev)}`);
  if (next) parts.push(`before ${describeNode(next)}`);
  return parts.join(", ");
}

/** "3px right and 2px down", or "1 cell right" in a terminal UI (laid out in character cells). */
function shift(base: Scene, scene: Scene, b: SceneNode, f: SceneNode): string {
  // Layouts are relative to the parent: after a group or ungroup on a mock, compare places on screen instead.
  const across = b.parent !== f.parent && PLACED.has(scene.target);
  const from = across ? absPos(base, b.id) : b.layout;
  const to = across ? absPos(scene, f.id) : f.layout;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const unit = (n: number) => (scene.target === "tui" ? ` cell${Math.abs(n) === 1 ? "" : "s"}` : "px");
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)}${unit(dx)} ${dx > 0 ? "right" : "left"}`);
  if (dy) parts.push(`${Math.abs(dy)}${unit(dy)} ${dy > 0 ? "down" : "up"}`);
  return parts.join(" and ");
}

function moveIntent(base: Scene, scene: Scene, b: SceneNode, f: SceneNode): string {
  let hint = `moved ${shift(base, scene, b, f)}`;

  // Name the closest sibling to anchor the new position semantically.
  const cx = f.layout.x + f.layout.w / 2;
  const cy = f.layout.y + f.layout.h / 2;
  let best: { s: SceneNode; d: number } | undefined;
  for (const s of siblingsOf(scene, f)) {
    const d = Math.hypot(s.layout.x + s.layout.w / 2 - cx, s.layout.y + s.layout.h / 2 - cy);
    if (!best || d < best.d) best = { s, d };
  }
  if (best) {
    const s = best.s.layout;
    const where =
      f.layout.x >= s.x + s.w ? "right of"
      : f.layout.x + f.layout.w <= s.x ? "left of"
      : f.layout.y >= s.y + s.h ? "below"
      : f.layout.y + f.layout.h <= s.y ? "above"
      : "overlapping";
    hint += `; now ${where} ${describeNode(best.s)}`;
  }
  if (f.parent) {
    const p = getNode(scene, f.parent).layout;
    const left = f.layout.x;
    const right = p.w - (f.layout.x + f.layout.w);
    // Snap tolerance: a few pixels, or one character cell in a terminal.
    const tol = scene.target === "tui" ? 1 : 4;
    // Only describe alignment when the element still fits inside its parent.
    if (left >= -tol && right >= -tol && f.layout.w < p.w - 2 * tol) {
      if (Math.abs(left - right) <= tol) hint += "; horizontally centered in parent";
      else if (right <= tol) hint += "; aligned to the parent's right edge";
      else if (left <= tol) hint += "; aligned to the parent's left edge";
    } else if (left < -tol || right < -tol) {
      hint += "; now sticks out of its parent";
    }
  }
  return hint;
}

function resizeIntent(base: Scene, scene: Scene, b: SceneNode, f: SceneNode): string {
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const size = `size ${b.layout.w}×${b.layout.h} → ${f.layout.w}×${f.layout.h} (${fmt(f.layout.w - b.layout.w)}w, ${fmt(f.layout.h - b.layout.h)}h)`;
  // Resizing from the left or top edge also moves the element.
  const moved = shift(base, scene, b, f);
  return moved ? `${size}; also moved ${moved}` : size;
}
