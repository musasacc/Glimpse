import { NODE_TYPES, type Layout, type NodeType, type Scene, type SceneNode, type SourceLocation } from "./scene.js";

/**
 * `glimpse.scene.json`: how an agent describes a terminal UI or a native GUI
 * that Glimpse can't edit live. Glimpse renders an editable mock of it, and
 * the human's edits go back to the agent to apply to the real code.
 *
 * Two equivalent forms are accepted:
 * - nested (recommended): `{ target, root: { type, layout, children: [ {…}, … ] } }`, ids optional
 * - flat (the Scene shape): `{ target, rootId, nodes: { id: { …, children: [ids] } } }`
 *
 * Parsing is tolerant: problems are reported in `errors` and patched over with
 * defaults so the human always sees something. Only invalid JSON throws.
 */

export type SceneFileTarget = "tui" | "native";
export type SceneTheme = "macos" | "windows" | "linux";
export type SceneFileFormat = "flat" | "nested";

export const SCENE_FILE_TARGETS: readonly SceneFileTarget[] = ["tui", "native"];
export const SCENE_THEMES: readonly SceneTheme[] = ["macos", "windows", "linux"];
export const SCENE_FILE_NAME = "glimpse.scene.json";
/** Where the published JSON Schema lives (docs/glimpse.scene.schema.json in the repo). */
export const SCENE_SCHEMA_URL = "https://raw.githubusercontent.com/musasacc/Glimpse/main/docs/glimpse.scene.schema.json";

/** Size of the root when the file doesn't give one: an 80×24 terminal, or an 800×600 px window. */
export const DEFAULT_ROOT_SIZE: Record<SceneFileTarget, { w: number; h: number }> = {
  tui: { w: 80, h: 24 },
  native: { w: 800, h: 600 },
};

/** Props that may be written as arrays in the file (one entry per line; table rows as arrays of cells). */
export const LIST_PROPS: readonly string[] = ["items", "columns"];
/** Props written as JSON booleans in the file ("true"/"false" in the scene). */
export const BOOLEAN_PROPS: readonly string[] = ["checked", "disabled", "readonly", "password", "multiline", "default", "expanded"];
/** Props written as JSON numbers in the file when they hold a number. */
export const NUMBER_PROPS: readonly string[] = ["selected", "value", "min", "max", "step"];

export interface SceneMeta {
  /** The real UI toolkit, e.g. "textual", "ink", "ratatui", "bubbletea", "tkinter", "qt", "wxpython". */
  framework?: string;
  /** How to run the real app from the project directory, e.g. "python app.py". */
  command?: string;
  /** App or window title. */
  title?: string;
  [key: string]: unknown;
}

/** Everything in the file that isn't part of the Scene; kept so the file can be written back as it was. */
export interface SceneFileExtras {
  $schema?: string;
  theme?: SceneTheme;
  meta?: SceneMeta;
}

export interface ParsedSceneFile {
  scene: Scene;
  /** Problems found (and patched over). Empty for a valid file. */
  errors: string[];
  format: SceneFileFormat;
  extras: SceneFileExtras;
}

/** Thrown by `parseSceneFile` when the text isn't JSON at all. */
export class SceneFileSyntaxError extends SyntaxError {
  constructor(
    message: string,
    /** 1-based line and column of the problem, when known. */
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "SceneFileSyntaxError";
  }
}

/* ── The file's own shapes (what agents write) ────────────────────────── */

export type ScenePropValue = string | number | boolean | (string | number | boolean)[] | (string | number | boolean)[][];

export interface SceneFileNodeBase {
  type: NodeType;
  /** The real widget class, e.g. "Button", "ListView", "ttk.Entry", "QPushButton". */
  tag?: string;
  layout: Layout;
  style?: Record<string, string | number>;
  props?: Record<string, ScenePropValue>;
  hidden?: boolean;
  locked?: boolean;
  /** Where the widget is created in the real code (1-based line and column), or "file:line:col". */
  source?: SourceLocation | string;
}

export interface SceneFileNestedNode extends SceneFileNodeBase {
  id?: string;
  children?: SceneFileNestedNode[];
}

export interface SceneFileFlatNode extends SceneFileNodeBase {
  id?: string;
  parent?: string | null;
  children?: string[];
}

interface SceneFileCommon extends SceneFileExtras {
  target: SceneFileTarget;
}

