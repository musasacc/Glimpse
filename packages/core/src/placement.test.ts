import { describe, expect, it } from "vitest";
import { buildChangeList, changeListToPrompt, createScene, describeChange, numberedChanges, OpLog, sceneBox, type Scene, type SceneNode } from "./index.js";

function node(id: string, parent: string, extra: Partial<SceneNode> = {}): SceneNode {
  return { id, type: "box", tag: "div", parent, children: [], layout: { x: 0, y: 0, w: 100, h: 40 }, style: {}, props: {}, ...extra };
}

/** root > main (at 0,100) > [h1 "Donut Shop", p "Fresh daily", button "Order now"], stacked and left-aligned. */
function page(): Scene {
  const s = createScene("html");
  s.nodes.main = node("main", "root", { tag: "main", children: ["h1", "p", "order"], layout: { x: 0, y: 100, w: 800, h: 300 }, source: { file: "index.html", line: 9, col: 5 } });
  s.nodes.root!.children.push("main");
  s.nodes.h1 = node("h1", "main", { type: "text", tag: "h1", layout: { x: 24, y: 0, w: 400, h: 48 }, props: { text: "Donut Shop" }, source: { file: "index.html", line: 10, col: 7 } });
  s.nodes.p = node("p", "main", { type: "text", tag: "p", layout: { x: 24, y: 60, w: 400, h: 20 }, props: { text: "Fresh daily" }, source: { file: "index.html", line: 11, col: 7 } });
  s.nodes.order = node("order", "main", { type: "button", tag: "button", layout: { x: 24, y: 200, w: 120, h: 40 }, props: { text: "Order now" }, source: { file: "index.html", line: 12, col: 7 } });
  return s;
}

const save = (id = "save", extra: Partial<SceneNode> = {}) =>
  node(id, "main", { type: "button", tag: "button", layout: { x: 24, y: 100, w: 120, h: 40 }, props: { text: "Save" }, ...extra });

