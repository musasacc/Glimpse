import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChangeList, createScene, OpLog, type Scene } from "@glimpse/core";
import { store } from "./store";
import { handleKey } from "./Canvas";

/** One button on a web page or a TUI mock: box prompts go through the store the same way on both. */
let target: "html" | "tui" = "html";
function scene(): Scene {
  const s = createScene(target, { x: 0, y: 0, w: 80, h: 24 });
  s.nodes.ok = { id: "ok", type: "button", parent: "root", children: [], layout: { x: 1, y: 1, w: 10, h: 3 }, style: {}, props: { text: "OK" } };
  s.nodes.root!.children.push("ok");
  return s;
}

// handleKey tells the editor's own document from the page's; a stand-in is enough here (node has no DOM).
(globalThis as { document?: unknown }).document ??= {};

const key = (k: string) => {
  const target = { tagName: "DIV", isContentEditable: false, ownerDocument: null };
  const e = { key: k, target, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; } };
  handleKey(e as unknown as KeyboardEvent, () => {}, "edit");
  return e;
};

const drawBox = (id: string, text: string) => store.edit({ op: "region", id, parent: "root", rect: { x: 2, y: 2, w: 20, h: 5 }, text });
const sentTexts = () => buildChangeList(store.log!).changes.flatMap((c) => (c.op === "region" ? [c.text] : []));

describe.each(["html", "tui"] as const)("box prompts in the editor (%s)", (t) => {
  beforeEach(() => {
    target = t;
  });
  afterEach(() => {
    store.log = null;
    store.set({ selected: null, note: null });
  });

  it("removes the selected box with Delete, leaves the selected element alone, and undo brings it back", () => {
    store.log = new OpLog(scene());
    drawBox("r1", "a search field");
    drawBox("r2", "a logo");
    store.select("ok");
    store.selectNote("r1");
    expect(store.state.note).toBe("r1");
    expect(store.state.multi).toEqual([]);

    expect(key("Delete").prevented).toBe(true);
    expect(store.regions.map((r) => r.id)).toEqual(["r2"]);
    expect(sentTexts()).toEqual(["a logo"]);
    expect(store.scene!.nodes.ok).toBeDefined();
    expect(store.state.note).toBeNull();

    store.undo();
    expect(store.regions.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(sentTexts()).toEqual(["a search field", "a logo"]);
  });

  it("removes a box from its × or menu (removeNote), and Backspace works too", () => {
    store.log = new OpLog(scene());
    drawBox("r1", "a chart");
    store.removeNote("r1");
    expect(store.regions).toEqual([]);
    expect(store.pendingCount).toBe(0);
    store.undo();
    store.selectNote("r1");
    key("Backspace");
    expect(store.regions).toEqual([]);
  });

  it("selecting an element drops the selected box, and undoing a box's drawing deselects it", () => {
    store.log = new OpLog(scene());
    drawBox("r1", "x");
    store.selectNote("r1");
    store.select("ok");
    expect(store.state.note).toBeNull();
    store.selectNote("r1");
    store.undo();
    expect(store.state.note).toBeNull();
    // With no box selected, Delete deletes the selected element as before.
    store.select("ok");
    key("Delete");
    expect(store.scene!.nodes.ok).toBeUndefined();
  });
});
