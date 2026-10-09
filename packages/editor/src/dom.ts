import { applyOp, createScene, invertOp, type SourceLocation, type NodeType, type Op, type Scene, type SceneNode } from "@glimpse/core";

/**
 * Bridge between the live preview DOM (same-origin iframe) and the Glimpse scene.
 * Ids are kept in a WeakMap rather than DOM attributes so live morphs from the
 * AI's edits never strip them.
 */
export class DomBridge {
  private ids = new WeakMap<Element, string>();
  private els = new Map<string, Element>();
  /** Where each element was originally laid out, so moves can be shown as translates. */
  private origins = new Map<string, { x: number; y: number }>();
  /**
   * What the page itself had before the editor first changed an element: its text nodes, inline sizes and
   * styles. Undoing back to the start puts exactly that back, since React keeps references to those nodes
   * and only rewrites what its own props changed (it never repairs what the editor left behind).
   */
  private pristine = new WeakMap<Element, Pristine>();
  /** The translate the editor set on an element for a move, to measure where the page itself laid it out. */
  private moved = new WeakMap<Element, { translate: string; dx: number; dy: number }>();
  /**
   * Where reorders and deletes took elements from, newest last, so undoing puts
   * them back exactly: between the same text and untracked nodes, which the
   * scene doesn't know about ("Total: <b>$20</b> per month").
   */
  private spots = new WeakMap<Element, { parent: Node; next: Node | null }[]>();
  private next = 1;

  constructor(readonly doc: Document) {}

  idOf(el: Element): string | undefined {
    return this.ids.get(el);
  }

  el(id: string): Element | undefined {
    return this.els.get(id);
  }

  newId(): string {
    return `g${this.next++}`;
  }

  /** Walk the page and build a scene that mirrors it. */
  buildScene(): Scene {
    // A new op log starts from this scene; nothing before it can be undone.
    this.spots = new WeakMap();
    const body = this.doc.body;
    const scene = createScene("html", { x: 0, y: 0, w: body.scrollWidth, h: body.scrollHeight });
    this.register(body, "root");
    const bodySrc = parseSrc(body.getAttribute(SRC_ATTR));
    if (bodySrc) scene.nodes.root!.source = bodySrc;
    // Each element's box is measured once and reused as its children's parent box.
    const walk = (el: Element, parentId: string, prect: DOMRect) => {
      for (const child of Array.from(el.children)) {
        if (!isEditable(child)) continue;
        const id = this.ids.get(child) ?? this.newId();
        this.register(child, id);
        const rect = child.getBoundingClientRect();
        scene.nodes[id] = this.snapshot(child, id, parentId, rect, prect);
        // A moved element is measured with the editor's translate in it; its origin is where it was without.
        const m = this.moved.get(child);
        const off = m && (child as HTMLElement).style.translate === m.translate ? m : { dx: 0, dy: 0 };
        this.origins.set(id, { x: scene.nodes[id]!.layout.x - off.dx, y: scene.nodes[id]!.layout.y - off.dy });
        scene.nodes[parentId]!.children.push(id);
        // An inline <svg> is one picture: its paths and groups aren't layers of their own.
        if (!isSvgRoot(child)) walk(child, id, rect);
      }
    };
    walk(body, "root", body.getBoundingClientRect());
    return scene;
  }

