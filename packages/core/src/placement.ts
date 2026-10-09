import { describeNode } from "./changes.js";
import type { Layout, Scene, SceneNode } from "./scene.js";

/**
 * Where an element is on screen, in words the AI can act on: its box, the
 * nearest elements around it, how it lines up with them, and its slot in a
 * row or grid. Boxes are absolute (page coordinates for the web, cells or
 * pixels from the top-left of a mock).
 */

/** A node's absolute box, or null when it isn't shown. */
export type Measure = (id: string) => Layout | null | undefined;

/** A node's box from the scene's own layouts (relative to the parent, summed up to the root). */
export function sceneBox(scene: Scene, id: string): Layout | null {
  const n = scene.nodes[id];
  if (!n) return null;
  let x = 0;
  let y = 0;
  for (let p: SceneNode | undefined = n; p && p.parent !== null; p = scene.nodes[p.parent]) {
    if (p.hidden) return null;
    x += p.layout.x;
    y += p.layout.y;
  }
  return { x, y, w: n.layout.w, h: n.layout.h };
}

/** Caches `measure` (the editor's measures the live page) and drops hidden or empty boxes. */
export function boxes(scene: Scene, measure?: Measure): (id: string) => Layout | null {
  const cache = new Map<string, Layout | null>();
  return (id) => {
    if (!cache.has(id)) {
      const n = scene.nodes[id];
      const b = !n || n.hidden ? null : ((measure ? measure(id) : sceneBox(scene, id)) ?? null);
      cache.set(id, b && b.w > 0 && b.h > 0 ? round(b) : null);
    }
    return cache.get(id)!;
  };
}

export interface PlaceOptions {
  /** The element's own id (it and its subtree are never its own neighbours). */
  self?: string;
  /** The container whose children are the first candidates (then its siblings, and so on up). */
  within: string;
  /** Say which container it is in (for box prompts and comments; adds name their parent already). */
  sayInside?: boolean;
}

/** "at x 24, y 180 (120×40px); below …, above …, left-aligned with them; 3rd of 4 buttons in a row". */
export function describePlace(scene: Scene, box: Layout, boxOf: (id: string) => Layout | null, opts: PlaceOptions): string {
  const tui = scene.target === "tui";
  const tol = tui ? 0 : 4;
  const parts = [tui ? `at column ${box.x}, row ${box.y} (${box.w}×${box.h} cells)` : `at x ${box.x}, y ${box.y} (${box.w}×${box.h}px)`];
  const skip = new Set<string>(opts.self ? subtree(scene, opts.self) : []);

  // Nearest neighbour in each direction: the container's children first, then one level up at a time.
  type Dir = "above" | "below" | "left" | "right";
  const found: Partial<Record<Dir, SceneNode>> = {};
  const over: SceneNode[] = [];
  let container: SceneNode | undefined = scene.nodes[opts.within];
  for (let level = 0; container && level < 3; level++) {
    const nearest: Partial<Record<Dir, { n: SceneNode; gap: number }>> = {};
    const consider = (dir: Dir, n: SceneNode, gap: number) => {
      if (gap >= -tol && (!nearest[dir] || gap < nearest[dir]!.gap)) nearest[dir] = { n, gap };
    };
    for (const id of container.children) {
      const n = scene.nodes[id];
      const c = boxOf(id);
      // Further out, an element around this one is a container (a wrapper, a backdrop), not a neighbour.
      if (!n || skip.has(id) || !c || (level > 0 && contains(c, box, tol))) continue;
      // Elements it covers (a box prompt drawn over them, an element dragged on top of another).
      if (level === 0 && overlap(c.x, c.w, box.x, box.w) > tol && overlap(c.y, c.h, box.y, box.h) > tol) {
        over.push(n);
        continue;
      }
      if (overlap(c.x, c.w, box.x, box.w) > 0) {
        consider("above", n, box.y - (c.y + c.h));
        consider("below", n, c.y - (box.y + box.h));
      }
      if (overlap(c.y, c.h, box.y, box.h) > 0) {
        consider("left", n, box.x - (c.x + c.w));
        consider("right", n, c.x - (box.x + box.w));
      }
    }
    for (const dir of Object.keys(nearest) as Dir[]) found[dir] ??= nearest[dir]!.n;
    if (found.above && found.below && found.left && found.right) break;
    skip.add(container.id);
    container = container.parent !== null ? scene.nodes[container.parent] : undefined;
  }

  const name = (n: SceneNode) => describeNode(n);
  const vertical = [found.above && `below ${name(found.above)}`, found.below && `above ${name(found.below)}`].filter(Boolean).join(" and ");
  const horizontal = [found.left && `right of ${name(found.left)}`, found.right && `left of ${name(found.right)}`].filter(Boolean).join(" and ");
  const near = [vertical, horizontal].filter(Boolean);
  const align = alignment(box, [found.above, found.below].filter(isNode).map((n) => boxOf(n.id)!), [found.left, found.right].filter(isNode).map((n) => boxOf(n.id)!), tol);
  if (over.length) near.unshift(`${opts.self ? "overlapping" : "over"} ${over.slice(0, 2).map(name).join(" and ")}${over.length > 2 ? ` and ${over.length - 2} more` : ""}`);
  if (near.length) parts.push([...near, ...align].join(", "));
  if (opts.sayInside) {
    const p = scene.nodes[opts.within];
    if (p) parts.push(`inside ${name(p)}${p.source ? ` (${p.source.file}:${p.source.line}:${p.source.col})` : ""}`);
  }
  if (opts.self) {
    const slot = rowSlot(scene, opts.self, box, boxOf);
    if (slot) parts.push(slot);
  }
  return parts.join("; ");
}

