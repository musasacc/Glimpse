import {
  alignDeltas,
  distributeDeltas,
  documentOrder,
  groupOps,
  topLevel,
  ungroupOps,
  type Align,
  type Delta,
  type Layout,
  type Op,
  type Scene,
  type SceneNode,
} from "@glimpse/core";
import { isDrawn } from "./scene-geometry";
import { store } from "./store";

/**
 * Multi-selection editing that needs the live page (or a scene mock): align,
 * distribute, nudge, group/ungroup, marquee hits and box-prompt targets. The
 * structural and geometric work happens in @glimpse/core; this measures the
 * surface and records the resulting ops as one undo step each.
 */

/** A rectangle in the preview's viewport (the overlay uses the same coordinates), or in a scene mock's layout units. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Element box in page coordinates, so it doesn't depend on where the page is scrolled. */
function pageRect(id: string): Layout | null {
  return store.surface?.box(id) ?? null;
}

/** Selected elements that can be moved as a unit: no root, nothing inside another selected element. */
function movable(scene: Scene): string[] {
  return topLevel(scene, store.selection).filter((id) => pageRect(id));
}

/**
 * Move elements by page-space deltas. Layout x/y are relative to the parent,
 * which stays put, so the same delta applies to them. Locked elements count for
 * the bounds but don't move.
 */
function moveBy(scene: Scene, ids: string[], deltas: Delta[]): void {
  const ops: Op[] = [];
  ids.forEach((id, i) => {
    const n = scene.nodes[id]!;
    const { dx, dy } = deltas[i]!;
    if (n.locked || (!dx && !dy)) return;
    const from = { x: n.layout.x, y: n.layout.y };
    ops.push({ op: "move", node: id, from, to: { x: from.x + dx, y: from.y + dy } });
  });
  store.edit(...ops);
}

export function canArrange(): boolean {
  const scene = store.scene;
  return !!scene && movable(scene).length >= 2;
}

/** Line the selected elements up with an edge or the center of their common bounds. */
export function alignSelection(how: Align): void {
  const scene = store.scene;
  if (!scene) return;
  const ids = movable(scene);
  if (ids.length < 2) return;
  moveBy(scene, ids, alignDeltas(ids.map((id) => pageRect(id)!), how));
}

/** Space 3+ selected elements evenly between the outermost two. */
export function distributeSelection(axis: "x" | "y"): void {
  const scene = store.scene;
  if (!scene) return;
  const ids = movable(scene);
  if (ids.length < 3) return;
  moveBy(scene, ids, distributeDeltas(ids.map((id) => pageRect(id)!), axis));
}

/** Arrow keys: move every selected element by the same amount. */
export function nudgeSelection(dx: number, dy: number): void {
  const scene = store.scene;
  if (!scene) return;
  const ids = topLevel(scene, store.selection);
  moveBy(scene, ids, ids.map(() => ({ dx, dy })));
}

/** Why the selection can't be grouped, or null when it can. */
export function groupProblem(): string | null {
  const scene = store.scene;
  const ids = store.selection;
  if (!scene || ids.length === 0) return "Select the elements to group";
  const parent = scene.nodes[ids[0]!]!.parent;
  if (!ids.every((id) => scene.nodes[id]!.parent === parent)) return "Only elements that sit side by side in the same parent can be grouped";
  // A wrapper takes a single cell of a grid, so the grouped elements would collapse into it.
  const el = parent && !store.surface?.positioned ? store.bridge?.el(parent) : undefined;
  if (el && /grid$/.test(el.ownerDocument.defaultView!.getComputedStyle(el).display))
    return "Elements in a grid can't be grouped here: the group would take one cell. Use Point & talk to ask your AI";
  return null;
}

/**
 * Wrap the selected siblings in a new box (MOD+G), placed where the first of
 * them was. In a flex row or column the box copies the parent's flex layout,
 * so the grouped elements stay where they are.
 */
export function groupSelection(): void {
  const scene = store.scene;
  const surface = store.surface;
  const ids = store.selection;
  if (!scene || !surface || ids.length === 0) return;
  const problem = groupProblem();
  if (problem) {
    store.activity("warn", problem);
    return;
  }
  const parent = scene.nodes[ids[0]!]!.parent!;
  const group: SceneNode = {
    id: surface.newId(),
    type: "box",
    ...(!surface.positioned && { tag: "div" }),
    parent,
    children: [],
    layout: unionLayout(ids, parent),
    style: surface.positioned ? {} : flexLike(store.bridge?.el(parent)),
    props: {},
  };
  const ops = groupOps(scene, ids, group);
  if (ops.length === 0) return;
  // A mock places children relative to their parent: keep them where they are on screen.
  if (surface.positioned) ops.push(...shiftOps(scene, ids, -group.layout.x, -group.layout.y));
  store.edit(...ops);
  store.select(group.id);
}

/**
 * A box that can be ungrouped: it has children, isn't the page itself, and has
 * no text of its own. That text would vanish from the page with the box, while
 * the handoff tells the agent to keep everything but the tags.
 */
export function canUngroup(n: SceneNode | undefined): boolean {
  return (
    !!n && n.parent !== null && n.children.length > 0 && (n.type === "box" || n.type === "card" || n.type === "panel") && !n.props.text?.trim()
  );
}

