import type { Layout, NodeType, Scene, SceneNode, SceneTheme } from "@glimpse/core";

/**
 * Geometry of scene mocks (terminal UIs and native GUIs drawn from
 * glimpse.scene.json): absolute boxes, the terminal cell grid, where new
 * widgets go and how big they start. Layout units are character cells for a
 * terminal UI and CSS pixels for a native GUI; x/y are relative to the parent.
 */

export type SceneTarget = "tui" | "native";

export function isSceneTarget(target: string | undefined): target is SceneTarget {
  return target === "tui" || target === "native";
}

/** Pixel size of one terminal cell, measured from the font (see measureCell). */
export interface Cell {
  w: number;
  h: number;
}

/** The terminal font: JetBrains Mono (bundled), then whatever monospace font the system has. */
export const TUI_FONT = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
export const TUI_FONT_SIZE = 14;
/** Terminals draw a row a little taller than the font (xterm.js: the font's ascent + descent). */
const LINE_HEIGHT = 18;

/** Cell size of the terminal font, once it has loaded (a monospace advance is the same for every character). */
export async function measureCell(): Promise<Cell> {
  try {
    await document.fonts.load(`${TUI_FONT_SIZE}px "JetBrains Mono"`);
    await document.fonts.load(`bold ${TUI_FONT_SIZE}px "JetBrains Mono"`);
  } catch {
    // no font loading API (or blocked): measure the fallback font
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return DEFAULT_CELL;
  ctx.font = `${TUI_FONT_SIZE}px ${TUI_FONT}`;
  const w = ctx.measureText("M".repeat(100)).width / 100;
  return w > 4 && w < 20 ? { w, h: LINE_HEIGHT } : DEFAULT_CELL;
}

export const DEFAULT_CELL: Cell = { w: 8.4, h: LINE_HEIGHT };

/** Pixels per layout unit along x and y. */
export function unitSize(target: SceneTarget, cell: Cell): Cell {
  return target === "tui" ? cell : { w: 1, h: 1 };
}

/** A node's box relative to the root (the screen or the window's client area), or null when it isn't in the tree. */
export function absBox(scene: Scene, id: string): Layout | null {
  const n = scene.nodes[id];
  if (!n) return null;
  if (n.parent === null) return { x: 0, y: 0, w: n.layout.w, h: n.layout.h };
  let { x, y } = n.layout;
  for (let p: string | null = n.parent; p !== null; ) {
    const pn: SceneNode | undefined = scene.nodes[p];
    if (!pn) return null;
    if (pn.parent !== null) {
      x += pn.layout.x;
      y += pn.layout.y;
    }
    p = pn.parent;
  }
  return { x, y, w: n.layout.w, h: n.layout.h };
}

/** Nodes new widgets go into (rather than after). */
const CONTAINERS = new Set<NodeType>(["root", "window", "box", "panel", "card", "nav", "tabs"]);

export function isSceneContainer(n: SceneNode): boolean {
  return CONTAINERS.has(n.type);
}

/** The pane a tabs node shows (its selected tab's), the only one of its children that is drawn. */
export function shownPane(n: SceneNode): string | undefined {
  return n.children[selectedTab(n, n.children.length)];
}

/** The selected one of `count` tabs: the `selected` prop, clamped to the tabs there are (the first when unset). */
export function selectedTab(n: SceneNode, count: number): number {
  const v = n.props.selected?.trim();
  const i = v && /^-?\d+$/.test(v) ? Number(v) : 0;
  return Math.max(0, Math.min(i, count - 1));
}

/** The node is drawn: no tabs node above it shows another pane instead (hidden nodes aside). */
export function isDrawn(scene: Scene, id: string): boolean {
  for (let n = scene.nodes[id]; n?.parent; n = scene.nodes[n.parent]) {
    const p = scene.nodes[n.parent];
    if (p?.type === "tabs" && shownPane(p) !== n.id) return false;
  }
  return true;
}

/** The host OS's look, for native mocks that don't name a theme. The desktop app says which it runs on. */
export function hostTheme(): SceneTheme {
  const desktop = new URLSearchParams(location.search).get("desktop");
  if (desktop === "mac") return "macos";
  if (desktop === "win") return "windows";
  if (desktop === "linux") return "linux";
  const p = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/.test(p)) return "macos";
  if (/Win/.test(p)) return "windows";
  return "linux";
}

