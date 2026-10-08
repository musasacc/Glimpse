import { describe, expect, it } from "vitest";
import { createScene, type Scene, type SceneNode } from "@glimpse/core";
import { absBox, hasBorder, placeWidget, tagForWidget } from "./scene-geometry";
import { cellWidth, fitCells, mix, tuiColor, wrapCells } from "./tui-colors";

function node(id: string, parent: string, layout: SceneNode["layout"], extra: Partial<SceneNode> = {}): SceneNode {
  return { id, type: "box", parent, children: [], layout, style: {}, props: {}, ...extra };
}

/** An 80×24 screen: a framed panel at (2, 1) holding a button at (1, 1), and a footer. */
function screen(): Scene {
  const s = createScene("tui", { x: 0, y: 0, w: 80, h: 24 });
  s.nodes.panel = node("panel", "root", { x: 2, y: 1, w: 40, h: 12 }, { type: "panel", children: ["ok"] });
  s.nodes.ok = node("ok", "panel", { x: 1, y: 1, w: 10, h: 3 }, { type: "button" });
  s.nodes.footer = node("footer", "root", { x: 0, y: 23, w: 80, h: 1 }, { type: "statusbar" });
  s.nodes.root!.children.push("panel", "footer");
  return s;
}

describe("scene geometry", () => {
  it("adds up parent offsets, not the root's", () => {
    const s = screen();
    s.nodes.root!.layout.x = 5;
    expect(absBox(s, "ok")).toEqual({ x: 3, y: 2, w: 10, h: 3 });
    expect(absBox(s, "root")).toEqual({ x: 0, y: 0, w: 80, h: 24 });
    expect(absBox(s, "missing")).toBeNull();
  });

  it("places a new widget below the selected one, inside the parent's frame", () => {
    const s = screen();
    const n = node("n1", "panel", { x: 0, y: 0, w: 16, h: 3 }, { type: "button" });
    expect(placeWidget(s, n, "panel", "ok", "tui")).toEqual({ x: 1, y: 4, w: 16, h: 3 });
    // Below the lowest child when nothing is selected, and never past the parent's bottom frame.
    expect(placeWidget(s, { ...n, layout: { x: 0, y: 0, w: 16, h: 10 } }, "panel", undefined, "tui")).toEqual({ x: 1, y: 1, w: 16, h: 10 });
  });

  it("spans bars across the parent: menus on top, status bars at the bottom", () => {
    const s = screen();
    expect(placeWidget(s, node("m", "root", { x: 0, y: 0, w: 0, h: 1 }, { type: "menu" }), "root", undefined, "tui")).toEqual({ x: 0, y: 0, w: 80, h: 1 });
    expect(placeWidget(s, node("b", "panel", { x: 0, y: 0, w: 0, h: 1 }, { type: "statusbar" }), "panel", undefined, "tui")).toEqual({ x: 1, y: 10, w: 38, h: 1 });
  });

  it("keeps native widgets clear of the window edge", () => {
    const s = createScene("native", { x: 0, y: 0, w: 640, h: 440 });
    expect(placeWidget(s, node("b", "root", { x: 0, y: 0, w: 88, h: 32 }, { type: "button" }), "root", undefined, "native")).toEqual({ x: 16, y: 16, w: 88, h: 32 });
  });

  it("knows which widgets are framed", () => {
    expect(hasBorder(node("a", "root", { x: 0, y: 0, w: 1, h: 1 }, { type: "panel" }))).toBe(true);
    expect(hasBorder(node("a", "root", { x: 0, y: 0, w: 1, h: 1 }, { type: "panel", style: { border: "none" } }))).toBe(false);
    expect(hasBorder(node("a", "root", { x: 0, y: 0, w: 1, h: 1 }, { style: { border: "round $accent" } }))).toBe(true);
    expect(hasBorder(node("a", "root", { x: 0, y: 0, w: 1, h: 1 }))).toBe(false);
  });

  it("names new widgets after the toolkit's classes", () => {
    expect(tagForWidget("textual", "list")).toBe("ListView");
    expect(tagForWidget("Tkinter", "input")).toBe("ttk.Entry");
    expect(tagForWidget(undefined, "button")).toBeUndefined();
  });
});

describe("terminal colors", () => {
  it("reads ANSI names, Textual variables, hex and opacity", () => {
    expect(tuiColor("$accent")).toBe("#ffa62b");
    expect(tuiColor("bright-black")).toBe(tuiColor("ansi_bright_black"));
    expect(tuiColor("brightred")).toBe(tuiColor("bright-red"));
    expect(tuiColor("#123")).toBe("#123");
    expect(tuiColor("#ffffff 50%", "#000000")).toBe("#808080");
    expect(tuiColor("none")).toBeUndefined();
    expect(tuiColor("grey50")).toBe("#808080");
  });

  it("derives shades and contrast", () => {
    const base = tuiColor("$primary")!;
    expect(tuiColor("$primary-darken-2")).not.toBe(base);
    expect(tuiColor("$primary-lighten-1")).not.toBe(base);
    expect(tuiColor("auto", "#4ebf71")).toBe("#121212");
    expect(tuiColor("auto", "#0178d4")).toBe("#e0e0e0");
    expect(mix("#ffffff", "#000000", 0.25)).toBe("#404040");
  });
});

describe("terminal text", () => {
  it("counts wide characters as two cells", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("日本語")).toBe(6);
    expect(fitCells("日本語", 5)).toBe("日本");
  });

  it("wraps words to the width, keeping line breaks and splitting long words", () => {
    expect(wrapCells("Milk, eggs, bread and coffee beans.", 12)).toEqual(["Milk, eggs,", "bread and", "coffee", "beans."]);
    expect(wrapCells("a\nb", 10)).toEqual(["a", "b"]);
    expect(wrapCells("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