/** Replace the selected box by its children (MOD+Shift+G) and select them. */
export function ungroupSelection(): void {
  const scene = store.scene;
  const id = store.state.selected;
  const n = id ? scene?.nodes[id] : undefined;
  if (!scene || !n) return;
  if (!canUngroup(n)) {
    if (n.props.text?.trim() && n.children.length > 0) store.activity("warn", "This box has text of its own, which ungrouping would drop. Ask the AI instead.");
    return;
  }
  const children = [...n.children];
  const ops = ungroupOps(scene, n.id);
  if (store.surface?.positioned) ops.push(...shiftOps(scene, children, n.layout.x, n.layout.y));
  store.edit(...ops);
  store.selectMany(children);
}

/** Moves that shift nodes by (dx, dy) in their parent's coordinates (they keep their place when the parent changes). */
function shiftOps(scene: Scene, ids: string[], dx: number, dy: number): Op[] {
  if (!dx && !dy) return [];
  return ids.map((id): Op => {
    const { x, y } = scene.nodes[id]!.layout;
    return { op: "move", node: id, from: { x, y }, to: { x: x + dx, y: y + dy } };
  });
}

/** The group's box relative to its parent: the union of the grouped elements. */
function unionLayout(ids: string[], parent: string): Layout {
  const rects = ids.map((id) => pageRect(id)).filter((r): r is Layout => !!r);
  const p = pageRect(parent);
  if (rects.length === 0 || !p) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
  return { x: Math.round(x - p.x), y: Math.round(y - p.y), w: Math.round(w), h: Math.round(h) };
}

function flexLike(parent: Element | undefined): Record<string, string> {
  if (!parent) return {};
  const cs = parent.ownerDocument.defaultView!.getComputedStyle(parent);
  if (!/flex$/.test(cs.display)) return {};
  const style: Record<string, string> = { display: "flex" };
  if (cs.flexDirection !== "row") style["flex-direction"] = cs.flexDirection;
  if (cs.flexWrap !== "nowrap") style["flex-wrap"] = cs.flexWrap;
  if (cs.alignItems !== "normal" && cs.alignItems !== "stretch") style["align-items"] = cs.alignItems;
  if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") style.gap = cs.gap;
  return style;
}

/**
 * Marquee: the elements whose box lies fully inside `rect` (viewport
 * coordinates). The deepest ones win: an element is left out when something
 * inside it is hit too, so dragging over a row of buttons selects the buttons.
 */
export function elementsIn(rect: Rect): string[] {
  return marqueeHits()(rect);
}

/**
 * elementsIn for a whole marquee gesture: every box is measured once, up
 * front, instead of on each pointer move (thousands of layout reads on a big page).
 */
export function marqueeHits(): (rect: Rect) => string[] {
  const scene = store.scene;
  const surface = store.surface;
  if (!scene || !surface) return () => [];
  const boxes: { id: string; r: Rect }[] = [];
  for (const id of Object.keys(scene.nodes)) {
    if (id === scene.rootId || scene.nodes[id]!.hidden || !isDrawn(scene, id)) continue;
    const r = surface.rect(id);
    if (r && r.width > 0 && r.height > 0) boxes.push({ id, r: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }
  return (rect) => {
    const hits = boxes.filter((b) => inside(b.r, rect)).map((b) => b.id);
    const covered = new Set<string>();
    for (const id of hits) {
      for (let p = scene.nodes[id]?.parent ?? null; p !== null; p = scene.nodes[p]?.parent ?? null) covered.add(p);
    }
    return documentOrder(scene, hits.filter((id) => !covered.has(id) && scene.nodes[id]));
  };
}

/**
 * Box prompt target: the deepest element that fully contains `rect` (or the
 * page), and `rect` relative to that element's top-left corner.
 */
export function regionTarget(rect: Rect): { parent: string; rect: Layout } {
  const scene = store.scene!;
  const surface = store.surface!;
  let best = scene.rootId;
  let bestDepth = 0;
  for (const id of Object.keys(scene.nodes)) {
    if (id === scene.rootId || scene.nodes[id]!.hidden || !isDrawn(scene, id)) continue;
    const r = surface.rect(id);
    if (!r || !inside(rect, r)) continue;
    const depth = depthOf(scene, id);
    if (depth > bestDepth) [best, bestDepth] = [id, depth];
  }
  const p = surface.rect(best) ?? { left: 0, top: 0 };
  return {
    parent: best,
    rect: { x: Math.round(rect.left - p.left), y: Math.round(rect.top - p.top), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

/** Where a region op's box is on screen right now (it follows its element). */
export function regionRect(op: Extract<Op, { op: "region" }>): Rect | null {
  const p = store.surface?.rect(op.parent);
  if (!p || !store.scene?.nodes[op.parent]) return null;
  return { left: p.left + op.rect.x, top: p.top + op.rect.y, width: op.rect.w, height: op.rect.h };
}

function inside(inner: Rect, outer: Rect): boolean {
  const eps = 0.5;
  return (
    inner.left >= outer.left - eps &&
    inner.top >= outer.top - eps &&
    inner.left + inner.width <= outer.left + outer.width + eps &&
    inner.top + inner.height <= outer.top + outer.height + eps
  );
}

function depthOf(scene: Scene, id: string): number {
  let d = 0;
  for (let p = scene.nodes[id]?.parent ?? null; p !== null; p = scene.nodes[p]?.parent ?? null) d++;
  return d;
}