/* ── New widgets ──────────────────────────────────────────────────────── */

export interface PaletteItem {
  label: string;
  type: NodeType;
  /** Starting size: cells for a terminal UI, pixels for a native GUI. "fill" spans the parent's width. */
  size: Record<SceneTarget, [number | "fill", number]>;
  props?: Record<string, string>;
  style?: Partial<Record<SceneTarget, Record<string, string>>>;
  /** Only offered for this target. */
  only?: SceneTarget;
}

export const SCENE_PALETTE: PaletteItem[] = [
  { label: "Button", type: "button", size: { tui: [16, 3], native: [88, 32] }, props: { text: "Button" } },
  { label: "Label", type: "label", size: { tui: [12, 1], native: [120, 20] }, props: { text: "Label" } },
  { label: "Text", type: "text", size: { tui: [30, 3], native: [240, 60] }, props: { text: "Some text" } },
  { label: "Input", type: "input", size: { tui: [30, 3], native: [220, 28] }, props: { placeholder: "Type here…" } },
  { label: "Checkbox", type: "checkbox", size: { tui: [20, 1], native: [160, 20] }, props: { text: "Option", checked: "false" } },
  { label: "Radio", type: "radio", size: { tui: [20, 1], native: [160, 20] }, props: { text: "Choice", checked: "false" } },
  { label: "Switch", type: "switch", size: { tui: [16, 1], native: [200, 24] }, props: { text: "Setting", checked: "true" } },
  { label: "Select", type: "select", size: { tui: [24, 3], native: [200, 28] }, props: { items: "First\nSecond\nThird", selected: "0" } },
  {
    label: "List",
    type: "list",
    size: { tui: [30, 8], native: [200, 160] },
    props: { items: "First item\nSecond item\nThird item", selected: "0" },
    style: { tui: { border: "round" } },
  },
  {
    label: "Table",
    type: "table",
    size: { tui: [40, 8], native: [320, 160] },
    props: { columns: "Name\nValue", items: "Alpha\t1\nBeta\t2\nGamma\t3", selected: "0" },
  },
  { label: "Tree", type: "tree", size: { tui: [30, 8], native: [220, 160] }, props: { items: "Project\n  src\n    main.py\n  README.md" } },
  { label: "Tabs", type: "tabs", size: { tui: [40, 2], native: [360, 240] }, props: { items: "General\nAdvanced\nAbout", selected: "0" } },
  { label: "Progress", type: "progress", size: { tui: [30, 1], native: [220, 16] }, props: { value: "40", max: "100" } },
  { label: "Slider", type: "slider", size: { tui: [30, 1], native: [200, 24] }, props: { value: "50", min: "0", max: "100" } },
  { label: "Panel", type: "panel", size: { tui: [30, 10], native: [300, 180] }, props: { title: "Panel" }, style: { tui: { border: "round" } } },
  { label: "Box", type: "box", size: { tui: [30, 6], native: [240, 120] } },
  { label: "Divider", type: "divider", size: { tui: ["fill", 1], native: ["fill", 1] } },
  { label: "Menu bar", type: "menu", size: { tui: ["fill", 1], native: ["fill", 24] }, props: { items: "File\nEdit\nView\nHelp" } },
  { label: "Status bar", type: "statusbar", size: { tui: ["fill", 1], native: ["fill", 24] }, props: { items: "q Quit\n? Help" } },
  { label: "Image", type: "image", size: { tui: [20, 8], native: [160, 120] }, props: { alt: "Image" } },
];

/** The real widget class for a palette type in well-known toolkits, so the change list names it. */
const TAGS: Record<string, Partial<Record<NodeType, string>>> = {
  textual: {
    button: "Button",
    label: "Label",
    text: "Static",
    input: "Input",
    checkbox: "Checkbox",
    radio: "RadioButton",
    switch: "Switch",
    select: "Select",
    list: "ListView",
    table: "DataTable",
    tree: "Tree",
    tabs: "TabbedContent",
    progress: "ProgressBar",
    panel: "Vertical",
    box: "Container",
    divider: "Rule",
    statusbar: "Footer",
    image: "Static",
  },
  tkinter: {
    button: "ttk.Button",
    label: "ttk.Label",
    text: "tk.Message",
    input: "ttk.Entry",
    checkbox: "ttk.Checkbutton",
    radio: "ttk.Radiobutton",
    select: "ttk.Combobox",
    list: "tk.Listbox",
    table: "ttk.Treeview",
    tree: "ttk.Treeview",
    tabs: "ttk.Notebook",
    progress: "ttk.Progressbar",
    slider: "ttk.Scale",
    panel: "ttk.LabelFrame",
    box: "ttk.Frame",
    divider: "ttk.Separator",
    menu: "tk.Menu",
    statusbar: "ttk.Label",
    image: "tk.Canvas",
  },
};

