import { describe, expect, it } from "vitest";
import { applyOp, createScene, OpLog, type Op, type Scene } from "@glimpse/core";
import { followMoves, followOps, repeatedSources, sameEdit, undoAll } from "./hmr";

/** A <nav> with one button per label, ids g1… in page order (as DomBridge numbers a fresh page). */
function page(labels: string[], opts: { line?: (i: number) => number } = {}): Scene {
  const scene = createScene("react");
  const nav = "g1";
  scene.nodes[nav] = { id: nav, type: "nav", tag: "nav", parent: "root", children: [], layout: { x: 0, y: 0, w: 0, h: 0 }, style: {}, props: { class: "buttons" } };
  scene.nodes.root!.children.push(nav);
  labels.forEach((text, i) => {
    const id = `g${i + 2}`;
    const line = opts.line?.(i) ?? 20 + i;
    scene.nodes[id] = {
      id,
      type: "button",
      tag: "button",
      parent: nav,
      children: [],
      layout: { x: 0, y: 0, w: 0, h: 0 },
      style: {},
      props: { class: "btn", text },
      source: { file: "src/App.tsx", line, col: 9 },
    };
    scene.nodes[nav]!.children.push(id);
  });
  return scene;
}

const texts = (scene: Scene) => scene.nodes.g1!.children.map((id) => scene.nodes[id]!.props.text);

describe("followMoves", () => {
  it("follows elements React reused for their neighbours when the source gains one before them", () => {
    // React keeps the DOM nodes by position: g3 now shows Vanilla, g4 Chocolate, …, and g7 is new.
    const before = page(["Glazed", "Chocolate", "Sprinkles", "Maple", "Order now"]);
    const after = page(["Glazed", "Vanilla", "Chocolate", "Sprinkles", "Maple", "Order now"]);
    const moved = followMoves(before, after);
    expect(Object.fromEntries(moved)).toEqual({ g3: "g4", g4: "g5", g5: "g6", g6: "g7" });
  });

  it("follows them back when the source loses one, and marks the lost one gone", () => {
    const before = page(["Glazed", "Chocolate", "Sprinkles"]);
    const after = page(["Chocolate", "Sprinkles"]);
    expect(Object.fromEntries(followMoves(before, after))).toEqual({ g2: "", g3: "g2", g4: "g3" });
  });

  it("leaves elements alone that still look the same, or changed with nowhere else to go", () => {
    const before = page(["Glazed", "Chocolate"]);
    const after = page(["Glazed", "Dark chocolate"]);
    expect(followMoves(before, after).size).toBe(0);
  });

  it("keeps look-alikes in order", () => {
    const before = page(["A", "Item", "Item", "B"]);
    const after = page(["New", "A", "Item", "Item", "B"]);
    expect(Object.fromEntries(followMoves(before, after))).toEqual({ g2: "g3", g3: "g4", g4: "g5", g5: "g6" });
  });

  it("tells containers apart by what is inside them", () => {
    // Cards without text of their own: <div class="card"><h3>…</h3></div>, a new one first.
    const cards = (titles: string[]) => {
      const scene = createScene("react");
      titles.forEach((title, i) => {
        const card = `c${i}`;
        const h3 = `h${i}`;
        const base = { layout: { x: 0, y: 0, w: 0, h: 0 }, style: {}, source: { file: "src/Card.tsx", line: 3, col: 5 } };
        scene.nodes[card] = { ...base, id: card, type: "box", tag: "div", parent: "root", children: [h3], props: { class: "card" } };
        scene.nodes[h3] = { ...base, id: h3, type: "text", tag: "h3", parent: card, children: [], props: { text: title } };
        scene.nodes.root!.children.push(card);
      });
      return scene;
    };
    const moved = followMoves(cards(["Glazed", "Maple"]), cards(["New", "Glazed", "Maple"]));
    expect(Object.fromEntries(moved)).toEqual({ c0: "c1", h0: "h1", c1: "c2", h1: "h2" });
  });
});