export type SceneFile =
  | (SceneFileCommon & { root: SceneFileNestedNode })
  | (SceneFileCommon & { rootId: string; nodes: Record<string, SceneFileFlatNode> });

/* ── Parsing ──────────────────────────────────────────────────────────── */

const TOP_KEYS = new Set(["$schema", "target", "theme", "meta", "root", "rootId", "nodes"]);
const NODE_KEYS = new Set(["id", "type", "tag", "parent", "children", "layout", "style", "props", "hidden", "locked", "source"]);
const KNOWN_TYPES = new Set<string>(NODE_TYPES);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read a glimpse.scene.json text. Throws `SceneFileSyntaxError` only when it isn't valid JSON. */
export function parseSceneFile(text: string): ParsedSceneFile {
  const data = parseJson(text);
  const errors: string[] = [];
  const extras: SceneFileExtras = {};

  if (!isObject(data)) {
    errors.push("The scene file must be a JSON object like { \"target\": \"tui\", \"root\": { … } }.");
    return { scene: emptyScene("tui"), errors, format: "nested", extras };
  }

  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.has(key)) errors.push(`Unknown top-level key "${key}" (ignored).`);
  }

  let target: SceneFileTarget = "tui";
  if (data.target === "tui" || data.target === "native") target = data.target;
  else if (data.target === undefined) errors.push('"target" is missing: use "tui" (terminal UI) or "native" (desktop GUI). Assuming "tui".');
  else errors.push(`"target" must be "tui" or "native", got ${JSON.stringify(data.target)}. Assuming "tui".`);

  if (data.$schema !== undefined) {
    if (typeof data.$schema === "string") extras.$schema = data.$schema;
    else errors.push('"$schema" must be a string (ignored).');
  }

  if (data.theme !== undefined) {
    if (typeof data.theme === "string" && (SCENE_THEMES as readonly string[]).includes(data.theme)) {
      extras.theme = data.theme as SceneTheme;
      if (target === "tui") errors.push('"theme" only applies to native scenes; terminal UIs ignore it.');
    } else {
      errors.push(`"theme" must be one of ${SCENE_THEMES.map((t) => `"${t}"`).join(", ")} (ignored).`);
    }
  }

  if (data.meta !== undefined) {
    if (isObject(data.meta)) {
      const meta: SceneMeta = {};
      for (const [key, value] of Object.entries(data.meta)) {
        if ((key === "framework" || key === "command" || key === "title") && typeof value !== "string") {
          errors.push(`"meta.${key}" must be a string (ignored).`);
          continue;
        }
        meta[key] = value;
      }
      extras.meta = meta;
    } else {
      errors.push('"meta" must be an object like { "framework": "textual", "command": "python app.py" } (ignored).');
    }
  }

  const hasRoot = data.root !== undefined;
  const hasFlat = data.nodes !== undefined || data.rootId !== undefined;
  if (hasRoot && hasFlat) errors.push('Use either "root" (nested form) or "rootId" + "nodes" (flat form), not both. Using "root".');

  if (!hasRoot && !hasFlat) {
    errors.push('The scene has no nodes: add "root": { "type": "root", "layout": { … }, "children": [ … ] }.');
    return { scene: emptyScene(target), errors, format: "nested", extras };
  }
  if (hasRoot) return { scene: parseNested(data.root, target, errors), errors, format: "nested", extras };
  return { scene: parseFlat(data, target, errors), errors, format: "flat", extras };
}

