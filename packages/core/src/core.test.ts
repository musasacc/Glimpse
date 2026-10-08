import { describe, expect, it } from "vitest";
import {
  buildChangeList,
  changeListToPrompt,
  createScene,
  deleteOp,
  duplicateOp,
  OpLog,
  type Scene,
  type SceneNode,
} from "./index.js";

function node(id: string, parent: string, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: "button",
    tag: "button",
    parent,
    children: [],
    layout: { x: 0, y: 0, w: 100, h: 40 },
    style: {},
    props: {},
    ...extra,
  };
}

/** root > nav > [b1, b2, b3] */
function fixture(): Scene {
  const s = createScene("html");
  s.nodes.nav = node("nav", "root", { type: "nav", tag: "nav", children: ["b1", "b2", "b3"], layout: { x: 0, y: 0, w: 1280, h: 60 } });
  s.nodes.root!.children.push("nav");
  ["b1", "b2", "b3"].forEach((id, i) => {
    s.nodes[id] = node(id, "nav", {
      layout: { x: 20 + i * 120, y: 10, w: 100, h: 40 },
      props: { text: `Button ${i + 1}` },
      source: { file: "index.html", line: 10 + i, col: 5 },
    });
  });
  return s;
}

describe("OpLog", () => {
  it("applies, undoes and redoes", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "setText", node: "b1", from: "Button 1", to: "Buy now" });
    expect(log.scene.nodes.b1!.props.text).toBe("Buy now");
    log.undo();
    expect(log.scene.nodes.b1!.props.text).toBe("Button 1");
    log.redo();
    expect(log.scene.nodes.b1!.props.text).toBe("Buy now");
  });

  it("undoes a delete including its subtree", () => {
    const log = new OpLog(fixture());
    log.apply(deleteOp(log.scene, "nav"));
    expect(log.scene.nodes.b2).toBeUndefined();
    expect(log.scene.nodes.root!.children).toEqual([]);
    log.undo();
    expect(log.scene.nodes.b2!.props.text).toBe("Button 2");
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
  });

  it("groups several ops into one undo step", () => {
    const log = new OpLog(fixture());
    log.apply(
      { op: "move", node: "b1", from: { x: 20, y: 10 }, to: { x: 30, y: 10 } },
      { op: "move", node: "b2", from: { x: 140, y: 10 }, to: { x: 150, y: 10 } },
    );
    log.undo();
    expect(log.scene.nodes.b1!.layout.x).toBe(20);
    expect(log.scene.nodes.b2!.layout.x).toBe(140);
  });

  it("does not mutate the base scene", () => {
    const base = fixture();
    const log = new OpLog(base);
    log.apply({ op: "setStyle", node: "b1", key: "color", from: null, to: "red" });
    expect(base.nodes.b1!.style.color).toBeUndefined();
    expect(log.base.nodes.b1!.style.color).toBeUndefined();
  });
});