/** "left-aligned with it", "top-aligned with them", … for the neighbours above/below and left/right. */
function alignment(box: Layout, stacked: Layout[], beside: Layout[], tol: number): string[] {
  const out: string[] = [];
  const them = (n: number) => (n === 1 ? "it" : "them");
  const all = (list: Layout[], f: (b: Layout) => number) => list.length > 0 && list.every((b) => Math.abs(f(b) - f(box)) <= tol);
  if (all(stacked, (b) => b.x)) out.push(`left-aligned with ${them(stacked.length)}`);
  else if (all(stacked, (b) => b.x + b.w / 2)) out.push(`centered with ${them(stacked.length)}`);
  else if (all(stacked, (b) => b.x + b.w)) out.push(`right-aligned with ${them(stacked.length)}`);
  if (all(beside, (b) => b.y)) out.push(`top-aligned with ${them(beside.length)}`);
  else if (all(beside, (b) => b.y + b.h / 2)) out.push(`vertically centered with ${them(beside.length)}`);
  return out;
}

const ORDINAL = ["1st", "2nd", "3rd"];
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;

/** "3rd of 4 buttons in a row", or "row 2, column 3 of a grid of cards", among the element's siblings. */
function rowSlot(scene: Scene, id: string, box: Layout, boxOf: (id: string) => Layout | null): string {
  const n = scene.nodes[id];
  if (!n || n.parent === null) return "";
  const items = scene.nodes[n.parent]!.children.flatMap((c) => {
    const b = c === id ? box : boxOf(c);
    return b ? [{ id: c, b }] : [];
  });
  // Bands of siblings that share a horizontal line, top to bottom.
  const rows: { id: string; b: Layout }[][] = [];
  for (const it of [...items].sort((a, b) => a.b.y - b.b.y)) {
    const row = rows.find((r) => r.some((o) => overlap(o.b.y, o.b.h, it.b.y, it.b.h) >= Math.min(o.b.h, it.b.h) / 2));
    if (row) row.push(it);
    else rows.push([it]);
  }
  const r = rows.findIndex((row) => row.some((it) => it.id === id));
  const row = rows[r]!.sort((a, b) => a.b.x - b.b.x);
  if (row.length < 2 || row.some((a, i) => i > 0 && a.b.x < row[i - 1]!.b.x + row[i - 1]!.b.w - 4)) return "";
  const col = row.findIndex((it) => it.id === id) + 1;
  const types = new Set(row.map((it) => scene.nodes[it.id]!.type));
  const kind = types.size === 1 ? plural([...types][0]!) : "items";
  const multi = rows.filter((x) => x.length >= 2);
  if (multi.length >= 2) return `row ${r + 1}, column ${col} of a grid of ${kind}`;
  return `${ordinal(col)} of ${row.length} ${kind} in a row`;
}

function plural(type: string): string {
  if (type === "text" || type === "label") return "texts";
  if (type === "box") return "boxes";
  return `${type}s`;
}

function subtree(scene: Scene, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    out.push(x);
    for (const c of scene.nodes[x]?.children ?? []) walk(c);
  };
  walk(id);
  return out;
}

function isNode(n: SceneNode | undefined): n is SceneNode {
  return !!n;
}

function overlap(a: number, aw: number, b: number, bw: number): number {
  return Math.min(a + aw, b + bw) - Math.max(a, b);
}

/** `outer` wraps `inner` (a container around the element is not its neighbour). */
function contains(outer: Layout, inner: Layout, tol: number): boolean {
  return outer.x <= inner.x + tol && outer.y <= inner.y + tol && outer.x + outer.w >= inner.x + inner.w - tol && outer.y + outer.h >= inner.y + inner.h - tol;
}

function round(b: Layout): Layout {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}
