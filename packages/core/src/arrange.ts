import { applyOp, deleteOp, duplicateOp, type Op } from "./ops.js";
import { cloneScene, getNode, subtreeIds, type Layout, type Scene, type SceneNode } from "./scene.js";

/**
 * Editing several elements at once: align, distribute, group, ungroup, and
 * deleting or duplicating a multi-selection. Geometry works on absolute rects
 * (the editor measures them in the page); structure works on the scene and
 * returns the ops of one undo step.
 */

export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";

export interface Delta {
  dx: number;
  dy: number;
}

/** How far to move each rect so they all line up with an edge or the center of their common bounds. */
export function alignDeltas(rects: Layout[], how: Align): Delta[] {
  if (rects.length === 0) return [];
  const left = Math.min(...rects.map((r) => r.x));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return rects.map((r) => {
    switch (how) {
      case "left":
        return delta(left - r.x, 0);
      case "center":
        return delta((left + right) / 2 - (r.x + r.w / 2), 0);
      case "right":
        return delta(right - (r.x + r.w), 0);
      case "top":
        return delta(0, top - r.y);
      case "middle":
        return delta(0, (top + bottom) / 2 - (r.y + r.h / 2));
      case "bottom":
        return delta(0, bottom - (r.y + r.h));
    }
  });
}

/**
 * Even spacing along one axis: the first and the last rect (by position) stay
 * where they are and the gaps between neighbours become equal. Needs 3+ rects.
 */
export function distributeDeltas(rects: Layout[], axis: "x" | "y"): Delta[] {
  const out = rects.map(() => delta(0, 0));
  if (rects.length < 3) return out;
  const size = axis === "x" ? "w" : "h";
  const order = rects.map((_, i) => i).sort((a, b) => rects[a]![axis] - rects[b]![axis] || a - b);
  const first = rects[order[0]!]!;
  const last = rects[order[order.length - 1]!]!;
  const used = order.reduce((sum, i) => sum + rects[i]![size], 0);
  const gap = (last[axis] + last[size] - first[axis] - used) / (order.length - 1);
  let cursor = first[axis] + first[size] + gap;
  for (const i of order.slice(1, -1)) {
    const d = cursor - rects[i]![axis];
    out[i] = axis === "x" ? delta(d, 0) : delta(0, d);
    cursor += rects[i]![size] + gap;
  }
  return out;
}

function delta(dx: number, dy: number): Delta {
  // Round to whole units, and never hand out -0.
  return { dx: Math.round(dx) || 0, dy: Math.round(dy) || 0 };
}

/**
 * The listed nodes without the root, duplicates, unknown ids and nodes that sit
 * inside another listed node (moving or deleting the outer one covers them).
 */
export function topLevel(scene: Scene, ids: readonly string[]): string[] {
  const set = new Set(ids);
  set.delete(scene.rootId);
  return [...set].filter((id) => {
    const n = scene.nodes[id];
    if (!n || n.parent === null) return false;
    for (let p: string | null = n.parent; p !== null; p = scene.nodes[p]?.parent ?? null) if (set.has(p)) return false;
    return true;
  });
}

/** The ids that exist in the scene, in document (depth-first) order. */
export function documentOrder(scene: Scene, ids: readonly string[]): string[] {
  const rank = new Map(subtreeIds(scene, scene.rootId).map((id, i) => [id, i]));
  return [...new Set(ids)].filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
}

/** Delete several nodes in one step. Nodes inside another deleted node go with it. */
export function deleteManyOps(scene: Scene, ids: readonly string[]): Op[] {
  return sequence(scene, (s, push) => {
    for (const id of documentOrder(scene, topLevel(scene, ids))) push(deleteOp(s, id));
  });
}

/** Duplicate several nodes in one step; each copy lands right after its original. */
export function duplicateManyOps(scene: Scene, ids: readonly string[], newId: (oldId: string) => string): Op[] {
  return sequence(scene, (s, push) => {
    for (const id of documentOrder(scene, topLevel(scene, ids))) push(duplicateOp(s, id, newId));
  });
}

/**
 * Wrap sibling nodes in a new container. `group` supplies the container's id,
 * type, tag, style and layout. The step is an add op for the container at the
 * position of the first node, then one reorder per node (in document order)
 * moving it into the container. Returns [] unless the nodes share a parent.
 */
export function groupOps(scene: Scene, ids: readonly string[], group: SceneNode): Op[] {
  const nodes = [...new Set(ids)].map((id) => scene.nodes[id]);
  const parent = nodes[0]?.parent;
  if (!parent || nodes.some((n) => !n || n.parent !== parent) || scene.nodes[group.id]) return [];
  const siblings = getNode(scene, parent).children;
  const members = nodes.map((n) => n!.id).sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  return sequence(scene, (s, push) => {
    push({ op: "add", parent, index: siblings.indexOf(members[0]!), nodes: [{ ...structuredClone(group), parent, children: [] }] });
    members.forEach((id, k) =>
      push({ op: "reorder", node: id, from: { parent, index: getNode(s, parent).children.indexOf(id) }, to: { parent: group.id, index: k } }),
    );
  });
}

/**
 * Replace a container by its children: each child moves into the container's
 * parent at the container's position (keeping their order), then the empty
 * container is deleted. Returns [] for the root or a node without children.
 */
export function ungroupOps(scene: Scene, id: string): Op[] {
  const n = scene.nodes[id];
  if (!n || n.parent === null || n.children.length === 0) return [];
  const parent = n.parent;
  const at = getNode(scene, parent).children.indexOf(id);
  return sequence(scene, (s, push) => {
    n.children.forEach((c, k) => push({ op: "reorder", node: c, from: { parent: id, index: 0 }, to: { parent, index: at + k } }));
    push(deleteOp(s, id));
  });
}

/**
 * Build ops that depend on each other (each one's indices assume the earlier
 * ones were applied) against a scratch copy, so the real scene is untouched.
 */
function sequence(scene: Scene, build: (scratch: Scene, push: (op: Op) => void) => void): Op[] {
  const scratch = cloneScene(scene);
  const ops: Op[] = [];
  build(scratch, (op) => {
    applyOp(scratch, op);
    ops.push(op);
  });
  return ops;
}