/** All problems in a scene file text (an invalid-JSON message included), for validation tools. */
export function validateSceneFile(text: string): string[] {
  try {
    return parseSceneFile(text).errors;
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

function emptyScene(target: SceneFileTarget): Scene {
  const { w, h } = DEFAULT_ROOT_SIZE[target];
  return {
    target,
    rootId: "root",
    nodes: { root: { id: "root", type: "root", parent: null, children: [], layout: { x: 0, y: 0, w, h }, style: {}, props: {} } },
  };
}

function parseJson(text: string): Json {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(src) as Json;
  } catch (err) {
    // Engines word (and position) JSON errors differently, so find the spot ourselves.
    const found = locateJsonError(src);
    if (!found) throw new SceneFileSyntaxError(`The scene file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    const { line, column } = lineCol(src, found.offset);
    throw new SceneFileSyntaxError(`The scene file is not valid JSON at line ${line}, column ${column}: ${found.reason}.`, line, column);
  }
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** A minimal JSON scanner that finds the offset of the first syntax error (null when the text is valid). */
function locateJsonError(s: string): { offset: number; reason: string } | null {
  let i = 0;
  class Fail {
    constructor(
      readonly offset: number,
      readonly reason: string,
    ) {}
  }
  const fail = (reason: string): never => {
    if (s.startsWith("//", i) || s.startsWith("/*", i)) throw new Fail(i, "comments aren't allowed in JSON");
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j]!)) j--;
    if ((s[i] === "}" || s[i] === "]") && s[j] === ",") throw new Fail(j, "trailing commas aren't allowed in JSON");
    throw new Fail(i, i >= s.length ? "the text ends too early (is a closing bracket or quote missing?)" : reason);
  };
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  const str = () => {
    i++;
    while (i < s.length) {
      const c = s[i]!;
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") i += 2;
      else if (c < " ") fail("line breaks and control characters must be escaped inside strings");
      else i++;
    }
    fail("unterminated string");
  };
  const value = (): void => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      ws();
      if (s[i] === "}") return void i++;
      for (;;) {
        ws();
        if (s[i] !== '"') fail(`expected a property name in double quotes, found ${JSON.stringify(s[i])}`);
        str();
        ws();
        if (s[i] !== ":") fail(`expected ":" after the property name, found ${JSON.stringify(s[i])}`);
        i++;
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "}") return void i++;
        else fail(`expected "," or "}" after the property value, found ${JSON.stringify(s[i])}`);
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (s[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "]") return void i++;
        else fail(`expected "," or "]" after the array item, found ${JSON.stringify(s[i])}`);
      }
    }
    if (c === '"') return str();
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = i;
    if ((c === "-" || (c !== undefined && c >= "0" && c <= "9")) && num.test(s)) {
      i = num.lastIndex;
      return;
    }
    for (const lit of ["true", "false", "null"]) {
      if (s.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    }
    fail(`unexpected ${JSON.stringify(c)}${c === "'" ? " (JSON strings use double quotes)" : ""}`);
  };
  try {
    value();
    ws();
    if (i < s.length) fail("unexpected text after the end of the JSON value");
    return null;
  } catch (e) {
    if (e instanceof Fail) return { offset: e.offset, reason: e.reason };
    throw e;
  }
}

/** Raw node data plus where it sits, before it becomes a SceneNode. */
interface Pending {
  id: string;
  raw: JsonObject;
  where: string;
}

function parseNested(rootRaw: Json | undefined, target: SceneFileTarget, errors: string[]): Scene {
  const scene: Scene = { target, rootId: "root", nodes: {} };
  if (rootRaw !== undefined && !isObject(rootRaw)) {
    errors.push('"root" must be a node object like { "type": "root", "layout": { … }, "children": [ … ] }.');
  }
  const root = isObject(rootRaw) ? rootRaw : {};

  // Explicit ids first, so generated ones never take an id a later node asks for.
  const explicit = new Set<string>();
  const collect = (raw: JsonObject) => {
    if (typeof raw.id === "string" && raw.id) explicit.add(raw.id);
    if (Array.isArray(raw.children)) for (const c of raw.children) if (isObject(c)) collect(c);
  };
  collect(root);
  const used = new Set<string>();
  /** `base`, or `base~2`, `base~3`, … when it's taken. Generated ids also keep clear of every explicit id. */
  const fresh = (base: string, generated: boolean) => {
    if (!used.has(base) && !(generated && explicit.has(base))) return base;
    for (let n = 2; ; n++) {
      const id = `${base}~${n}`;
      if (!used.has(id) && !explicit.has(id)) return id;
    }
  };

  const visit = (raw: JsonObject, parent: SceneNode | null, sameTypeIndex: number, where: string): SceneNode => {
    const type = parent === null && raw.type === undefined ? "root" : readType(raw, where, errors);
    const wanted = typeof raw.id === "string" && raw.id ? raw.id : undefined;
    if (raw.id !== undefined && !wanted) errors.push(`${where}: "id" must be a non-empty string (generated one instead).`);
    let id: string;
    if (wanted) {
      id = fresh(wanted, false);
      if (id !== wanted) errors.push(`${where}: duplicate id "${wanted}" (renamed to "${id}").`);
    } else {
      id = fresh(parent === null ? "root" : autoId(scene, parent, type, sameTypeIndex), true);
    }
    used.add(id);
    if (parent === null) scene.rootId = id;
    const label = wanted ? `node "${wanted}"` : where;
    const node = buildNode(id, type, raw, parent, target, label, errors);
    scene.nodes[id] = node;
    if (raw.children !== undefined && !Array.isArray(raw.children)) {
      errors.push(`${label}: "children" must be an array of node objects (ignored).`);
    } else if (Array.isArray(raw.children)) {
      raw.children.forEach((c, i) => {
        const childWhere = `${where}.children[${i}]`;
        if (!isObject(c)) {
          errors.push(`${childWhere}: in the nested form, children are node objects, got ${JSON.stringify(c)} (ignored).`);
          return;
        }
        // Count earlier siblings of the same type, so ids stay put when other kinds of widgets are added.
        const t = quietType(c);
        const child = visit(c, node, node.children.filter((cid) => scene.nodes[cid]!.type === t).length, childWhere);
        node.children.push(child.id);
      });
    }
    return node;
  };

  visit(root, null, 0, "root");
  return scene;
}

/**
 * The id a node without one gets: its type and its index among same-type
 * siblings, under its parent's id, e.g. "button-0" or "sidebar.button-2".
 */
function autoId(scene: Scene, parent: SceneNode, type: NodeType, sameTypeIndex: number): string {
  const name = `${type}-${sameTypeIndex}`;
  return parent.id === scene.rootId ? name : `${parent.id}.${name}`;
}

/** The type `readType` will settle on, without reporting anything. */
function quietType(raw: JsonObject): NodeType {
  if (raw.type === undefined) return "box";
  return typeof raw.type === "string" && KNOWN_TYPES.has(raw.type) ? (raw.type as NodeType) : "custom";
}

function readType(raw: JsonObject, where: string, errors: string[]): NodeType {
  if (raw.type === undefined) {
    errors.push(`${where}: "type" is missing (using "box").`);
    return "box";
  }
  if (typeof raw.type === "string" && KNOWN_TYPES.has(raw.type)) return raw.type as NodeType;
  errors.push(`${where}: unknown type ${JSON.stringify(raw.type)} (shown as "custom"). Known types: ${NODE_TYPES.join(", ")}.`);
  return "custom";
}

function parseFlat(data: JsonObject, target: SceneFileTarget, errors: string[]): Scene {
  const rawNodes: Record<string, JsonObject> = {};
  if (data.nodes !== undefined && !isObject(data.nodes)) errors.push('"nodes" must be an object of { id: node }.');
  for (const [id, raw] of Object.entries(isObject(data.nodes) ? data.nodes : {})) {
    if (!isObject(raw)) {
      errors.push(`node "${id}": must be an object (ignored).`);
      continue;
    }
    if (raw.id !== undefined && raw.id !== id) errors.push(`node "${id}": "id" is ${JSON.stringify(raw.id)} but its key is "${id}" (using the key).`);
    rawNodes[id] = raw;
  }
  const ids = Object.keys(rawNodes);

  let rootId: string;
  if (typeof data.rootId === "string" && rawNodes[data.rootId]) {
    rootId = data.rootId;
  } else {
    const guess = rawNodes.root ? "root" : (ids.find((id) => rawNodes[id]!.parent === null) ?? ids[0]);
    if (data.rootId === undefined) errors.push(`"rootId" is missing${guess ? ` (using "${guess}")` : ""}.`);
    else errors.push(`"rootId" ${JSON.stringify(data.rootId)} is not one of the nodes${guess ? ` (using "${guess}")` : ""}.`);
    if (guess) {
      rootId = guess;
    } else {
      rootId = "root";
      rawNodes.root = { type: "root" };
      ids.push("root");
    }
  }

  // Children lists are authoritative; `parent` fills in for nodes no list mentions.
  const parentOf = new Map<string, string>();
  const childLists = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    const children = rawNodes[id]!.children;
    if (children === undefined) continue;
    if (!Array.isArray(children)) {
      errors.push(`node "${id}": "children" must be an array of node ids (ignored).`);
      continue;
    }
    for (const c of children) {
      if (typeof c !== "string") errors.push(`node "${id}": children must be node ids (strings), got ${JSON.stringify(c)} (ignored).`);
      else if (!rawNodes[c]) errors.push(`node "${id}": child "${c}" is not one of the nodes (ignored).`);
      else if (c === rootId) errors.push(`node "${id}": the root "${c}" can't be a child (ignored).`);
      else if (c === id) errors.push(`node "${id}": a node can't be its own child (ignored).`);
      else if (parentOf.has(c)) errors.push(`node "${c}": listed as a child of both "${parentOf.get(c)}" and "${id}" (keeping "${parentOf.get(c)}").`);
      else {
        parentOf.set(c, id);
        childLists.get(id)!.push(c);
      }
    }
  }
  for (const id of ids) {
    const p = rawNodes[id]!.parent;
    if (id === rootId) {
      if (p !== undefined && p !== null) errors.push(`node "${id}": the root's "parent" must be null (ignored).`);
      continue;
    }
    const listed = parentOf.get(id);
    if (listed !== undefined) {
      if (p !== undefined && p !== listed) errors.push(`node "${id}": "parent" is ${JSON.stringify(p)} but it is listed in the children of "${listed}" (using "${listed}").`);
      continue;
    }
    let to = rootId;
    if (typeof p === "string" && rawNodes[p] && p !== id) to = p;
    else if (typeof p === "string") errors.push(`node "${id}": parent "${p}" is not one of the nodes (attached to the root).`);
    else errors.push(`node "${id}": not attached to the tree (no parent lists it as a child; attached to the root).`);
    parentOf.set(id, to);
    childLists.get(to)!.push(id);
  }

  // Every node now has one parent; whatever the root can't reach hangs off a cycle.
  const reachable = new Set<string>();
  const mark = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const c of childLists.get(id)!) mark(c);
  };
  mark(rootId);
  for (const id of ids) {
    if (reachable.has(id)) continue;
    const seen = new Set<string>();
    let at = id;
    while (!seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at)!;
    }
    const from = parentOf.get(at)!;
    const list = childLists.get(from)!;
    list.splice(list.indexOf(at), 1);
    parentOf.set(at, rootId);
    childLists.get(rootId)!.push(at);
    errors.push(`node "${at}": its parents form a cycle (moved it from "${from}" to the root).`);
    mark(at);
  }

  // Build in tree order (parents first, for layout defaults), then keep the file's order of nodes.
  const built: Record<string, SceneNode> = {};
  const build = (id: string, parent: SceneNode | null) => {
    const raw = rawNodes[id]!;
    const type = parent === null && raw.type === undefined ? "root" : readType(raw, `node "${id}"`, errors);
    const node = buildNode(id, type, raw, parent, target, `node "${id}"`, errors);
    node.children = [...childLists.get(id)!];
    built[id] = node;
    for (const c of node.children) build(c, node);
  };
  build(rootId, null);
  const nodes: Record<string, SceneNode> = {};
  for (const id of ids) nodes[id] = built[id]!;
  return { target, rootId, nodes };
}