describe("buildChangeList", () => {
  it("is empty when edits cancel out", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "setStyle", node: "b1", key: "color", from: null, to: "red" });
    log.apply({ op: "setStyle", node: "b1", key: "color", from: "red", to: null });
    log.apply({ op: "setText", node: "b2", from: "Button 2", to: "x" });
    log.undo();
    expect(buildChangeList(log).changes).toEqual([]);
  });

  it("collapses repeated edits into one change with source location", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "setStyle", node: "b1", key: "background", from: null, to: "blue" });
    log.apply({ op: "setStyle", node: "b1", key: "background", from: "blue", to: "red" });
    const { changes } = buildChangeList(log);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ op: "setStyle", key: "background", from: null, to: "red", src: "index.html:10:5" });
    expect(changes[0]!.label).toBe('button "Button 1"');
  });

  it("drops nodes that were added then deleted, and edits on deleted nodes", () => {
    const log = new OpLog(fixture());
    log.apply(duplicateOp(log.scene, "b1", (id) => `${id}-copy`));
    log.apply({ op: "setText", node: "b1-copy", from: "Button 1", to: "Copy" });
    log.apply(deleteOp(log.scene, "b1-copy"));
    log.apply({ op: "setText", node: "b3", from: "Button 3", to: "Gone soon" });
    log.apply(deleteOp(log.scene, "b3"));
    const { changes } = buildChangeList(log);
    expect(changes.map((c) => c.op)).toEqual(["delete"]);
    expect(changes[0]).toMatchObject({ op: "delete", parent: "nav", index: 2 });
  });

  it("reports an added node with its final state and position intent", () => {
    const log = new OpLog(fixture());
    log.apply(duplicateOp(log.scene, "b1", (id) => `${id}-copy`));
    log.apply({ op: "setText", node: "b1-copy", from: "Button 1", to: "Save" });
    const [add] = buildChangeList(log).changes;
    expect(add!.op).toBe("add");
    if (add!.op !== "add") throw new Error();
    expect(add!.nodes[0]!.props.text).toBe("Save");
    expect(add!.intent).toContain('after button "Button 1"');
    expect(add!.intent).toContain('before button "Button 2"');
  });

  it("reports only the element that actually moved in a reorder", () => {
    const log = new OpLog(fixture());
    // Move b3 to the front: [b3, b1, b2]
    log.apply({ op: "reorder", node: "b3", from: { parent: "nav", index: 2 }, to: { parent: "nav", index: 0 } });
    const changes = buildChangeList(log).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ op: "reorder", node: "b3", to: { parent: "nav", index: 0 } });
  });

  it("adds a semantic intent to moves", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "move", node: "b1", from: { x: 20, y: 10 }, to: { x: 400, y: 10 } });
    const [move] = buildChangeList(log).changes;
    expect(move!.intent).toMatch(/^moved 380px right; now right of button "Button 3"/);
  });

  it("keeps annotations and drops those on deleted elements", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "comment", node: "b1", id: "c1", text: "make this bounce" });
    log.apply({ op: "comment", node: "b2", id: "c2", text: "never mind" });
    log.apply(deleteOp(log.scene, "b2"));
    log.apply({ op: "behavior", node: "b1", id: "h1", event: "click", action: "open modal", detail: "#signup" });
    const ops = buildChangeList(log).changes.map((c) => c.op);
    expect(ops).toEqual(["delete", "comment", "behavior"]);
  });

  it("renders a readable prompt", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "setStyle", node: "b1", key: "background", from: null, to: "red" });
    log.apply({ op: "comment", node: "b2", id: "c1", text: "make this bounce" });
    const prompt = changeListToPrompt(buildChangeList(log, "keep it minimal"));
    expect(prompt).toContain("Note from the human: keep it minimal");
    expect(prompt).toContain('1. Set style `background: red` on button "Button 1" (index.html:10:5).');
    expect(prompt).toContain('2. Instruction for button "Button 2" (index.html:11:5): "make this bounce"');
  });
});

describe("move intent alignment", () => {
  it("does not claim edge alignment when the element overflows its parent", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "resize", node: "b1", from: { x: 20, y: 10, w: 100, h: 40 }, to: { x: 20, y: 10, w: 1280, h: 40 } });
    log.apply({ op: "move", node: "b1", from: { x: 20, y: 10 }, to: { x: 100, y: 10 } });
    const [resize] = buildChangeList(log).changes;
    expect(resize!.op).toBe("resize");
    const log2 = new OpLog(fixture());
    log2.apply({ op: "move", node: "b3", from: { x: 260, y: 10 }, to: { x: 1250, y: 10 } });
    expect(buildChangeList(log2).changes[0]!.intent).toContain("sticks out of its parent");
  });

  it("detects centering", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "move", node: "b1", from: { x: 20, y: 10 }, to: { x: 590, y: 10 } });
    expect(buildChangeList(log).changes[0]!.intent).toContain("horizontally centered in parent");
  });
});

describe("anchors", () => {
  it("records the source of the neighbours an added or reordered element sits between", () => {
    const log = new OpLog(fixture());
    log.apply(duplicateOp(log.scene, "b1", (id) => `${id}-copy`));
    log.apply({ op: "reorder", node: "b3", from: { parent: "nav", index: 3 }, to: { parent: "nav", index: 0 } });
    const changes = buildChangeList(log).changes;
    const add = changes.find((c) => c.op === "add")!;
    expect(add.anchor).toEqual({ after: "index.html:10:5", before: "index.html:11:5" });
    expect(add.src).toBe(undefined); // nav has no source in the fixture
    const reorder = changes.find((c) => c.op === "reorder")!;
    expect(reorder.anchor).toEqual({ before: "index.html:10:5" });
  });
});
