import type { Layout, Op, Scene, SceneNode } from "@glimpse/core";
import type { Rect } from "./arrange";
import type { DomBridge } from "./dom";

/**
 * What the editing helpers (store, arrange) work on: the live page in the
 * preview iframe, or the mock of a terminal UI or native GUI that the editor
 * draws itself from glimpse.scene.json (see scene-mode.ts). Features that only
 * need ids, boxes and a scene go through this, so they work on both.
 */
export interface Surface {
  /** A node id that isn't taken yet. */
  newId(): string;
  /** The scene as it is now: a fresh op log starts from it (after a handoff). */
  buildScene(): Scene;
  /** Apply one op to the scene (and to whatever shows it). Used as the op log's applier (`undo`: the inverse of an earlier op). */
  apply(scene: Scene, op: Op, undo?: boolean): void;
  /**
   * A node's box in the canvas's gesture coordinates (marquee, box prompts): the
   * preview's viewport for the live page, layout units of the scene for a mock. Null when it isn't shown.
   */
  rect(id: string): Rect | null;
  /** A node's box in page coordinates, independent of scrolling (align, distribute, group). */
  box(id: string): Layout | null;
  /**
   * The layout places nodes (x/y relative to the parent, as in a scene mock), rather
   * than being measured from a page that lays itself out. Grouping then keeps
   * children where they are on screen by moving them into the group's coordinates.
   */
  readonly positioned: boolean;
  /** New elements from the palette go inside `n` rather than after it. */
  isContainer(n: SceneNode): boolean;
  /** Size and position a new element before it is added to `parent` (right after `after`, when given). */
  place?(node: SceneNode, parent: string, after?: string): void;
  /** Inline text editing of a node (double-click, Inspector's Edit text). */
  editText?(id: string): void;
  /** A picture of the edited UI with its box prompts drawn in, for a handoff. */
  screenshot?(): Promise<string | null>;
  /** A thumbnail of version `id` for the timeline. */
  thumbnail?(id: string, maxWidth: number): Promise<string | null>;
}

const CONTAINER_TAGS = new Set(["div", "section", "main", "header", "footer", "nav", "article", "aside", "form", "ul", "ol"]);

const bridges = new WeakMap<DomBridge, Surface>();

/** The live page in the preview iframe as a surface. */
export function domSurface(bridge: DomBridge): Surface {
  let s = bridges.get(bridge);
  if (!s) {
    s = {
      newId: () => bridge.newId(),
      buildScene: () => bridge.buildScene(),
      apply: (scene, op, undo) => bridge.apply(scene, op, undo),
      rect: (id) => bridge.rect(id),
      box: (id) => {
        // Viewport + scroll, so the box doesn't depend on where the page is scrolled.
        const r = bridge.rect(id);
        const win = bridge.doc.defaultView;
        return r && win ? { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height } : null;
      },
      positioned: false,
      isContainer: (n) => CONTAINER_TAGS.has(n.tag ?? "") || n.type === "root",
    };
    bridges.set(bridge, s);
  }
  return s;
}
