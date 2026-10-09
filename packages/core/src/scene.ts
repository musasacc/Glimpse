/**
 * The Glimpse Scene: one editable model for every target (HTML, React, TUI, native GUI).
 * The editor, the edit operations and the AI handoff all work on this shape.
 */

export type Target = "html" | "react" | "tui" | "native";

export type NodeType =
  | "root"
  | "box"
  | "text"
  | "button"
  | "input"
  | "image"
  | "link"
  | "list"
  | "nav"
  | "card"
  | "icon"
  | "window"
  | "tabs"
  | "custom"
  // Widgets of terminal UIs and native GUIs (glimpse.scene.json).
  | "panel"
  | "label"
  | "checkbox"
  | "radio"
  | "switch"
  | "select"
  | "table"
  | "tree"
  | "progress"
  | "slider"
  | "menu"
  | "statusbar"
  | "divider";

/** Every node type, in a stable order (the web types first, then the TUI/native widgets). */
export const NODE_TYPES: readonly NodeType[] = [
  "root",
  "box",
  "text",
  "button",
  "input",
  "image",
  "link",
  "list",
  "nav",
  "card",
  "icon",
  "window",
  "tabs",
  "custom",
  "panel",
  "label",
  "checkbox",
  "radio",
  "switch",
  "select",
  "table",
  "tree",
  "progress",
  "slider",
  "menu",
  "statusbar",
  "divider",
];

/** Where a node lives in the real source code. */
export interface SourceLocation {
  file: string;
  line: number;
  col: number;
}

/**
 * Layout box. For web and native targets the unit is CSS pixels; for TUI it is terminal cells.
 * `x`/`y` are relative to the parent.
 */
export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Style = Record<string, string>;
export type Props = Record<string, string>;

export interface SceneNode {
  id: string;
  type: NodeType;
  /** Original tag/widget name, e.g. "div", "QPushButton", "Static". */
  tag?: string;
  parent: string | null;
  children: string[];
  layout: Layout;
  style: Style;
  props: Props;
  hidden?: boolean;
  locked?: boolean;
  source?: SourceLocation;
}

export interface Scene {
  target: Target;
  rootId: string;
  nodes: Record<string, SceneNode>;
}

export function createScene(target: Target, rootLayout: Layout = { x: 0, y: 0, w: 1280, h: 800 }): Scene {
  const rootId = "root";
  return {
    target,
    rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        type: "root",
        parent: null,
        children: [],
        layout: rootLayout,
        style: {},
        props: {},
      },
    },
  };
}

export function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}

export function getNode(scene: Scene, id: string): SceneNode {
  const node = scene.nodes[id];
  if (!node) throw new Error(`Unknown node: ${id}`);
  return node;
}

/** Depth-first list of node ids under (and including) `id`. */
export function subtreeIds(scene: Scene, id: string): string[] {
  const out: string[] = [];
  const walk = (nid: string) => {
    out.push(nid);
    for (const child of getNode(scene, nid).children) walk(child);
  };
  walk(id);
  return out;
}

export function formatSource(src?: SourceLocation): string | undefined {
  return src ? `${src.file}:${src.line}:${src.col}` : undefined;
}