  snapshot(
    el: Element,
    id: string,
    parent: string | null,
    rect: DOMRect = el.getBoundingClientRect(),
    prect: { left: number; top: number } = el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 },
  ): SceneNode {
    const html = el as HTMLElement;
    const style: Record<string, string> = {};
    for (let i = 0; i < html.style.length; i++) {
      const key = html.style.item(i);
      style[key] = html.style.getPropertyValue(key);
    }
    const props: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name !== "style" && attr.name !== SRC_ATTR) props[attr.name] = attr.value;
    }
    const text = ownText(el);
    if (text) props.text = text;
    const source = parseSrc(el.getAttribute(SRC_ATTR));
    return {
      id,
      type: nodeType(el),
      tag: el.tagName.toLowerCase(),
      parent,
      children: [],
      layout: { x: Math.round(rect.left - prect.left), y: Math.round(rect.top - prect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      style,
      props,
      ...(source ? { source } : {}),
    };
  }

  /** Show an in-progress drag without recording an op. */
  previewMove(id: string, to: { x: number; y: number }): void {
    const el = this.els.get(id) as HTMLElement | undefined;
    const origin = this.origins.get(id);
    if (!el || !origin) return;
    const dx = to.x - origin.x;
    const dy = to.y - origin.y;
    el.style.translate = dx || dy ? `${dx}px ${dy}px` : "";
    tidyStyle(el);
  }

  /** Nearest registered element at or above `target` (what a click in the page selects). */
  pick(target: EventTarget | null): string | undefined {
    // The page lives in another realm (the iframe), so avoid `instanceof Element`.
    const node = target as Node | null;
    let el: Element | null = node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    while (el && el !== this.doc.documentElement) {
      const id = this.ids.get(el);
      if (id && el !== this.doc.body) return id;
      el = el.parentElement;
    }
    return undefined;
  }

  /** The element's box in the page's viewport, or null when it is not on the page. */
  rect(id: string): DOMRect | null {
    const el = this.els.get(id);
    return el?.isConnected ? el.getBoundingClientRect() : null;
  }

  /**
   * Apply an op to the scene and the live DOM. Used as the OpLog applier
   * (`undo`: the op is the inverse of an earlier one). The scene goes first
   * because it rejects ops that don't fit (e.g. replayed after the AI changed
   * the page) before the DOM is touched.
   */
  apply(scene: Scene, op: Op, undo = false): void {
    applyOp(scene, op);
    try {
      this.applyDom(scene, op, undo);
    } catch (err) {
      applyOp(scene, invertOp(op));
      throw err;
    }
  }

  /** Mirror an op in the DOM. `scene` already has the op applied. */
  private applyDom(scene: Scene, op: Op, undo: boolean): void {
    switch (op.op) {
      case "move": {
        // Moves are previewed as a translate relative to where the page laid the element out.
        const el = this.els.get(op.node) as HTMLElement;
        const origin = this.origins.get(op.node) ?? op.from;
        const dx = op.to.x - origin.x;
        const dy = op.to.y - origin.y;
        el.style.translate = dx || dy ? `${dx}px ${dy}px` : "";
        tidyStyle(el);
        if (dx || dy) this.moved.set(el, { translate: el.style.translate, dx, dy });
        else this.moved.delete(el);
        return;
      }
      case "resize": {
        const el = this.els.get(op.node) as HTMLElement;
        const p = this.pristineOf(el);
        p.size ??= { width: el.style.width, height: el.style.height, w: op.from.w, h: op.from.h };
        if (op.to.w === p.size.w && op.to.h === p.size.h) {
          // Back to the size it had (an undo): the page's own inline sizes (usually none), not fixed pixels,
          // which would stop it following its content and the window.
          el.style.width = p.size.width;
          el.style.height = p.size.height;
          delete p.size;
        } else {
          const size = cssSize(el, op.to.w, op.to.h);
          el.style.width = size.width;
          el.style.height = size.height;
        }
        tidyStyle(el);
        return;
      }
      case "setText":
        this.setText(this.els.get(op.node)!, op.to);
        return;
      case "setStyle": {
        const el = this.els.get(op.node) as HTMLElement;
        const p = this.pristineOf(el);
        p.style ??= new Map();
        if (!p.style.has(op.key)) p.style.set(op.key, { value: el.style.getPropertyValue(op.key), priority: el.style.getPropertyPriority(op.key) });
        const was = p.style.get(op.key)!;
        if (op.to !== null) el.style.setProperty(op.key, op.to);
        else if (was.value) {
          // Removing a style the scene doesn't list (a shorthand like padding, set inline as its longhands)
          // puts back what the page had rather than wiping those longhands.
          el.style.setProperty(op.key, was.value, was.priority);
          p.style.delete(op.key);
        } else {
          el.style.removeProperty(op.key);
          p.style.delete(op.key);
        }
        tidyStyle(el);
        return;
      }
      case "setProp": {
        const el = this.els.get(op.node)!;
        if (op.to === null) el.removeAttribute(op.key);
        else el.setAttribute(op.key, op.to);
        return;
      }
      case "setHidden": {
        const el = this.els.get(op.node) as HTMLElement;
        el.style.visibility = op.to ? "hidden" : "";
        tidyStyle(el);
        return;
      }
      case "reorder": {
        const el = this.els.get(op.node)!;
        if (undo && this.restoreSpot(el, scene, op.to.parent, op.to.index, op.node)) return;
        const spot = { parent: el.parentNode, next: el.nextSibling };
        this.insertAt(el, scene, op.to.parent, op.to.index, op.node);
        if (!undo && spot.parent) this.pushSpot(el, { parent: spot.parent, next: spot.next });
        return;
      }
      case "add": {
        const top = op.nodes[0]!;
        // Undoing a delete (or an ungroup) brings back the original element, with
        // its text and anything Glimpse doesn't track inside it, where it was.
        const el = this.els.get(top.id) ?? this.create(op.nodes, top.id);
        if (!(undo && this.restoreSpot(el, scene, op.parent, op.index, top.id))) this.insertAt(el, scene, op.parent, op.index, top.id);
        // Later moves of new elements are translates relative to where they were added.
        for (const n of op.nodes) if (!this.origins.has(n.id)) this.origins.set(n.id, { x: n.layout.x, y: n.layout.y });
        return;
      }
      case "delete": {
        const el = this.els.get(op.nodes[0]!.id);
        if (el?.parentNode && !undo) this.pushSpot(el, { parent: el.parentNode, next: el.nextSibling });
        el?.remove();
        return;
      }
      default:
        return; // swapType, setLocked and annotations are editor-only until handed off
    }
  }

  private pristineOf(el: Element): Pristine {
    let p = this.pristine.get(el);
    if (!p) this.pristine.set(el, (p = {}));
    return p;
  }

  /**
   * Set the element's own text. The first edit remembers every text node as the page left it (React renders
   * `Clicked {count}` as "Clicked " + "0"); setting the original text again restores each node's value.
   */
  private setText(el: Element, text: string): void {
    const p = this.pristineOf(el);
    const own = Array.from(el.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE);
    if (!p.text) p.text = { nodes: own, values: own.map((n) => n.nodeValue ?? ""), text: ownText(el) };
    const saved = p.text;
    if (text === saved.text && saved.nodes.every((n) => n.parentNode === el)) {
      saved.nodes.forEach((n, i) => (n.nodeValue = saved.values[i]!));
      if (saved.added && !saved.nodes.includes(saved.added)) saved.added.remove();
      delete p.text;
      return;
    }
    const texts = own.filter((n) => n.nodeValue?.trim());
    if (texts.length === 0) {
      if (saved.added?.parentNode === el) saved.added.nodeValue = text;
      else el.insertBefore((saved.added = el.ownerDocument.createTextNode(text)), el.firstChild);
      return;
    }
    texts[0]!.nodeValue = text;
    for (const extra of texts.slice(1)) extra.nodeValue = "";
  }

  /** Create DOM for added nodes (palette or duplicate) and register their ids. */
  private create(nodes: SceneNode[], id: string): Element {
    const n = nodes.find((x) => x.id === id)!;
    const el = this.doc.createElement(n.tag ?? tagFor(n.type));
    for (const [k, v] of Object.entries(n.props)) if (k !== "text") el.setAttribute(k, v);
    for (const [k, v] of Object.entries(n.style)) (el as HTMLElement).style.setProperty(k, v);
    if (n.props.text) el.append(n.props.text);
    for (const c of n.children) el.append(this.create(nodes, c));
    this.register(el, id);
    return el;
  }

  /**
   * Insert `el` (scene node `movingId`) so it becomes child number `index` of
   * scene node `parentId`. Its neighbours are its siblings other than itself, so
   * this works whether or not the scene already has it at its new place.
   */
  private insertAt(el: Element, scene: Scene, parentId: string, index: number, movingId: string): void {
    const siblings = scene.nodes[parentId]!.children.filter((c) => c !== movingId);
    const before = siblings[index] ? (this.els.get(siblings[index]!) ?? null) : null;
    this.els.get(parentId)!.insertBefore(el, before);
  }

  private pushSpot(el: Element, spot: { parent: Node; next: Node | null }): void {
    const stack = this.spots.get(el);
    if (stack) stack.push(spot);
    else this.spots.set(el, [spot]);
  }

  /**
   * Undo: put `el` back where the reorder or delete being undone took it from,
   * if that place is still there and agrees with the scene (its tracked
   * neighbours are the scene's). False when the caller should place it by the
   * scene alone.
   */
  private restoreSpot(el: Element, scene: Scene, parentId: string, index: number, movingId: string): boolean {
    const spot = this.spots.get(el)?.pop();
    const parent = this.els.get(parentId);
    if (!spot || !parent || spot.parent !== parent || (spot.next && spot.next.parentNode !== parent)) return false;
    parent.insertBefore(el, spot.next);
    const siblings = scene.nodes[parentId]!.children.filter((c) => c !== movingId);
    const prev = index > 0 ? (this.els.get(siblings[index - 1]!) ?? null) : null;
    const next = index < siblings.length ? (this.els.get(siblings[index]!) ?? null) : null;
    return this.tracked(el, "previousElementSibling") === prev && this.tracked(el, "nextElementSibling") === next;
  }

  /** The nearest element sibling the scene tracks, in one direction. */
  private tracked(el: Element, dir: "previousElementSibling" | "nextElementSibling"): Element | null {
    let s = el[dir];
    while (s && !(this.ids.has(s) && isEditable(s))) s = s[dir];
    return s;
  }

  private register(el: Element, id: string): void {
    this.ids.set(el, id);
    this.els.set(id, el);
    // Never hand out an id that is already in use (e.g. replayed after a reload).
    const n = /^g(\d+)$/.exec(id);
    if (n && Number(n[1]) >= this.next) this.next = Number(n[1]) + 1;
  }
}

