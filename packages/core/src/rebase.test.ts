import { describe, expect, it } from "vitest";
import { cloneScene, createScene, deleteOp, groupOps, OpLog, rebaseOps, type Op, type Scene, type SceneNode } from "./index.js";

function node(id: string, parent: string, extra: Partial<SceneNode> = {}): SceneNode {
  return { id, type: "button", parent, children: [], layout: { x: 0, y: 0, w: 10, h: 3 }, style: {}, props: {}, ...extra };
}

/** root > row > [ok, cancel] in an 80×24 terminal. */
function fixture(): Scene {
  const s = createScene("tui", { x: 0, y: 0, w: 80, h: 24 });
  s.nodes.row = node("row", "root", { type: "box", children: ["ok", "cancel"], layout: { x: 0, y: 20, w: 80, h: 3 } });
  s.nodes.ok = node("ok", "row", { props: { text: "OK" } });
  s.nodes.cancel = node("cancel", "row", { layout: { x: 12, y: 0, w: 10, h: 3 }, props: { text: "Cancel" } });
  s.nodes.root!.children.push("row");
  return s;
}

describe("rebaseOps", () => {
  it("takes from-values from the newer scene, so undo returns to it", () => {
    const newer = fixture();
    newer.nodes.ok!.props.text = "Okay";
    newer.nodes.ok!.layout.x = 2;
    const ops: Op[] = [
      { op: "setText", node: "ok", from: "OK", to: "Save" },
      { op: "move", node: "ok", from: { x: 0, y: 0 }, to: { x: 5, y: 0 } },
    ];
    const rebased = rebaseOps(newer, ops)!;
    expect(rebased).toEqual([
      { op: "setText", node: "ok", from: "Okay", to: "Save" },
      { op: "move", node: "ok", from: { x: 2, y: 0 }, to: { x: 5, y: 0 } },
    ]);
    const log = new OpLog(newer);
    log.apply(...rebased);
    expect(log.scene.nodes.ok!.props.text).toBe("Save");
    log.undo();
    expect(log.scene).toEqual(newer);
  });

  it("drops a step whose node is gone and leaves the scene alone", () => {
    const newer = fixture();
    delete newer.nodes.cancel;
    newer.nodes.row!.children = ["ok"];
    expect(rebaseOps(newer, [{ op: "setText", node: "cancel", from: "Cancel", to: "Back" }])).toBeNull();
    expect(rebaseOps(newer, [{ op: "comment", node: "cancel", id: "c1", text: "make it red" }])).toBeNull();
  });

  it("recaptures a deleted subtree from the newer scene", () => {
    const base = fixture();
    const del = deleteOp(base, "row");
    const newer = fixture();
    newer.nodes.extra = node("extra", "row", { props: { text: "Extra" } });
    newer.nodes.row!.children.push("extra");
    const [rebased] = rebaseOps(newer, [del])!;
    expect(rebased!.op === "delete" && rebased!.nodes.map((n) => n.id)).toEqual(["row", "ok", "cancel", "extra"]);
    const log = new OpLog(newer);
    log.apply(rebased!);
    expect(Object.keys(log.scene.nodes)).toEqual(["root"]);
    log.undo();
    expect(log.scene).toEqual(newer);
  });

  it("refuses an add whose id the agent has taken meanwhile, and clamps indices", () => {
    const newer = fixture();
    const add: Op = { op: "add", parent: "row", index: 5, nodes: [node("help", "row")] };
    expect(rebaseOps(newer, [add])).toEqual([{ ...add, index: 2 }]);
    newer.nodes.help = node("help", "root");
    newer.nodes.root!.children.push("help");
    expect(rebaseOps(newer, [add])).toBeNull();
  });

  it("rebases a group step in order (add the box, then move nodes into it)", () => {
    const base = fixture();
    const group = node("g1", "row", { type: "box", layout: { x: 0, y: 0, w: 22, h: 3 } });
    const ops = groupOps(base, ["ok", "cancel"], group);
    const newer = fixture();
    newer.nodes.row!.children.reverse(); // the agent swapped the buttons
    const rebased = rebaseOps(newer, ops)!;
    const log = new OpLog(newer);
    log.apply(...rebased);
    expect(log.scene.nodes.g1!.children).toEqual(["ok", "cancel"]);
    expect(log.scene.nodes.row!.children).toEqual(["g1"]);
    log.undo();
    expect(log.scene).toEqual(newer);
  });

  it("won't move a node into its own subtree", () => {
    const newer = fixture();
    const op: Op = { op: "reorder", node: "row", from: { parent: "root", index: 0 }, to: { parent: "ok", index: 0 } };
    expect(rebaseOps(newer, [op])).toBeNull();
    expect(newer).toEqual(fixture());
  });

  it("doesn't touch the scene it is given", () => {
    const newer = fixture();
    const copy = cloneScene(newer);
    rebaseOps(newer, [{ op: "move", node: "ok", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }]);
    expect(newer).toEqual(copy);
  });
});