function buildNode(
  id: string,
  type: NodeType,
  raw: JsonObject,
  parent: SceneNode | null,
  target: SceneFileTarget,
  label: string,
  errors: string[],
): SceneNode {
  for (const key of Object.keys(raw)) {
    if (!NODE_KEYS.has(key)) errors.push(`${label}: unknown key "${key}" (ignored).`);
  }
  let tag: string | undefined;
  if (typeof raw.tag === "string") tag = raw.tag;
  else if (raw.tag !== undefined) errors.push(`${label}: "tag" must be a string, the real widget class (ignored).`);
  // An unknown type is shown as "custom"; keep what the agent wrote as the tag.
  if (type === "custom" && raw.type !== "custom" && typeof raw.type === "string" && tag === undefined) tag = raw.type;
  const node: SceneNode = {
    id,
    type,
    ...(tag !== undefined && { tag }),
    parent: parent?.id ?? null,
    children: [],
    layout: readLayout(raw.layout, parent, target, label, errors),
    style: readStyle(raw.style, label, errors),
    props: readProps(raw.props, label, errors),
  };
  for (const flag of ["hidden", "locked"] as const) {
    const v = raw[flag];
    if (v === undefined) continue;
    if (typeof v === "boolean") {
      if (v) node[flag] = true;
    } else errors.push(`${label}: "${flag}" must be true or false (ignored).`);
  }
  if (raw.source !== undefined) {
    const src = readSource(raw.source);
    if (src) node.source = src;
    else errors.push(`${label}: "source" must be { "file": "app.py", "line": 12, "col": 5 } (1-based) or "app.py:12:5" (ignored).`);
  }
  return node;
}

