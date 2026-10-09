import { describe, expect, it } from "vitest";
import { createScene, type Scene, type SceneNode } from "@glimpse/core";
import { absBox, hasBorder, placeWidget, selectedTab, shownPane, tagForWidget } from "./scene-geometry";
import { imageUrl } from "./NativeRenderer";
import { cellWidth, fitCells, mix, padCells, tuiColor, wrapCells } from "./tui-colors";

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

  it("gets through wide characters in a one-cell line", () => {
    expect(wrapCells("🔍", 1)).toEqual(["🔍", ""]);
    expect(wrapCells("日本x", 1)).toEqual(["日", "本", "x"]);
  });

  it("measures emoji and combining characters as a terminal draws them", () => {
    expect(cellWidth("🚀")).toBe(2);
    expect(cellWidth("✅ Done")).toBe(7);
    expect(cellWidth("⚡")).toBe(2);
    expect(cellWidth("🫠")).toBe(2);
    expect(cellWidth("☀️")).toBe(2); // text symbol + emoji variation selector
    expect(cellWidth("👩‍💻")).toBe(2); // ZWJ sequence
    expect(cellWidth("👍🏽")).toBe(2); // skin tone
    expect(cellWidth("🇩🇪")).toBe(2);
    expect(cellWidth("é")).toBe(1); // e + combining acute
    expect(cellWidth("│─")).toBe(2);
    expect(fitCells("a👩‍💻b", 3)).toBe("a👩‍💻");
    expect(fitCells("a👩‍💻b", 2)).toBe("a");
  });

  it("pads table cells by cells, not UTF-16 units", () => {
    expect(padCells("日本", 6)).toBe("日本  ");
    expect(padCells("🚀 go", 6)).toBe("🚀 go ");
    expect(cellWidth(padCells("✅", 5))).toBe(5);
  });
});

describe("tabs", () => {
  const tabs = (selected: string | undefined): SceneNode =>
    node("t", "root", { x: 0, y: 0, w: 40, h: 10 }, { type: "tabs", children: ["a", "b"], props: selected === undefined ? {} : { selected } });

  it("clamps the selected tab to the tabs there are", () => {
    expect(shownPane(tabs(undefined))).toBe("a");
    expect(shownPane(tabs("1"))).toBe("b");
    expect(shownPane(tabs("-1"))).toBe("a");
    expect(shownPane(tabs("7"))).toBe("b");
    expect(selectedTab(tabs("7"), 3)).toBe(2);
    expect(selectedTab(tabs("2"), 0)).toBe(0);
  });
});

describe("native image paths", () => {
  it("resolves against the scene's folder and encodes each part", () => {
    expect(imageUrl("logo.png", "")).toBe("/preview/logo.png");
    expect(imageUrl("assets\\my logo#1.png", "ui")).toBe("/preview/ui/assets/my%20logo%231.png");
    expect(imageUrl("../assets/x.png", "ui/mock")).toBe("/preview/ui/assets/x.png");
    expect(imageUrl("/img/a?.png", "ui")).toBe("/preview/img/a%3F.png");
    expect(imageUrl("../../x.png", "ui")).toBeUndefined();
    expect(imageUrl("C:\\pics\\x.png", "")).toBeUndefined();
    expect(imageUrl("https://example.com/x.png", "ui")).toBe("https://example.com/x.png");
    expect(imageUrl("data:image/png;base64,AAAA", "")).toBe("data:image/png;base64,AAAA");
  });
});
