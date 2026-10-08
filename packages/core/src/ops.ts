import { getNode, subtreeIds, type Layout, type NodeType, type Scene, type SceneNode } from "./scene.js";

/**
 * Every human edit is one of these typed operations. Each op carries enough
 * information (`from` values, removed subtrees) to be inverted for undo.
 */
export type Op =
  | { op: "move"; node: string; from: Pick<Layout, "x" | "y">; to: Pick<Layout, "x" | "y"> }
  | { op: "resize"; node: string; from: Layout; to: Layout }
  | { op: "setText"; node: string; from: string; to: string }
  | { op: "setStyle"; node: string; key: string; from: string | null; to: string | null }
  | { op: "setProp"; node: string; key: string; from: string | null; to: string | null }
  | { op: "swapType"; node: string; from: NodeType; to: NodeType }
  | { op: "setHidden"; node: string; from: boolean; to: boolean }
  | { op: "setLocked"; node: string; from: boolean; to: boolean }
  | { op: "reorder"; node: string; from: { parent: string; index: number }; to: { parent: string; index: number } }
  | { op: "add"; parent: string; index: number; nodes: SceneNode[] }
  | { op: "delete"; parent: string; index: number; nodes: SceneNode[] }
  /** Point & talk: a free-text instruction pinned to an element. */
  | { op: "comment"; node: string; id: string; text: string }
  /** Edit behavior: a logic instruction, always handed to the AI. */
  | { op: "behavior"; node: string; id: string; event: string; action: string; detail?: string }
  /** Draw a box + prompt: "AI, put X here". */
  | { op: "region"; id: string; parent: string; rect: Layout; text: string };

export type OpKind = Op["op"];

export function applyOp(scene: Scene, op: Op): void {
  switch (op.op) {
    case "move": {
      const n = getNode(scene, op.node);
      n.layout = { ...n.layout, ...op.to };
      return;
    }
    case "resize":
      getNode(scene, op.node).layout = { ...op.to };
      return;
    case "setText":
      getNode(scene, op.node).props.text = op.to;
      return;
    case "setStyle":
      setOrDelete(getNode(scene, op.node).style, op.key, op.to);
      return;
    case "setProp":
      setOrDelete(getNode(scene, op.node).props, op.key, op.to);
      return;
    case "swapType":
      getNode(scene, op.node).type = op.to;
      return;
    case "setHidden":
      getNode(scene, op.node).hidden = op.to;
      return;
    case "setLocked":
      getNode(scene, op.node).locked = op.to;
      return;
    case "reorder": {
      const n = getNode(scene, op.node);
      getNode(scene, op.to.parent); // fail before detaching, so a bad op changes nothing
      detach(scene, n);
      attach(scene, n, op.to.parent, op.to.index);
      return;
    }
    case "add": {
      getNode(scene, op.parent); // fail before inserting, so a bad op changes nothing
      // An id that is already taken (e.g. a replayed edit after the page gained elements) would overwrite a node.
      for (const n of op.nodes) if (scene.nodes[n.id]) throw new Error(`Node already exists: ${n.id}`);
      for (const n of op.nodes) scene.nodes[n.id] = structuredClone(n);
      const top = scene.nodes[op.nodes[0]!.id]!;
      top.parent = op.parent;
      getNode(scene, op.parent).children.splice(op.index, 0, top.id);
      return;
    }
    case "delete": {
      const top = getNode(scene, op.nodes[0]!.id);
      detach(scene, top);
      for (const n of op.nodes) delete scene.nodes[n.id];
      return;
    }
    case "comment":
    case "behavior":
    case "region":
      // Annotations do not change the scene; they live in the op log only.
      return;
  }
}

export function invertOp(op: Op): Op {
  switch (op.op) {
    case "move":
    case "resize":
    case "setText":
    case "swapType":
    case "setHidden":
    case "setLocked":
    case "reorder":
      return { ...op, from: op.to, to: op.from } as Op;
    case "setStyle":
    case "setProp":
      return { ...op, from: op.to, to: op.from };
    case "add":
      return { op: "delete", parent: op.parent, index: op.index, nodes: op.nodes };
    case "delete":
      return { op: "add", parent: op.parent, index: op.index, nodes: op.nodes };
    case "comment":
    case "behavior":
    case "region":
      // Undoing an annotation is handled by the op log (it simply drops it).
      return op;
  }
}

/** Build a delete op for `id`, capturing the whole subtree so it can be undone. */
export function deleteOp(scene: Scene, id: string): Op {
  const n = getNode(scene, id);
  if (n.parent === null) throw new Error("Cannot delete the root node");
  const parent = getNode(scene, n.parent);
  return {
    op: "delete",
    parent: n.parent,
    index: parent.children.indexOf(id),
    nodes: subtreeIds(scene, id).map((nid) => structuredClone(getNode(scene, nid))),
  };
}

/** Build an add op that duplicates `id` (with fresh ids) right after the original. */
export function duplicateOp(scene: Scene, id: string, newId: (oldId: string) => string): Op {
  const n = getNode(scene, id);
  if (n.parent === null) throw new Error("Cannot duplicate the root node");
  const ids = subtreeIds(scene, id);
  const map = new Map(ids.map((old) => [old, newId(old)]));
  const nodes = ids.map((old) => {
    const copy = structuredClone(getNode(scene, old));
    copy.id = map.get(old)!;
    copy.parent = copy.parent !== null && map.has(copy.parent) ? map.get(copy.parent)! : copy.parent;
    copy.children = copy.children.map((c) => map.get(c)!);
    delete copy.source; // a duplicate does not exist in source yet
    return copy;
  });
  const parent = getNode(scene, n.parent);
  return { op: "add", parent: n.parent, index: parent.children.indexOf(id) + 1, nodes };
}

function setOrDelete(rec: Record<string, string>, key: string, value: string | null): void {
  if (value === null) delete rec[key];
  else rec[key] = value;
}

function detach(scene: Scene, n: SceneNode): void {
  if (n.parent === null) return;
  const siblings = getNode(scene, n.parent).children;
  const i = siblings.indexOf(n.id);
  if (i >= 0) siblings.splice(i, 1);
  n.parent = null;
}

function attach(scene: Scene, n: SceneNode, parentId: string, index: number): void {
  const siblings = getNode(scene, parentId).children;
  siblings.splice(Math.min(index, siblings.length), 0, n.id);
  n.parent = parentId;
}