function readLayout(raw: Json | undefined, parent: SceneNode | null, target: SceneFileTarget, label: string, errors: string[]): Layout {
  const unit = target === "tui" ? "cells" : "pixels";
  const defaults: Layout =
    parent === null
      ? { x: 0, y: 0, ...DEFAULT_ROOT_SIZE[target] }
      : { x: 0, y: 0, w: parent.layout.w, h: target === "tui" ? 1 : 24 };
  if (raw === undefined) {
    errors.push(`${label}: "layout" is missing; give { "x", "y", "w", "h" } in ${unit}, relative to the parent (using ${fmtLayout(defaults)}).`);
    return defaults;
  }
  if (!isObject(raw)) {
    errors.push(`${label}: "layout" must be { "x", "y", "w", "h" } in ${unit} (using ${fmtLayout(defaults)}).`);
    return defaults;
  }
  const out = { ...defaults };
  for (const key of Object.keys(raw)) {
    if (!["x", "y", "w", "h"].includes(key)) errors.push(`${label}: unknown layout key "${key}" (ignored; use x, y, w, h).`);
  }
  for (const k of ["x", "y", "w", "h"] as const) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      // A missing width fills the rest of the parent (x is read before w).
      const fallback = k === "w" && parent ? Math.max(0, parent.layout.w - out.x) : defaults[k];
      errors.push(
        v === undefined
          ? `${label}: layout.${k} is missing (using ${fallback}).`
          : `${label}: layout.${k} must be a number, got ${JSON.stringify(v)} (using ${fallback}).`,
      );
      out[k] = fallback;
      continue;
    }
    let n = v;
    if (target === "tui" && !Number.isInteger(n)) {
      n = Math.round(n);
      errors.push(`${label}: layout.${k} is ${v}, but terminal layouts are whole cells (rounded to ${n}).`);
    }
    if ((k === "w" || k === "h") && n < 0) {
      errors.push(`${label}: layout.${k} can't be negative (using 0).`);
      n = 0;
    }
    out[k] = n;
  }
  return out;
}

