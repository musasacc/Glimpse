import { deleteOp, formatSource, type Change, type Op, type OpLog, type Scene, type SceneNode } from "@glimpse/core";

/**
 * React projects: the preview is the app running on the project's own Vite,
 * plus a small client (from @glimpse/react) that tells the editor when React
 * has rendered and when an HMR update comes:
 *
 *   window.__glimpsePreview  { engine: "vite", ready, updating }
 *   "glimpse:ready"          event: the first render has settled (also posted as { glimpse: "ready" })
 *   "glimpse:before-update"  event, fired synchronously right before Vite applies an update
 *   "glimpse:after-update"   event: the update was applied and the DOM has settled
 *                            (then { glimpse: "morphed" } is posted, as the HTML live client does)
 *
 * React diffs against its own record of the DOM, not the DOM itself, so the
 * editor's edits have to be off the page while it updates (Store.beforeUpdate).
 */

interface PreviewState {
  engine?: string;
  ready?: boolean;
}

function previewState(doc: Document | null | undefined): PreviewState | undefined {
  return (doc?.defaultView as (Window & { __glimpsePreview?: PreviewState }) | null | undefined)?.__glimpsePreview;
}

/** The page is a React app served by Vite (not a static HTML page). */
export function isVitePage(doc: Document | null | undefined): boolean {
  return previewState(doc)?.engine === "vite";
}

/**
 * Call `fn` once the page can be read: now for a loaded HTML page, after its
 * first render has settled for a React one (the client stops waiting for a
 * quiet DOM after 3 s; we wait a little longer, in case its event never comes).
 */
export function whenRendered(doc: Document, fn: () => void): void {
  const state = previewState(doc);
  const win = doc.defaultView;
  if (state?.engine !== "vite" || state.ready || !win) return fn();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    win.removeEventListener("glimpse:ready", run);
    fn();
  };
  const timer = setTimeout(run, 4000);
  win.addEventListener("glimpse:ready", run);
}

/** Listen for a React page's HMR updates; for other pages the events never come. */
export function watchUpdates(doc: Document, on: { before: () => void; after: () => void }): void {
  const win = doc.defaultView;
  win?.addEventListener("glimpse:before-update", on.before);
  win?.addEventListener("glimpse:after-update", on.after);
}

/** Undo every step of a log, as far as the page still allows (a step whose element is gone is skipped). */
export function undoAll(log: OpLog): void {
  for (;;) {
    try {
      if (!log.undo()) return;
    } catch {
      // That step can't come off (undo is all or nothing, so it is still fully on): drop it from the
      // log and carry on with the ones before it.
      log.dropLast();
    }
  }
}

/**
 * Source locations ("file:line:col") the page renders more than once, with how
 * often: list items and components used in several places. Writing an edit of
 * one of them into the source would change every copy, so those go to the AI.
 * Each scene counts on its own (the page as rendered, before the edits).
 */
export function repeatedSources(scenes: Scene[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const scene of scenes) {
    const counts = new Map<string, number>();
    for (const n of Object.values(scene.nodes)) {
      const src = formatSource(n.source);
      if (src) counts.set(src, (counts.get(src) ?? 0) + 1);
    }
    for (const [src, n] of counts) if (n > 1 && n > (out.get(src) ?? 0)) out.set(src, n);
  }
  return out;
}

/**
 * React reuses DOM elements by position: when the source gains a button before
 * three others, each of them now shows its predecessor's content and the last
 * one is new. Edits are tied to DOM elements, so after an update work out where
 * each element went: line up the children of each element before and after by
 * what they look like (tag, attributes, text, file, and the same of everything
 * inside), in order. One that matches nothing is the same DOM node with what
 * the update changed in it, unless the update gave that node to another
 * element: then it is gone.
 * Returns old id → new id for the elements that moved, and "" for those gone.
 */
export function followMoves(before: Scene, after: Scene): Map<string, string> {
  const moved = new Map<string, string>();
  const was = signatures(before);
  const now = signatures(after);
  const align = (from: string, to: string) => {
    const old = before.nodes[from]?.children ?? [];
    const cur = after.nodes[to]?.children ?? [];
    const pairs = lineUp(old.map((id) => was.get(id)!), cur.map((id) => now.get(id)!));
    const matched = new Set(pairs.map(([i]) => old[i]!));
    const taken = new Set(pairs.map(([, j]) => cur[j]!));
    for (const [i, j] of pairs) {
      if (old[i] !== cur[j]) moved.set(old[i]!, cur[j]!);
      align(old[i]!, cur[j]!);
    }
    for (const id of old) {
      if (matched.has(id)) continue;
      if (taken.has(id)) moved.set(id, "");
      else if (after.nodes[id]?.parent === to) align(id, id);
    }
  };
  align(before.rootId, after.rootId);
  return moved;
}

/**
 * Point ops at the elements they were made on after followMoves. A delete is
 * taken anew from `scene` (the page as it is when the op is replayed), so it
 * removes, and on undo brings back, the element's current subtree. Throws when
 * an op's element is gone.
 */
export function followOps(ops: Op[], moved: Map<string, string>, scene: Scene): Op[] {
  if (moved.size === 0) return ops;
  const id = (x: string) => {
    const to = moved.get(x);
    if (to === "") throw new Error(`The element ${x} is gone`);
    return to ?? x;
  };
  return ops.map((op): Op => {
    switch (op.op) {
      case "reorder":
        return { ...op, node: id(op.node), from: { ...op.from, parent: id(op.from.parent) }, to: { ...op.to, parent: id(op.to.parent) } };
      case "add":
      case "region":
        return { ...op, parent: id(op.parent) };
      case "delete": {
        const top = id(op.nodes[0]!.id);
        return top === op.nodes[0]!.id ? op : deleteOp(scene, top);
      }
      default:
        return { ...op, node: id(op.node) };
    }
  });
}

/** What each element looks like, everything inside it included, as a short hash. */
function signatures(scene: Scene): Map<string, string> {
  const out = new Map<string, string>();
  const sig = (n: SceneNode): string => {
    const props = Object.entries(n.props).sort(([a], [b]) => (a < b ? -1 : 1));
    const inner = n.children.map((c) => (scene.nodes[c] ? sig(scene.nodes[c]) : ""));
    const s = hash(JSON.stringify([n.tag, n.source?.file, props, inner]));
    out.set(n.id, s);
    return s;
  };
  sig(scene.nodes[scene.rootId]!);
  return out;
}

/**
 * The longest run of equal items two lists have in common, in order, as index
 * pairs (a longest common subsequence). Lists too long to compare whole only
 * match at their common start and end.
 */
function lineUp(a: string[], b: string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= 1_000_000) {
    // lcs[i * w + j]: length of the longest common subsequence of a[start + i..endA) and b[start + j..endB).
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[start + i] === b[start + j]) pairs.push([start + i++, start + j++]);
      else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** cyrb53: a fast 53-bit string hash (collisions only cost a slightly worse guess). */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The op is (part of) the edit a change describes: same kind, same element (or same note). */
export function sameEdit(c: Change, op: Op): boolean {
  if (c.op !== op.op) return false;
  if ("id" in op) return "id" in c && c.id === op.id;
  if ("node" in op) return "node" in c && c.node === op.node && (!("key" in op) || ("key" in c && c.key === op.key));
  return "nodes" in c && c.nodes[0]?.id === op.nodes[0]?.id;
}
