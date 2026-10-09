import { describe, expect, it } from "vitest";
import type { Change } from "@glimpse/core";
import { BADGE_H, badgeWidth, markerLayout, marksFor, pageToView } from "./markers";

const text = (mark: number, box: Change["box"]): Change => ({ op: "setText", node: "a", from: "", to: "x", mark, ...(box && { box }) });

describe("screenshot markers", () => {
  it("turns page boxes into the scrolled view and merges changes to one element", () => {
    const changes: Change[] = [
      text(1, { x: 20, y: 500, w: 100, h: 40 }),
      { op: "setStyle", node: "a", key: "color", from: null, to: "red", mark: 2, box: { x: 20, y: 500, w: 100, h: 40 } },
      { op: "region", id: "r", parent: "root", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "a logo", mark: 3, box: { x: 300, y: 450, w: 200, h: 80 } },
      text(4, undefined), // no box (not shown): no marker
      { ...text(5, { x: 0, y: 0, w: 10, h: 10 }), mark: undefined }, // not numbered: no marker
    ];
    const marks = marksFor(changes, (b) => pageToView(b, { x: 0, y: 400 }));
    expect(marks).toEqual([
      { left: 20, top: 100, width: 100, height: 40, label: "1,2" },
      { left: 300, top: 50, width: 200, height: 80, label: "3", text: "a logo", dashed: true },
    ]);
  });

  it("clips outlines to the picture, drops marks outside it and keeps badges inside", () => {
    const view = { width: 800, height: 600 };
    const placed = markerLayout(
      [
        { left: -50, top: 590, width: 100, height: 40, label: "1" }, // hangs off the bottom-left corner
        { left: 100, top: 700, width: 50, height: 50, label: "2" }, // below the fold
        { left: 780, top: 0, width: 100, height: 30, label: "10,11" }, // off the right edge
      ],
      view,
    );
    expect(placed.map((p) => p.label)).toEqual(["1", "10,11"]);
    expect(placed[0]).toMatchObject({ left: 0, top: 590, width: 50, height: 10 });
    expect(placed[0]!.badge).toEqual({ left: 0, top: 590 - BADGE_H / 2, width: BADGE_H, height: BADGE_H });
    const wide = badgeWidth("10,11");
    expect(wide).toBe(8 + 7 * 5);
    expect(placed[1]).toMatchObject({ left: 780, top: 0, width: 20, height: 30 });
    expect(placed[1]!.badge).toEqual({ left: 800 - wide, top: 0, width: wide, height: BADGE_H });
  });

  it("moves a badge off another one at the same corner", () => {
    const placed = markerLayout(
      [
        { left: 100, top: 100, width: 200, height: 50, label: "1" },
        { left: 100, top: 100, width: 80, height: 20, label: "2", text: "x", dashed: true },
        { left: 102, top: 101, width: 10, height: 10, label: "3" },
      ],
      { width: 1280, height: 800 },
    );
    const [a, b, c] = placed.map((p) => p.badge);
    expect(a).toEqual({ left: 91, top: 91, width: 18, height: 18 });
    expect(b).toEqual({ left: 111, top: 91, width: 18, height: 18 });
    expect(c!.left).toBe(131);
    // Near the right edge the next badge goes a line further down instead.
    const edge = markerLayout(
      [
        { left: 790, top: 10, width: 10, height: 10, label: "1" },
        { left: 790, top: 10, width: 10, height: 10, label: "2" },
      ],
      { width: 800, height: 600 },
    );
    expect(edge[1]!.badge).toEqual({ left: 781, top: edge[0]!.badge.top + BADGE_H + 2, width: 18, height: 18 });
  });
});