describe("followOps", () => {
  it("points edits at the elements they were made on and retakes deletes from the page as it is now", () => {
    const before = page(["Glazed", "Chocolate", "Sprinkles", "Maple", "Order now"]);
    const after = page(["Glazed", "Vanilla", "Chocolate", "Sprinkles", "Maple", "Order now"]);
    const ops: Op[] = [
      { op: "setText", node: "g3", from: "Chocolate", to: "Choc!!" },
      { op: "delete", parent: "g1", index: 3, nodes: [structuredClone(before.nodes.g5!)] },
    ];
    const moved = followMoves(before, after);
    const [setText, del] = followOps(ops, moved, after);
    expect(setText).toMatchObject({ op: "setText", node: "g4", to: "Choc!!" });
    expect(del).toMatchObject({ op: "delete", parent: "g1", index: 4, nodes: [{ id: "g6", props: { text: "Maple" } }] });
    applyOp(after, setText!);
    applyOp(after, del!);
    expect(texts(after)).toEqual(["Glazed", "Vanilla", "Choc!!", "Sprinkles", "Order now"]);
  });

  it("fails an edit of an element that is gone", () => {
    const moved = followMoves(page(["Glazed", "Chocolate"]), page(["Chocolate"]));
    expect(() => followOps([{ op: "setText", node: "g2", from: "Glazed", to: "G" }], moved, page(["Chocolate"]))).toThrow(/gone/);
  });

  it("returns the ops untouched when nothing moved", () => {
    const ops: Op[] = [{ op: "setText", node: "g2", from: "a", to: "b" }];
    expect(followOps(ops, new Map(), page(["a"]))).toBe(ops);
  });
});

describe("repeatedSources", () => {
  it("counts locations the page renders more than once, the most any scene shows", () => {
    const list = page(["Glazed", "Chocolate", "Sprinkles"], { line: () => 22 });
    const fewer = page(["Glazed", "Chocolate"], { line: () => 22 });
    expect(Object.fromEntries(repeatedSources([fewer, list]))).toEqual({ "src/App.tsx:22:9": 3 });
    expect(repeatedSources([page(["Glazed", "Chocolate"])]).size).toBe(0);
  });
});

describe("undoAll", () => {
  it("undoes every step, skipping one whose element is gone", () => {
    const scene = page(["Glazed", "Chocolate", "Sprinkles"]);
    let broken = false;
    const log = new OpLog(scene, (s, op) => {
      if (broken && op.op === "setText" && op.node === "g3") throw new Error("element gone");
      applyOp(s, op);
    });
    log.apply({ op: "setText", node: "g2", from: "Glazed", to: "G" });
    log.apply({ op: "setText", node: "g3", from: "Chocolate", to: "C" });
    log.apply({ op: "setText", node: "g4", from: "Sprinkles", to: "S" });
    broken = true;
    undoAll(log);
    expect(log.canUndo).toBe(false);
    expect(texts(log.scene)).toEqual(["Glazed", "C", "Sprinkles"]);
  });
});

describe("sameEdit", () => {
  it("matches an op with the change it makes: kind, element, style key or note", () => {
    const text: Op = { op: "setText", node: "g2", from: "a", to: "b" };
    const color: Op = { op: "setStyle", node: "g2", key: "color", from: null, to: "red" };
    const note: Op = { op: "comment", node: "g2", id: "c1", text: "bigger" };
    const move: Op = { op: "move", node: "g3", from: { x: 0, y: 0 }, to: { x: 5, y: 0 } };
    const needsAi = [
      { ...move, src: "index.html:3:5" },
      { ...note, label: 'button "a"' },
      { op: "setStyle" as const, node: "g2", key: "padding", from: null, to: "4px" },
    ];
    expect([text, color, note, move].map((op) => needsAi.some((c) => sameEdit(c, op)))).toEqual([false, false, true, true]);
    expect(sameEdit({ op: "comment", node: "g2", id: "c2", text: "x" }, note)).toBe(false);
  });
});