describe("where changed elements are", () => {
  it("places an added element between its visual neighbours, with alignment", () => {
    const log = new OpLog(page());
    log.apply({ op: "add", parent: "main", index: 2, nodes: [save()] });
    const [add] = buildChangeList(log).changes;
    expect(add!.box).toEqual({ x: 24, y: 200, w: 120, h: 40 });
    expect(add!.place).toBe('at x 24, y 200 (120×40px); below text<p> "Fresh daily" and above button "Order now", left-aligned with them');
    expect(describeChange(add!)).toContain(' Position: at x 24, y 200 (120×40px); below text<p> "Fresh daily" and above button "Order now", left-aligned with them.');
    expect(describeChange(add!)).toContain("In code: after the element at index.html:11:7, before the element at index.html:12:7.");
  });

  it("uses the boxes measured in the live page over the scene's layouts", () => {
    const log = new OpLog(page());
    log.apply({ op: "add", parent: "main", index: 3, nodes: [save()] });
    // The live page put it right of "Order now", not where the palette's guess said.
    const live: Record<string, { x: number; y: number; w: number; h: number }> = { save: { x: 160.4, y: 300, w: 80, h: 40 } };
    const list = buildChangeList(log, undefined, { measure: (id) => live[id] ?? sceneBox(log.scene, id), viewport: { width: 800, height: 600 } });
    expect(list.changes[0]!.box).toEqual({ x: 160, y: 300, w: 80, h: 40 });
    expect(list.changes[0]!.place).toContain('right of button "Order now", top-aligned with it');
    expect(changeListToPrompt(list)).toContain("Positions are page coordinates in CSS px from the top-left of the page with the preview 800px wide");
  });

  it("names the slot in a row and in a grid", () => {
    const s = page();
    s.nodes.main!.children = ["a", "b", "c"];
    ["a", "b", "c"].forEach((id, i) => (s.nodes[id] = node(id, "main", { type: "button", tag: "button", layout: { x: 24 + i * 130, y: 0, w: 120, h: 40 }, props: { text: id.toUpperCase() } })));
    const log = new OpLog(s);
    log.apply({ op: "add", parent: "main", index: 3, nodes: [save("d", { layout: { x: 414, y: 0, w: 120, h: 40 } })] });
    expect(buildChangeList(log).changes[0]!.place).toBe('at x 414, y 100 (120×40px); right of button "C", top-aligned with it; 4th of 4 buttons in a row');

    // A second row turns it into a grid.
    const g = structuredClone(log.scene);
    g.nodes.main!.children.push("e", "f");
    g.nodes.e = node("e", "main", { type: "button", layout: { x: 24, y: 60, w: 120, h: 40 } });
    g.nodes.f = node("f", "main", { type: "button", layout: { x: 154, y: 60, w: 120, h: 40 } });
    const log2 = new OpLog(g);
    log2.apply({ op: "move", node: "f", from: { x: 154, y: 60 }, to: { x: 284, y: 60 } });
    expect(buildChangeList(log2).changes[0]!.place).toMatch(/; row 2, column 2 of a grid of buttons$/);
  });

  it("describes resizes and moves with their new neighbours", () => {
    const log = new OpLog(page());
    log.apply({ op: "resize", node: "order", from: { x: 24, y: 200, w: 120, h: 40 }, to: { x: 24, y: 200, w: 400, h: 40 } });
    log.apply({ op: "move", node: "h1", from: { x: 24, y: 0 }, to: { x: 24, y: 120 } });
    const changes = buildChangeList(log).changes;
    const resize = changes.find((c) => c.op === "resize")!;
    const move = changes.find((c) => c.op === "move")!;
    expect(describeChange(resize)).toMatch(/^Resize button "Order now" \(index\.html:12:7\): size 120×40 → 400×40 \(\+280w, 0h\)\. Position: at x 24, y 300 \(400×40px\); below text<h1> "Donut Shop"/);
    expect(move.place).toBe('at x 24, y 220 (400×48px); below text<p> "Fresh daily" and above button "Order now", left-aligned with them');
  });

  it("locates box prompts and comments, and gives other edits a box only", () => {
    const log = new OpLog(page());
    log.apply({ op: "region", id: "r1", parent: "main", rect: { x: 440, y: 0, w: 300, h: 80 }, text: "a donut photo" });
    log.apply({ op: "comment", node: "order", id: "c1", text: "make it pop" });
    log.apply({ op: "setText", node: "p", from: "Fresh daily", to: "Fresh every morning" });
    const changes = buildChangeList(log).changes;
    expect(describeChange(changes.find((c) => c.op === "region")!)).toBe(
      'In the box the human drew at x 440, y 100 (300×80px); right of text<h1> "Donut Shop", top-aligned with it; inside box<main> main (index.html:9:5): "a donut photo"',
    );
    expect(describeChange(changes.find((c) => c.op === "comment")!)).toBe('Instruction for button "Order now" (index.html:12:7), at x 24, y 300 (120×40px): "make it pop"');
    const text = changes.find((c) => c.op === "setText")!;
    expect(text.box).toEqual({ x: 24, y: 160, w: 400, h: 20 });
    expect(text.place).toBeUndefined();
  });

  it("names what a box prompt covers, or what a moved element now overlaps", () => {
    const log = new OpLog(page());
    log.apply({ op: "region", id: "r1", parent: "main", rect: { x: 300, y: 10, w: 200, h: 60 }, text: "a badge" });
    log.apply({ op: "move", node: "order", from: { x: 24, y: 200 }, to: { x: 24, y: 70 } });
    const changes = buildChangeList(log).changes;
    expect(changes.find((c) => c.op === "region")!.place).toBe(
      'at x 300, y 110 (200×60px); over text<h1> "Donut Shop" and text<p> "Fresh daily"; inside box<main> main (index.html:9:5)',
    );
    // A copy right on top of its original.
    const dup = new OpLog(page());
    dup.apply({ op: "add", parent: "main", index: 3, nodes: [save("copy", { layout: { x: 24, y: 200, w: 120, h: 40 } })] });
    expect(buildChangeList(dup).changes[0]!.place).toMatch(/^at x 24, y 300 \(120×40px\); overlapping button "Order now", below text<p> "Fresh daily"/);
    expect(changes.find((c) => c.op === "move")!.place).toBe('at x 24, y 170 (120×40px); overlapping text<p> "Fresh daily", below text<h1> "Donut Shop", left-aligned with it');
  });

  it("works in terminal cells", () => {
    const s = createScene("tui", { x: 0, y: 0, w: 80, h: 24 });
    s.nodes.list = node("list", "root", { type: "panel", tag: "panel", layout: { x: 0, y: 1, w: 30, h: 20 }, children: ["ok"] });
    s.nodes.ok = node("ok", "list", { type: "button", tag: "button", layout: { x: 2, y: 2, w: 8, h: 1 }, props: { text: "OK" } });
    s.nodes.root!.children.push("list");
    const log = new OpLog(s);
    log.apply({ op: "add", parent: "list", index: 1, nodes: [node("cancel", "list", { type: "button", layout: { x: 12, y: 2, w: 8, h: 1 }, props: { text: "Cancel" } })] });
    const list = buildChangeList(log);
    expect(list.changes[0]!.place).toBe('at column 12, row 3 (8×1 cells); right of button "OK", top-aligned with it; 2nd of 2 buttons in a row');
    expect(changeListToPrompt(list)).toContain("Positions are terminal cells from the top-left of the screen (column, row).");
  });

  it("numbers changes by their screenshot markers when every change has one", () => {
    const log = new OpLog(page());
    log.apply({ op: "setText", node: "p", from: "Fresh daily", to: "Hot" });
    log.apply({ op: "setText", node: "h1", from: "Donut Shop", to: "Donuts" });
    const changes = buildChangeList(log).changes;
    expect(numberedChanges(changes).map((l) => l.split(".")[0])).toEqual(["1", "2"]);
    // Change 1 was handled elsewhere (e.g. written into a scene file): the rest keep their marker numbers.
    const marked = changes.map((c, i) => ({ ...c, mark: i + 1 }));
    expect(numberedChanges(marked.slice(1))[0]).toMatch(/^2\. Change the text of text<p> "Hot"/);
    expect(numberedChanges([{ ...marked[1]!, mark: undefined }, marked[0]!]).map((l) => l[0])).toEqual(["1", "2"]);
  });
});