/** Added by the Glimpse server: where the element lives in source ("file:line:col"). */
export const SRC_ATTR = "data-glimpse-src";

function parseSrc(value: string | null): SourceLocation | undefined {
  const m = value ? /^(.*):(\d+):(\d+)$/.exec(value) : null;
  return m ? { file: m[1]!, line: Number(m[2]), col: Number(m[3]) } : undefined;
}

const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "BR"]);

function isEditable(el: Element): boolean {
  return !SKIP.has(el.tagName) && !el.hasAttribute("data-glimpse-internal");
}

function isSvgRoot(el: Element): boolean {
  return el.localName === "svg";
}

function nodeType(el: Element): NodeType {
  // Elements of an HTML page report upper-case tag names, but SVG ones (an inline <svg>) lower-case.
  switch (el.tagName.toUpperCase()) {
    case "BUTTON":
      return "button";
    case "A":
      return "link";
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
      return "input";
    case "IMG":
    case "SVG":
    case "CANVAS":
    case "VIDEO":
      return "image";
    case "UL":
    case "OL":
      return "list";
    case "NAV":
      return "nav";
    case "P":
    case "SPAN":
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
    case "LABEL":
    case "LI":
      return "text";
    default:
      return "box";
  }
}

export function tagFor(type: NodeType): string {
  return { button: "button", text: "p", input: "input", image: "img", link: "a", list: "ul", nav: "nav", card: "div", box: "div" }[
    type as string
  ] ?? "div";
}