function fmtLayout(l: Layout): string {
  return `x ${l.x}, y ${l.y}, w ${l.w}, h ${l.h}`;
}

function readStyle(raw: Json | undefined, label: string, errors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    errors.push(`${label}: "style" must be an object of strings like { "color": "cyan" } (ignored).`);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    else errors.push(`${label}: style "${k}" must be a string (ignored).`);
  }
  return out;
}

function readProps(raw: Json | undefined, label: string, errors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    errors.push(`${label}: "props" must be an object like { "text": "Save" } (ignored).`);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    const s = propToString(v);
    if (s === null) errors.push(`${label}: prop "${k}" must be a string, number, boolean or array of strings (ignored).`);
    else out[k] = s;
  }
  return out;
}

const isPrimitive = (v: Json): v is string | number | boolean =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** File prop value → scene string: arrays become one line per entry, and table rows join their cells with tabs. */
function propToString(v: Json): string | null {
  if (isPrimitive(v)) return String(v);
  if (!Array.isArray(v)) return null;
  const lines: string[] = [];
  for (const item of v) {
    if (isPrimitive(item)) lines.push(String(item));
    else if (Array.isArray(item) && item.every(isPrimitive)) lines.push(item.map(String).join("\t"));
    else return null;
  }
  return lines.join("\n");
}

function readSource(raw: Json): SourceLocation | null {
  if (typeof raw === "string") {
    const m = /^(.+):(\d+):(\d+)$/.exec(raw.trim());
    return m ? { file: m[1]!.split("\\").join("/"), line: Number(m[2]), col: Number(m[3]) } : null;
  }
  if (!isObject(raw) || typeof raw.file !== "string" || !raw.file) return null;
  const line = raw.line;
  const col = raw.col ?? 1;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  if (typeof col !== "number" || !Number.isInteger(col) || col < 1) return null;
  return { file: raw.file.split("\\").join("/"), line, col };
}

/* ── Serializing ──────────────────────────────────────────────────────── */

/**
 * Write a scene back as glimpse.scene.json text, in the given form and with the
 * file's extras ($schema, theme, meta). Output is stable: the same scene always
 * gives the same text, and `serializeSceneFile(parse(t))` reproduces a canonical `t`.
 */
