import { describe, expect, it } from "vitest";
import {
  alignDeltas,
  applyOp,
  invertOp,
  buildChangeList,
  changeListToPrompt,
  createScene,
  deleteManyOps,
  deleteOp,
  describeChange,
  distributeDeltas,
  documentOrder,
  duplicateManyOps,
  duplicateOp,
  groupOps,
  OpLog,
  topLevel,
  ungroupOps,
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

  it("keeps a step whose undo fails, with everything it changed", () => {
    // An applier that fails like the DOM does when page JS removed an element the inverse needs.
    let failOn: string | null = null;
    const calls: [string, boolean][] = [];
    const log = new OpLog(fixture(), (scene, op, undo) => {
      calls.push([op.op, undo]);
      applyOp(scene, op);
      if (failOn && op.op === failOn) {
        applyOp(scene, invertOp(op));
        throw new Error("NotFoundError");
      }
    });
    const ops = groupOps(log.scene, ["b1", "b2"], node("g", "nav", { type: "box", tag: "div" }));
    log.apply(...ops);
    expect(calls.every(([, undo]) => !undo)).toBe(true);

    calls.length = 0;
    failOn = "delete"; // the last inverse: removing the group's box
    expect(() => log.undo()).toThrow("NotFoundError");
    // Still done, still in the scene and the change list, and undo can be tried again.
    expect(log.canUndo).toBe(true);
    expect(log.canRedo).toBe(false);
    expect(log.scene.nodes.g!.children).toEqual(["b1", "b2"]);
    expect(buildChangeList(log).changes.map((c) => c.op)).toContain("add");
    expect(calls.slice(0, 3).map(([, undo]) => undo)).toEqual([true, true, true]); // the inverses…
    expect(calls.slice(3).every(([, undo]) => !undo)).toBe(true); // …then re-applied

    failOn = null;
    expect(log.undo()).toBe(true);
    expect(log.scene.nodes.g).toBeUndefined();
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    failOn = "add";
    expect(() => log.redo()).toThrow("NotFoundError");
    expect(log.canRedo).toBe(true);
    expect(log.scene.nodes.g).toBeUndefined();
  });

  it("forgets the last step without undoing it", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "setText", node: "b1", from: "Button 1", to: "Uno" });
    expect(log.dropLast()).toBe(true);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
    expect(log.scene.nodes.b1!.props.text).toBe("Uno");
    expect(log.dropLast()).toBe(false);
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

describe("atomic steps", () => {
  it("rolls back the whole step when one of its ops fails", () => {
    const log = new OpLog(fixture());
    expect(() =>
      log.apply(
        { op: "setText", node: "b1", from: "Button 1", to: "Changed" },
        { op: "reorder", node: "b2", from: { parent: "nav", index: 1 }, to: { parent: "gone", index: 0 } },
      ),
    ).toThrow();
    expect(log.scene.nodes.b1!.props.text).toBe("Button 1");
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    expect(log.scene.nodes.b2!.parent).toBe("nav");
    expect(log.canUndo).toBe(false);
  });

  it("refuses to add a node whose id is taken", () => {
    const log = new OpLog(fixture());
    const copy = duplicateOp(log.scene, "b1", () => "b3");
    expect(() => log.apply(copy)).toThrow(/already exists/);
    expect(log.scene.nodes.b3!.props.text).toBe("Button 3");
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
  });
});

