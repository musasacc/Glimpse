import { describe, expect, it } from "vitest";
import { createScene, diffScenes, groupOps, OpLog, ungroupOps, type Op, type Scene, type SceneNode, type Target } from "./index.js";

function node(id: string, parent: string, layout: SceneNode["layout"], extra: Partial<SceneNode> = {}): SceneNode {
  return { id, type: "button", parent, children: [], layout, style: {}, props: {}, ...extra };
}

/** root > row(0,20) > [ok(0,0), cancel(12,0)] */
function fixture(target: Target): Scene {
  const s = createScene(target, { x: 0, y: 0, w: 80, h: 24 });
  s.nodes.row = node("row", "root", { x: 0, y: 20, w: 80, h: 3 }, { type: "box", children: ["ok", "cancel"] });
  s.nodes.ok = node("ok", "row", { x: 0, y: 0, w: 10, h: 3 }, { props: { text: "OK" } });
  s.nodes.cancel = node("cancel", "row", { x: 12, y: 0, w: 10, h: 3 }, { props: { text: "Cancel" } });
  s.nodes.root!.children.push("row");
  return s;
}

/** Group ok + cancel into a box at (2, 0) and shift them into its coordinates, as the scene editor does. */
function grouped(target: Target): OpLog {
  const log = new OpLog(fixture(target));
  const box = node("g", "row", { x: 2, y: 0, w: 20, h: 3 }, { type: "box" });
  const ops: Op[] = groupOps(log.scene, ["ok", "cancel"], box);
  ops.push({ op: "move", node: "ok", from: { x: 0, y: 0 }, to: { x: -2, y: 0 } });
  ops.push({ op: "move", node: "cancel", from: { x: 12, y: 0 }, to: { x: 10, y: 0 } });
  log.apply(...ops);
  return log;
}

describe("diffScenes on mocks", () => {
  it("doesn't report a grouped node that stayed in place as moved", () => {
    const log = grouped("tui");
    const ops = diffScenes(log.base, log.scene).map((c) => c.op);
    expect(ops).toEqual(["add", "reorder", "reorder"]);
  });

  it("still reports a real move of a regrouped node", () => {
    const log = grouped("native");
    log.apply({ op: "move", node: "cancel", from: { x: 10, y: 0 }, to: { x: 14, y: 0 } });
    const moves = diffScenes(log.base, log.scene).filter((c) => c.op === "move");
    expect(moves.map((c) => c.op === "move" && c.node)).toEqual(["cancel"]);
  });

  it("keeps reporting coordinate changes of reparented nodes on web pages", () => {
    const log = grouped("html");
    expect(diffScenes(log.base, log.scene).filter((c) => c.op === "move")).toHaveLength(2);
  });

  it("treats an ungroup that keeps children in place as structure only", () => {
    const log = grouped("tui");
    const after = new OpLog(log.scene);
    const ops = ungroupOps(after.scene, "g");
    ops.push({ op: "move", node: "ok", from: { x: -2, y: 0 }, to: { x: 0, y: 0 } });
    ops.push({ op: "move", node: "cancel", from: { x: 10, y: 0 }, to: { x: 12, y: 0 } });
    after.apply(...ops);
    expect(diffScenes(after.base, after.scene).map((c) => c.op)).toEqual(["delete", "reorder", "reorder"]);
  });
});
