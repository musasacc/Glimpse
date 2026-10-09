import type { Change, Layout } from "@glimpse/core";

/**
 * Numbered markers for the "after" screenshot of a handoff: an outline around
 * every changed element and a badge with the number its change has in the
 * list the AI gets. Pure geometry, so it is testable without a canvas.
 */

/** A box in the captured view's CSS pixels. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Mark extends ViewRect {
  /** The badge: one number, or several ("2,3") for changes to the same element. */
  label: string;
  /** A box prompt's text, shown inside its (dashed) box. */
  text?: string;
  dashed?: boolean;
}

export interface PlacedMark extends Mark {
  /** The badge's box, kept inside the picture and off the other badges. */
  badge: ViewRect;
}

export const BADGE_H = 18;

/** How wide a badge for `label` is (bold 11px digits are ~7px wide). */
export function badgeWidth(label: string): number {
  return Math.max(BADGE_H, 8 + 7 * label.length);
}

/**
 * One mark per element that changed (its changes' numbers together on one
 * badge), one per box prompt. `toView` turns a change's box into the
 * captured view's pixels (scroll, scale, a mock's frame), or null when it isn't in it.
 */
export function marksFor(changes: readonly Change[], toView: (box: Layout) => ViewRect | null): Mark[] {
  const marks: Mark[] = [];
  const byBox = new Map<string, Mark>();
  for (const c of changes) {
    if (!c.box || c.mark === undefined) continue;
    const r = toView(c.box);
    if (!r) continue;
    if (c.op === "region") {
      marks.push({ ...r, label: String(c.mark), text: c.text, dashed: true });
      continue;
    }
    const key = [r.left, r.top, r.width, r.height].map(Math.round).join(",");
    const same = byBox.get(key);
    if (same) same.label += `,${c.mark}`;
    else {
      const m: Mark = { ...r, label: String(c.mark) };
      byBox.set(key, m);
      marks.push(m);
    }
  }
  return marks;
}

/**
 * Where to draw each mark in a view of `view` size: outlines clipped to the
 * picture (marks entirely outside are dropped), badges on the top-left corner,
 * nudged inside the picture and away from earlier badges.
 */
export function markerLayout(marks: readonly Mark[], view: { width: number; height: number }): PlacedMark[] {
  const out: PlacedMark[] = [];
  for (const m of marks) {
    const right = m.left + m.width;
    const bottom = m.top + m.height;
    if (m.width <= 0 || m.height <= 0 || right <= 0 || bottom <= 0 || m.left >= view.width || m.top >= view.height) continue;
    const left = Math.max(0, m.left);
    const top = Math.max(0, m.top);
    const clipped = { left, top, width: Math.min(view.width, right) - left, height: Math.min(view.height, bottom) - top };
    const w = badgeWidth(m.label);
    const h = BADGE_H;
    const clampX = (x: number) => Math.min(Math.max(0, x), Math.max(0, view.width - w));
    const clampY = (y: number) => Math.min(Math.max(0, y), Math.max(0, view.height - h));
    // Centered on the outline's top-left corner, as on the canvas.
    let badge = { left: clampX(clipped.left - w / 2), top: clampY(clipped.top - h / 2), width: w, height: h };
    for (let i = 0; i < 12; i++) {
      const hit = out.find((o) => intersects(o.badge, badge));
      if (!hit) break;
      // Step right past the badge in the way; at the picture's edge, start a line further down.
      const x = hit.badge.left + hit.badge.width + 2;
      badge = x + w <= view.width ? { ...badge, left: x } : { ...badge, left: clampX(clipped.left - w / 2), top: clampY(hit.badge.top + h + 2) };
    }
    out.push({ ...m, ...clipped, badge });
  }
  return out;
}

/** A page box (CSS px, scroll-independent) in the view of a page scrolled to (`scrollX`, `scrollY`). */
export function pageToView(box: Layout, scroll: { x: number; y: number }): ViewRect {
  return { left: box.x - scroll.x, top: box.y - scroll.y, width: box.w, height: box.h };
}

function intersects(a: ViewRect, b: ViewRect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