describe("box prompts (regions)", () => {
  it("names and locates the element the box was drawn in", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "region", id: "r1", parent: "b2", rect: { x: 4, y: 6, w: 50, h: 20 }, text: "put an icon here" });
    const [c] = buildChangeList(log).changes;
    expect(c).toMatchObject({ op: "region", label: 'button "Button 2"', src: "index.html:11:5" });
    expect(describeChange(c!)).toBe('In the area 4,6 50×20 inside button "Button 2" (index.html:11:5): "put an icon here"');
  });

  it("calls the root the page, and drops boxes in deleted elements or undone ones", () => {
    const log = new OpLog(fixture());
    log.apply({ op: "region", id: "r1", parent: "root", rect: { x: 10, y: 80, w: 300, h: 120 }, text: "a hero image" });
    log.apply({ op: "region", id: "r2", parent: "b3", rect: { x: 0, y: 0, w: 10, h: 10 }, text: "x" });
    log.apply(deleteOp(log.scene, "b3"));
    log.apply({ op: "region", id: "r3", parent: "b1", rect: { x: 0, y: 0, w: 10, h: 10 }, text: "undone" });
    log.undo();
    const notes = buildChangeList(log).changes.filter((c) => c.op === "region");
    expect(notes.map((c) => describeChange(c))).toEqual(['In the area 10,80 300×120 inside the page: "a hero image"']);
  });

  it("names an element without text or id by its classes", () => {
    const s = fixture();
    s.nodes.nav!.props.class = "buttons main __glimpse-flash extra";
    const log = new OpLog(s);
    log.apply({ op: "region", id: "r1", parent: "nav", rect: { x: 0, y: 0, w: 40, h: 20 }, text: "a search field" });
    expect(buildChangeList(log).changes[0]!.label).toBe("nav.buttons.main");
  });
});

describe("align and distribute", () => {
  const rects = [
    { x: 10, y: 0, w: 50, h: 20 },
    { x: 100, y: 30, w: 20, h: 40 },
    { x: 40, y: 10, w: 30, h: 10 },
  ];
  const dx = (how: Parameters<typeof alignDeltas>[1]) => alignDeltas(rects, how).map((d) => d.dx);
  const dy = (how: Parameters<typeof alignDeltas>[1]) => alignDeltas(rects, how).map((d) => d.dy);

  it("lines rects up with the edges and center of their bounds", () => {
    expect(dx("left")).toEqual([0, -90, -30]);
    expect(dx("right")).toEqual([60, 0, 50]);
    expect(dx("center")).toEqual([30, -45, 10]);
    expect(dy("top")).toEqual([0, -30, -10]);
    expect(dy("bottom")).toEqual([50, 0, 50]);
    expect(dy("middle")).toEqual([25, -15, 20]);
    expect(alignDeltas(rects, "left").every((d) => d.dy === 0)).toBe(true);
  });

  it("spaces rects evenly between the outer two", () => {
    // By x: [10..60], [40..70], [100..120]: 10px of free space, so 5px gaps.
    expect(distributeDeltas(rects, "x")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 25, dy: 0 },
    ]);
    // By y: [0..20], [10..20], [30..70]: no free space, so no gaps.
    expect(distributeDeltas(rects, "y")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 10 },
    ]);
    expect(distributeDeltas(rects.slice(0, 2), "x")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });
});

describe("multi-selection", () => {
  it("keeps only outermost nodes, in document order", () => {
    const s = fixture();
    expect(topLevel(s, ["b2", "nav", "root", "missing", "nav"])).toEqual(["nav"]);
    expect(documentOrder(s, ["b3", "b1", "missing", "nav"])).toEqual(["nav", "b1", "b3"]);
  });

  it("deletes several elements as one undo step", () => {
    const log = new OpLog(fixture());
    const ops = deleteManyOps(log.scene, ["b3", "b1", "root"]);
    expect(ops).toHaveLength(2);
    log.apply(...ops);
    expect(log.scene.nodes.nav!.children).toEqual(["b2"]);
    log.undo();
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    expect(deleteManyOps(log.scene, ["nav", "b2"])).toHaveLength(1);
  });

  it("duplicates each element right after itself", () => {
    const log = new OpLog(fixture());
    let n = 0;
    log.apply(...duplicateManyOps(log.scene, ["b3", "b1"], () => `c${++n}`));
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "c1", "b2", "b3", "c2"]);
    log.undo();
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
  });
});