/**
 * CSS width and height that give `el` a box of w×h on screen. Layouts are border boxes (getBoundingClientRect),
 * but a content-box element's width and height leave out its padding and border.
 */
export function cssSize(el: Element, w: number, h: number): { width: string; height: string } {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!cs || cs.boxSizing !== "content-box") return { width: `${w}px`, height: `${h}px` };
  const px = (v: string) => Number.parseFloat(v) || 0;
  const dw = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  const dh = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  const round = (n: number) => Math.round(Math.max(0, n) * 100) / 100;
  return { width: `${round(w - dw)}px`, height: `${round(h - dh)}px` };
}

/**
 * Clearing the last inline style leaves an empty `style=""` behind. Drop it, so
 * undoing an edit gives back the page's own markup.
 */
function tidyStyle(el: HTMLElement): void {
  if (el.getAttribute("style")?.trim() === "") el.removeAttribute("style");
}

/** Text directly inside the element (not inside child elements). */
function ownText(el: Element): string {
  let t = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) t += n.nodeValue;
  return t.replace(/\s+/g, " ").trim();
}

type Pristine = {
  text?: { nodes: Text[]; values: string[]; text: string; added?: Text };
  style?: Map<string, { value: string; priority: string }>;
  size?: { width: string; height: string; w: number; h: number };
};