export function serializeSceneFile(scene: Scene, format: SceneFileFormat = "nested", extras: SceneFileExtras = {}): string {
  const out: Record<string, unknown> = {};
  if (extras.$schema !== undefined) out.$schema = extras.$schema;
  out.target = scene.target;
  if (extras.theme !== undefined) out.theme = extras.theme;
  if (extras.meta !== undefined) out.meta = extras.meta;

  if (format === "flat") {
    out.rootId = scene.rootId;
    const nodes: Record<string, unknown> = {};
    for (const [id, n] of Object.entries(scene.nodes)) {
      nodes[id] = {
        id: n.id,
        type: n.type,
        ...(n.tag !== undefined && { tag: n.tag }),
        parent: n.parent,
        children: [...n.children],
        layout: layoutOut(n.layout),
        style: { ...n.style },
        props: propsOut(n.props),
        ...flagsOut(n),
      };
    }
    out.nodes = nodes;
  } else {
    const seen = new Set<string>();
    const write = (id: string, autoName: string): Record<string, unknown> => {
      seen.add(id);
      const n = scene.nodes[id]!;
      const node: Record<string, unknown> = {};
      if (n.id !== autoName) node.id = n.id;
      node.type = n.type;
      if (n.tag !== undefined) node.tag = n.tag;
      node.layout = layoutOut(n.layout);
      if (Object.keys(n.style).length) node.style = { ...n.style };
      if (Object.keys(n.props).length) node.props = propsOut(n.props);
      Object.assign(node, flagsOut(n));
      const kids = n.children.filter((c) => scene.nodes[c] && !seen.has(c));
      if (kids.length) {
        const counts = new Map<NodeType, number>();
        node.children = kids.map((c) => {
          const t = scene.nodes[c]!.type;
          const i = counts.get(t) ?? 0;
          counts.set(t, i + 1);
          return write(c, autoId(scene, n, t, i));
        });
      }
      return node;
    };
    out.root = write(scene.rootId, "root");
  }
  return `${formatJson(out, "", 0)}\n`;
}

function layoutOut(l: Layout): Layout {
  return { x: l.x, y: l.y, w: l.w, h: l.h };
}

function flagsOut(n: SceneNode): Record<string, unknown> {
  return {
    ...(n.hidden && { hidden: true }),
    ...(n.locked && { locked: true }),
    ...(n.source && { source: { file: n.source.file, line: n.source.line, col: n.source.col } }),
  };
}

/** Scene props → file values: list props back to arrays, known booleans and numbers back to JSON types. */
function propsOut(props: Record<string, string>): Record<string, ScenePropValue> {
  const out: Record<string, ScenePropValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (LIST_PROPS.includes(k)) {
      const lines = v === "" ? [] : v.split("\n");
      out[k] = lines.some((l) => l.includes("\t")) ? lines.map((l) => l.split("\t")) : lines;
    } else if (BOOLEAN_PROPS.includes(k) && (v === "true" || v === "false")) {
      out[k] = v === "true";
    } else if (NUMBER_PROPS.includes(k) && /^-?\d+(\.\d+)?$/.test(v)) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const MAX_LINE = 100;

/** Pretty JSON with 2-space indentation; small flat objects and arrays stay on one line. */
function formatJson(value: unknown, indent: string, prefix: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? value.map((v) => [null, v])
    : Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return open + close;
  const key = (k: string | null) => (k === null ? "" : `${JSON.stringify(k)}: `);

  // Leaf objects (layout, style, props, source, meta) and lists stay on one line when they fit; nodes never do.
  const one = oneLine(value);
  if (one !== null && indent.length + prefix + one.length <= MAX_LINE) return one;
  const inner = indent + "  ";
  const lines = entries.map(([k, v]) => inner + key(k) + formatJson(v, inner, key(k).length));
  return `${open}\n${lines.join(",\n")}\n${indent}${close}`;
}

/**
 * The one-line form of a value made only of primitives and arrays of them
 * (arrays of arrays for table rows), or null when it holds an object.
 */
function oneLine(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (depth > 2) return null;
    const parts = value.map((v) => oneLine(v, depth + 1));
    return parts.includes(null) ? null : `[${parts.join(", ")}]`;
  }
  if (depth > 0) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, v]) => {
    const s = oneLine(v, 1);
    return s === null ? null : `${JSON.stringify(k)}: ${s}`;
  });
  return parts.includes(null) ? null : `{ ${parts.join(", ")} }`;
}