export function tagForWidget(framework: string | undefined, type: NodeType): string | undefined {
  return TAGS[(framework ?? "").toLowerCase().replace(/[\s_-]/g, "")]?.[type];
}

/**
 * Where a new widget goes inside `parent`: below `after` (the selected sibling)
 * or below the parent's lowest child, kept inside the parent. Bars span the
 * parent: a menu bar at its top, a status bar at its bottom.
 */
export function placeWidget(scene: Scene, node: SceneNode, parentId: string, after: string | undefined, target: SceneTarget): Layout {
  const parent = scene.nodes[parentId]!;
  const pw = parent.layout.w;
  const ph = parent.layout.h;
  const framed = target === "tui" && hasBorder(parent);
  const inset = target === "tui" ? (framed ? 1 : 0) : parent.parent === null ? 16 : 8;
  const gap = target === "tui" ? 0 : 8;
  const fill = node.layout.w <= 0;
  const w = fill ? Math.max(1, pw - 2 * (framed ? 1 : 0)) : Math.max(1, Math.min(node.layout.w, pw - 2 * inset));
  const h = Math.max(1, Math.min(node.layout.h, Math.max(1, ph - 2 * inset)));
  if (node.type === "menu") return { x: framed ? 1 : 0, y: framed ? 1 : 0, w, h };
  if (node.type === "statusbar") return { x: framed ? 1 : 0, y: Math.max(0, ph - h - (framed ? 1 : 0)), w, h };
  const sib = after ? scene.nodes[after] : undefined;
  let x = fill ? (framed ? 1 : 0) : inset;
  let y = inset;
  if (sib) {
    x = fill ? x : sib.layout.x;
    y = sib.layout.y + sib.layout.h + gap;
  } else if (parent.children.length) {
    y = Math.max(...parent.children.map((c) => scene.nodes[c]!).filter((c) => c.type !== "statusbar").map((c) => c.layout.y + c.layout.h), inset - gap) + gap;
  }
  // Keep it inside the parent where it fits.
  x = Math.max(0, Math.min(x, pw - w));
  y = Math.max(0, Math.min(y, ph - h - (target === "tui" && framed ? 1 : 0)));
  return { x, y, w, h };
}

/** A terminal widget draws a frame around its content (style.border, or a panel's default one). */
export function hasBorder(n: SceneNode): boolean {
  const kind = (n.style.border ?? "").trim().split(/\s+/)[0] ?? "";
  if (kind === "none" || kind === "hidden" || kind === "blank") return false;
  return kind !== "" || n.type === "panel" || n.type === "card";
}

/** Snap a box (in layout units) to whole units, at least one unit big. */
export function snapLayout(l: Layout): Layout {
  return { x: Math.round(l.x), y: Math.round(l.y), w: Math.max(1, Math.round(l.w)), h: Math.max(1, Math.round(l.h)) };
}

/** Prop a double-click edits: the text, the title of a frame, or the rows of a list-like widget. */
export function editableProp(n: SceneNode): { key: string; multiline: boolean } | null {
  switch (n.type) {
    case "list":
    case "select":
    case "tabs":
    case "menu":
    case "tree":
    case "table":
      return { key: "items", multiline: true };
    case "statusbar":
      return n.props.items !== undefined && n.props.text === undefined ? { key: "items", multiline: true } : { key: "text", multiline: false };
    case "panel":
    case "window":
    case "card":
      return { key: "title", multiline: false };
    case "box":
    case "nav":
      return n.props.title !== undefined ? { key: "title", multiline: false } : null;
    case "progress":
    case "slider":
    case "divider":
    case "image":
      return null;
    case "text":
      return { key: "text", multiline: true };
    default:
      return n.children.length ? null : { key: "text", multiline: !!n.props.multiline };
  }
}
