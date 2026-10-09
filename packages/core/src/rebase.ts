import { applyOp, deleteOp, type Op } from "./ops.js";
import { cloneScene, subtreeIds, type Scene } from "./scene.js";

/**
 * Re-target one undo step of edits at a newer version of the scene (the agent
 * rewrote the file while the human was editing), matching nodes by id. The
 * values each op changes from, tree indices and deleted subtrees are taken
 * from `scene` as it is now, so the edit applies cleanly and undoes to the new
 * version rather than the old one. The ops of a step are checked in order on a
 * scratch copy, since later ones can depend on earlier ones (a group adds a box,
 * then moves nodes into it).
 *
 * Returns null when the step no longer fits: a node it touches is gone, an id
 * it adds is taken, or a move would put a node inside itself.
 */
export function rebaseOps(scene: Scene, ops: readonly Op[]): Op[] | null {
  const scratch = cloneScene(scene);
  const out: Op[] = [];
  for (const op of ops) {
    const next = rebaseOp(scratch, op);
    if (!next) return null;
    try {
      applyOp(scratch, next);
    } catch {
      return null;
    }
    out.push(next);
  }
  return out;
}

function rebaseOp(scene: Scene, op: Op): Op | null {
  const node = "node" in op ? scene.nodes[op.node] : undefined;
  switch (op.op) {
    case "move":
      return node ? { ...op, from: { x: node.layout.x, y: node.layout.y } } : null;
    case "resize":
      return node ? { ...op, from: { ...node.layout } } : null;
    case "setText":
      return node ? { ...op, from: node.props.text ?? "" } : null;
    case "setStyle":
      return node ? { ...op, from: node.style[op.key] ?? null } : null;
    case "setProp":
      return node ? { ...op, from: node.props[op.key] ?? null } : null;
    case "swapType":
      return node ? { ...op, from: node.type } : null;
    case "setHidden":
      return node ? { ...op, from: !!node.hidden } : null;
    case "setLocked":
      return node ? { ...op, from: !!node.locked } : null;
    case "reorder": {
      const target = scene.nodes[op.to.parent];
      if (!node || node.parent === null || !target) return null;
      // Into its own subtree would detach it from the tree.
      if (subtreeIds(scene, node.id).includes(target.id)) return null;
      const from = { parent: node.parent, index: scene.nodes[node.parent]!.children.indexOf(node.id) };
      const siblings = target.children.filter((c) => c !== node.id).length;
      return { ...op, from, to: { parent: target.id, index: Math.min(op.to.index, siblings) } };
    }
    case "add": {
      const parent = scene.nodes[op.parent];
      if (!parent || op.nodes.some((n) => scene.nodes[n.id])) return null;
      return { ...op, index: Math.min(op.index, parent.children.length) };
    }
    case "delete": {
      // Capture the subtree as it is now, so undo brings back the agent's version of it.
      const top = scene.nodes[op.nodes[0]!.id];
      return top && top.parent !== null ? deleteOp(scene, top.id) : null;
    }
    case "comment":
    case "behavior":
      return node ? op : null;
    case "region":
      return scene.nodes[op.parent] ? op : null;
  }
}