describe("group and ungroup", () => {
  const box = (id: string): SceneNode => ({
    id,
    type: "box",
    tag: "div",
    parent: null,
    children: [],
    layout: { x: 140, y: 10, w: 220, h: 40 },
    style: { display: "flex" },
    props: {},
  });

  it("wraps siblings in a new box as one undo step", () => {
    const log = new OpLog(fixture());
    const ops = groupOps(log.scene, ["b3", "b2"], box("g1"));
    expect(ops.map((o) => o.op)).toEqual(["add", "reorder", "reorder"]);
    log.apply(...ops);
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "g1"]);
    expect(log.scene.nodes.g1!.children).toEqual(["b2", "b3"]);
    expect(log.scene.nodes.b3!.parent).toBe("g1");
    log.undo();
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    expect(log.scene.nodes.g1).toBeUndefined();
    log.redo();
    expect(log.scene.nodes.g1!.children).toEqual(["b2", "b3"]);
  });

  it("only groups elements that share a parent", () => {
    expect(groupOps(fixture(), ["nav", "b1"], box("g1"))).toEqual([]);
    expect(groupOps(fixture(), ["root"], box("g1"))).toEqual([]);
    expect(groupOps(fixture(), ["b1"], box("b2"))).toEqual([]); // id already taken
  });

  it("reports a group as a new box that wraps the existing elements", () => {
    const log = new OpLog(fixture());
    log.apply(...groupOps(log.scene, ["b1", "b2"], box("g1")));
    const changes = buildChangeList(log).changes;
    expect(changes.map((c) => c.op)).toEqual(["add", "reorder", "reorder"]);
    const add = changes[0]!;
    if (add.op !== "add") throw new Error();
    expect(add.nodes.map((n) => n.id)).toEqual(["g1"]); // the wrapped buttons are not new
    expect(add.intent).toContain('wraps button "Button 1" and button "Button 2"');
    const reorder = changes[1]!;
    expect(reorder).toMatchObject({ op: "reorder", node: "b1", to: { parent: "g1", index: 0 } });
    expect(reorder.anchor).toBeUndefined();
    expect(describeChange(add)).toContain("Add box<div> g1 with style {display: flex}");
  });

  it("ungroups a box into its parent, at its position", () => {
    const s = fixture();
    s.nodes.nav!.source = { file: "index.html", line: 9, col: 5 };
    const log = new OpLog(s);
    const ops = ungroupOps(log.scene, "nav");
    expect(ops.map((o) => o.op)).toEqual(["reorder", "reorder", "reorder", "delete"]);
    log.apply(...ops);
    expect(log.scene.nodes.root!.children).toEqual(["b1", "b2", "b3"]);
    expect(log.scene.nodes.nav).toBeUndefined();
    expect(log.scene.nodes.b2!.parent).toBe("root");

    const changes = buildChangeList(log).changes;
    const del = changes.find((c) => c.op === "delete")!;
    if (del.op !== "delete") throw new Error();
    expect(del.nodes.map((n) => n.id)).toEqual(["nav"]); // the buttons survive
    expect(describeChange(del)).toBe(
      'Delete nav nav — unwrap: remove only its tags at index.html:9:5 and keep its children button "Button 1", button "Button 2" and button "Button 3" in its place.',
    );
    // Not located or anchored: the source patcher must not delete the nav's range
    // (children included) or move children on its own; the AI does the unwrap.
    expect(del.src).toBeUndefined();
    const reorders = changes.filter((c) => c.op === "reorder");
    expect(reorders).toHaveLength(3);
    expect(reorders.every((c) => c.anchor === undefined && c.src !== undefined)).toBe(true);

    log.undo();
    expect(log.scene.nodes.root!.children).toEqual(["nav"]);
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    expect(ungroupOps(log.scene, "b1")).toEqual([]);
  });

  it("cancels out when a group is ungrouped again", () => {
    const log = new OpLog(fixture());
    log.apply(...groupOps(log.scene, ["b1", "b2"], box("g1")));
    log.apply(...ungroupOps(log.scene, "g1"));
    expect(log.scene.nodes.nav!.children).toEqual(["b1", "b2", "b3"]);
    expect(buildChangeList(log).changes).toEqual([]);
  });
});
