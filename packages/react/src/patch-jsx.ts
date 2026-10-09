import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import MagicString from "magic-string";
import { createTwoFilesPatch } from "diff";
import type * as t from "@babel/types";
import type { Change, SceneNode } from "@glimpse/core";
import { indexElements, JSX_FILE, parseModule, SRC_ATTR, type JsxElementInfo } from "./jsx-ast.js";

export interface FilePatch {
  file: string;
  before: string;
  after: string;
  /** Unified diff of before → after. */
  diff: string;
}

export interface PatchPlan {
  files: FilePatch[];
  /** Changes Glimpse writes into the source itself. */
  applied: Change[];
  /** Changes only an AI can do well (layout moves, logic, comments, …). */
  needsAi: Change[];
}

export interface PatchResult {
  after: string;
  ok: Change[];
  failed: Change[];
}

/** Ops that are pure editor state and never touch code. */
const EDITOR_ONLY = new Set(["setLocked"]);

export interface PatchJsxOptions {
  /** The file being patched, as data-glimpse-src names it (default: the file of the first located change). */
  file?: string;
  /**
   * Source locations ("file:line:col") the page renders more than once: list
   * items, or elements of a component used several times. Writing an edit of
   * one copy there would change every copy, so changes located at them fail
   * (they go to the AI) and they don't count as anchors.
   */
  repeated?: Iterable<string>;
}

/**
 * Work out how to write `changes` into the project's JSX files (.jsx/.tsx/.js/.ts).
 * Nothing is written here; the caller writes `files` after the human approves
 * the diff. Changes located in other files (or not locatable) go to `needsAi`.
 */
export async function planJsxPatch(dir: string, changes: Change[], options: Pick<PatchJsxOptions, "repeated"> = {}): Promise<PatchPlan> {
  const repeated = [...(options.repeated ?? [])];
  const root = resolve(dir);
  const applied: Change[] = [];
  const needsAi: Change[] = [];
  const byFile = new Map<string, Change[]>();

  for (const c of changes) {
    if (EDITOR_ONLY.has(c.op)) continue;
    const file = patchableFile(c);
    if (!file) {
      needsAi.push(c);
      continue;
    }
    byFile.set(file, [...(byFile.get(file) ?? []), c]);
  }

  const files: FilePatch[] = [];
  for (const [file, fileChanges] of byFile) {
    const path = normalize(join(root, file));
    if (!(path === root || path.startsWith(root + sep)) || !JSX_FILE.test(file)) {
      needsAi.push(...fileChanges);
      continue;
    }
    let before: string;
    try {
      before = await readFile(path, "utf8");
    } catch {
      needsAi.push(...fileChanges);
      continue;
    }
    const { after, ok, failed } = patchJsx(before, fileChanges, { file, repeated });
    applied.push(...ok);
    needsAi.push(...failed);
    if (after !== before) files.push({ file, before, after, diff: createTwoFilesPatch(file, file, before, after, "", "", { context: 3 }) });
  }

  return { files, applied: inOrder(changes, applied), needsAi: inOrder(changes, needsAi) };
}

/** Whether a change points into a JSX/JS source file (what planJsxPatch handles). */
export function isJsxChange(c: Change): boolean {
  const file = c.src ? parseLoc(c.src)?.file : undefined;
  return !!file && JSX_FILE.test(file);
}

/**
 * Combine plans made for disjoint parts of one change list (e.g. the HTML
 * patcher for index.html and planJsxPatch for the components), keeping the
 * change list's order.
 */
export function mergePatchPlans(changes: Change[], ...plans: PatchPlan[]): PatchPlan {
  return {
    files: plans.flatMap((p) => p.files),
    applied: inOrder(changes, plans.flatMap((p) => p.applied)),
    needsAi: inOrder(changes, plans.flatMap((p) => p.needsAi)),
  };
}

function inOrder(changes: Change[], xs: Change[]): Change[] {
  const order = new Map(changes.map((c, i) => [c, i]));
  return [...xs].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Which file a change would be written to, or null when it needs the AI. */
function patchableFile(c: Change): string | null {
  switch (c.op) {
    case "setText":
    case "setStyle":
    case "setProp":
    case "setHidden":
    case "delete":
    case "add":
    case "reorder":
      return c.src ? (parseLoc(c.src)?.file ?? null) : null;
    default:
      // move/resize need idiomatic layout changes; comment/behavior/region/swapType need judgement.
      return null;
  }
}

interface Loc {
  file: string;
  line: number;
  col: number;
}

function parseLoc(src: string): Loc | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(src);
  return m ? { file: m[1]!, line: Number(m[2]), col: Number(m[3]) } : null;
}

/** An element's attribute edits, gathered so several edits to one opening tag don't collide. */
interface AttrEdits {
  /** JSX prop name → new value (null removes it). */
  props: Map<string, { value: string | null; changes: Change[] }>;
  /** CSS property (as the editor names it, e.g. "background-color") → new value. */
  style: Map<string, { value: string | null; changes: Change[] }>;
}

/**
 * Apply changes to one JSX file's text. Elements are found by the "line:col"
 * of their opening "<" (what instrumentJsx writes into data-glimpse-src).
 * Edits are made in place with magic-string, so formatting and comments stay.
 * The file (option or string argument; default: the file named by the
 * changes) picks the parser and is compared with the file of anchors, which
 * may point into other files.
 */
export function patchJsx(code: string, changes: Change[], options: string | PatchJsxOptions = {}): PatchResult {
  const opts = typeof options === "string" ? { file: options } : options;
  const repeated = new Set(opts.repeated ?? []);
  const name = (opts.file ?? changes.map((c) => (c.src ? parseLoc(c.src)?.file : undefined)).find(Boolean) ?? "source.tsx").split("\\").join("/");
  const ast = parseModule(code, name) ?? parseModule(code, /\.tsx?$/i.test(name) ? "source.jsx" : "source.tsx");
  if (!ast) return { after: code, ok: [], failed: [...changes] };
  const els = indexElements(ast);
  const find = (src?: string): JsxElementInfo | undefined => {
    const l = src && !repeated.has(src) ? parseLoc(src) : null;
    if (!l || l.file.split("\\").join("/") !== name) return undefined;
    return els.get(`${l.line}:${l.col}`);
  };

  const s = new MagicString(code);
  const eol = code.includes("\r\n") ? "\r\n" : "\n";
  const ok: Change[] = [];
  const failed: Change[] = [];

  const attrEdits = new Map<t.JSXElement, AttrEdits>();
  const editsFor = (el: t.JSXElement) => {
    let e = attrEdits.get(el);
    if (!e) attrEdits.set(el, (e = { props: new Map(), style: new Map() }));
    return e;
  };
  const queue = (m: AttrEdits["props"], key: string, value: string | null, c: Change) => {
    const slot = m.get(key) ?? { value, changes: [] };
    slot.value = value; // the last edit to a key wins
    slot.changes.push(c);
    m.set(key, slot);
  };

  // Deletes go first: magic-string would wipe text inserted at the edge of a
  // range removed later, and happily writes into a range already removed.
  const deleted: [number, number][] = [];
  /** Whether an insertion point lies inside a deleted range (its edges are fine). */
  const gone = (pos: number) => deleted.some(([a, b]) => pos > a && pos < b);
  /** Whether an element (by its start) was deleted, itself or with an ancestor. */
  const goneEl = (el: t.JSXElement) => deleted.some(([a, b]) => el.start! >= a && el.start! < b);
  for (const c of changes) {
    if (c.op !== "delete") continue;
    const info = find(c.src);
    if (!info || !isJsxParent(info.parent)) {
      failed.push(c);
      continue;
    }
    const [start, end] = lineRange(code, info.el.start!, info.el.end!);
    if (!goneEl(info.el)) s.remove(start, end); // inside a deleted element it is gone already
    deleted.push([start, end]);
    ok.push(c);
  }

  for (const c of changes) {
    if (c.op === "delete") continue;
    const info = c.op === "add" ? undefined : find(c.src);
    try {
      if (info && goneEl(info.el)) throw new Error("the element was deleted");
      switch (c.op) {
        case "setText": {
          if (!info || !setText(s, code, info.el, c.to)) throw new Error("text is not a single literal");
          ok.push(c);
          break;
        }
        case "setStyle": {
          if (!info) throw new Error("element not found");
          queue(editsFor(info.el).style, c.key, c.to, c);
          break;
        }
        case "setProp": {
          if (!info) throw new Error("element not found");
          queue(editsFor(info.el).props, reactPropName(c.key, tagOf(info.el)), c.to, c);
          break;
        }
        case "setHidden": {
          if (!info) throw new Error("element not found");
          queue(editsFor(info.el).props, "hidden", c.to ? "" : null, c);
          break;
        }
        case "reorder": {
          if (!info || !isJsxParent(info.parent)) throw new Error("not a child element");
          const sibling = (x: JsxElementInfo | undefined) => (x && x.el !== info.el && x.parent === info.parent ? x : undefined);
          const target = insertionPoint(code, sibling(find(c.anchor?.before)), sibling(find(c.anchor?.after)));
          if (!target || gone(target.pos)) throw new Error("no anchor among its siblings");
          const [start, end] = lineRange(code, info.el.start!, info.el.end!);
          s.move(start, end, target.pos);
          ok.push(c);
          break;
        }
        case "add": {
          const parent = find(c.src);
          // Neighbours count only when they sit right inside the same JSX parent.
          const inParent = (x: JsxElementInfo | undefined) =>
            x && (parent ? x.parent === parent.el : isJsxParent(x.parent)) ? x : undefined;
          // A neighbour rendered more than once (a list item from .map(), a shared component) means the new
          // element belongs to that logic, not as a hard-coded copy: the AI does it.
          if ([c.anchor?.before, c.anchor?.after].some((a) => a && repeated.has(a))) throw new Error("next to a repeated element");
          const before = inParent(find(c.anchor?.before));
          const after = inParent(find(c.anchor?.after));
          // It goes before something that isn't right here (in another file, deeper down): the end of the parent is the wrong place.
          if (c.anchor?.before && !before) throw new Error("the element it goes before isn't a sibling here");
          const unit = indentUnit(code);
          if (parent && goneEl(parent.el)) throw new Error("the parent was deleted");
          if (!before && !after && parent && !parent.el.closingElement) {
            // <div /> becomes <div>…</div>
            const open = parent.el.openingElement;
            const indent = lineIndent(code, open.start!);
            const markup = serializeJsx(c.nodes, c.nodes[0]!.id, indent + unit, unit, eol);
            s.overwrite(trimEndBefore(code, open.end! - 2, open.start!), open.end!, `>${eol}${indent}${unit}${markup}${eol}${indent}</${tagOf(parent.el)}>`);
            ok.push(c);
            break;
          }
          const target = insertionPoint(code, before, after, parent);
          if (!target || gone(target.pos)) throw new Error("no place to insert");
          const sib = before ?? after;
          const indent = sib ? lineIndent(code, sib.el.start!) : parent ? lineIndent(code, parent.el.start!) + unit : lineIndent(code, target.pos);
          const markup = serializeJsx(c.nodes, c.nodes[0]!.id, indent, unit, eol);
          s.appendLeft(target.pos, target.newlineFirst ? eol + indent + markup : indent + markup + eol);
          ok.push(c);
          break;
        }
        default:
          throw new Error("not patchable");
      }
    } catch {
      failed.push(c);
    }
  }

  for (const [el, e] of attrEdits) {
    try {
      if (goneEl(el)) throw new Error("the element was deleted");
      const done = writeAttrs(s, code, el, e, eol);
      ok.push(...done.ok);
      failed.push(...done.failed);
    } catch {
      // e.g. the element was deleted by another change in the list
      failed.push(...[...e.props.values(), ...e.style.values()].flatMap((x) => x.changes));
    }
  }

  return { after: s.toString(), ok: inOrder(changes, ok), failed: inOrder(changes, failed) };
}

/* ── text ────────────────────────────────────────────────────────────── */

function setText(s: MagicString, code: string, el: t.JSXElement, text: string): boolean {
  const kids = el.children;
  if (kids.some((k) => k.type === "JSXSpreadChild")) return false;
  const texts = kids.filter((k): k is t.JSXText => k.type === "JSXText" && k.value.trim() !== "");
  const exprs = kids.filter((k): k is t.JSXExpressionContainer => k.type === "JSXExpressionContainer" && k.expression.type !== "JSXEmptyExpression");
  const hasElements = kids.some((k) => k.type === "JSXElement" || k.type === "JSXFragment");

  if (texts.length === 1 && exprs.length === 0) {
    const node = texts[0]!;
    const raw = code.slice(node.start!, node.end!);
    // Keep the whitespace around the text (indentation, newlines) exactly as it was.
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    s.overwrite(node.start! + lead, node.end! - trail, jsxText(text));
    return true;
  }
  if (texts.length > 0 || hasElements) return false;
  if (exprs.length === 1) {
    // <button>{"Buy"}</button>: a string literal is text too. Anything else is logic.
    const e = exprs[0]!.expression;
    if (staticString(e) === undefined) return false;
    s.overwrite(e.start!, e.end!, quote(text, quoteOf(code, e) ?? '"'));
    return true;
  }
  if (exprs.length > 1) return false;
  const open = el.openingElement;
  if (!el.closingElement) {
    // <p /> becomes <p>text</p>
    s.overwrite(trimEndBefore(code, open.end! - 2, open.start!), open.end!, `>${jsxText(text)}</${tagOf(el)}>`);
    return true;
  }
  s.appendLeft(open.end!, jsxText(text));
  return true;
}

/** Text as a JSX child: as is when that's safe, else a string expression. */
function jsxText(text: string): string {
  // JSX text can't contain { } < >, decodes HTML entities, and collapses newlines and edge whitespace.
  if (/[{}<>]|&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|[\r\n]|^\s|\s$/i.test(text)) return `{${JSON.stringify(text)}}`;
  return text;
}

/* ── attributes and style ───────────────────────────────────────────── */

/** Attributes written without a value when set to "" (`<input disabled>`). */
const BOOLEAN_ATTRS = new Set([
  "allowFullScreen", "async", "autoFocus", "autoPlay", "checked", "controls", "default", "defer", "disabled",
  "formNoValidate", "hidden", "inert", "itemScope", "loop", "multiple", "muted", "noModule", "noValidate",
  "open", "playsInline", "readOnly", "required", "reversed", "selected",
]);

/** HTML attribute names (as the DOM reports them) → React prop names. */
const PROP_NAMES: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  contenteditable: "contentEditable",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  allowfullscreen: "allowFullScreen",
  crossorigin: "crossOrigin",
  srcset: "srcSet",
  srcdoc: "srcDoc",
  srclang: "srcLang",
  enctype: "encType",
  novalidate: "noValidate",
  formnovalidate: "formNoValidate",
  formaction: "formAction",
  formenctype: "formEncType",
  formmethod: "formMethod",
  formtarget: "formTarget",
  spellcheck: "spellCheck",
  accesskey: "accessKey",
  inputmode: "inputMode",
  enterkeyhint: "enterKeyHint",
  usemap: "useMap",
  datetime: "dateTime",
  playsinline: "playsInline",
  referrerpolicy: "referrerPolicy",
  hreflang: "hrefLang",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
  nomodule: "noModule",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  frameborder: "frameBorder",
  marginheight: "marginHeight",
  marginwidth: "marginWidth",
  "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv",
};

function reactPropName(attr: string, tag: string): string {
  if (PROP_NAMES[attr]) return PROP_NAMES[attr];
  if (/^(data|aria)-/.test(attr) || tag.includes("-")) return attr; // custom elements take attributes as written
  // SVG presentation attributes and namespaced ones: stroke-width → strokeWidth, xlink:href → xlinkHref.
  return attr.replace(/[-:]([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function attrName(a: t.JSXAttribute): string {
  return a.name.type === "JSXIdentifier" ? a.name.name : `${a.name.namespace.name}:${a.name.name.name}`;
}

/** The attribute a prop edit applies to: the React name, or the name as written (class, stroke-width). */
function findAttr(open: t.JSXOpeningElement, prop: string): t.JSXAttribute | undefined {
  const attrs = open.attributes.filter((a): a is t.JSXAttribute => a.type === "JSXAttribute");
  const exact = attrs.filter((a) => attrName(a) === prop).at(-1);
  if (exact) return exact;
  const raw = Object.entries(PROP_NAMES).find(([, v]) => v === prop)?.[0];
  return attrs.filter((a) => {
    const n = attrName(a);
    return n === raw || (n.includes("-") && reactPropName(n, "") === prop) || (n.includes(":") && reactPropName(n, "") === prop);
  }).at(-1);
}

/** A literal attribute value Glimpse may overwrite: bare, "…", {"…"}, {`…`}, {true}, {42}. */
function isStaticAttrValue(value: t.JSXAttribute["value"]): boolean {
  if (!value || value.type === "StringLiteral") return true;
  if (value.type !== "JSXExpressionContainer") return false;
  const e = value.expression;
  return staticString(e) !== undefined || e.type === "BooleanLiteral" || e.type === "NumericLiteral";
}

function staticString(e: t.Node): string | undefined {
  if (e.type === "StringLiteral") return e.value;
  if (e.type === "TemplateLiteral" && e.expressions.length === 0) return e.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function writeAttrs(s: MagicString, code: string, el: t.JSXElement, e: AttrEdits, eol: string): { ok: Change[]; failed: Change[] } {
  const ok: Change[] = [];
  const failed: Change[] = [];
  const open = el.openingElement;
  const removed = new Set<t.JSXAttribute>();
  const added: string[] = [];
  const preferSingle = prefersSingleQuotes(code);

  for (const [prop, { value, changes }] of e.props) {
    const attr = findAttr(open, prop);
    if (attr && !isStaticAttrValue(attr.value)) {
      failed.push(...changes); // the value is logic (an expression): the AI decides
      continue;
    }
    if (value === null) {
      if (attr) removed.add(attr);
    } else if (!attr) {
      added.push(formatJsxAttr(prop, value));
    } else if (value === "" && BOOLEAN_ATTRS.has(prop)) {
      if (attr.value) s.remove(attr.name.end!, attr.value.end!); // hidden={false} → hidden
    } else {
      const v = formatAttrValue(value);
      if (attr.value) s.overwrite(attr.value.start!, attr.value.end!, v);
      else s.appendLeft(attr.name.end!, `=${v}`);
    }
    ok.push(...changes);
  }

  if (e.style.size > 0) {
    const styleChanges = [...e.style.values()].flatMap((x) => x.changes);
    const attr = findAttr(open, "style");
    const edits = new Map([...e.style].map(([k, v]) => [k, v.value]));
    if (!attr) {
      const props = [...edits].filter(([, v]) => v !== null).map(([k, v]) => `${styleKey(k)}: ${quote(v!, preferSingle ? "'" : '"')}`);
      if (props.length) added.push(`style={{ ${props.join(", ")} }}`);
      ok.push(...styleChanges);
    } else {
      const obj = attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "ObjectExpression" ? attr.value.expression : null;
      const result = obj ? editStyleObject(s, code, obj, edits, eol, preferSingle) : "failed";
      if (result === "failed") failed.push(...styleChanges);
      else {
        if (result === "empty") removed.add(attr);
        ok.push(...styleChanges);
      }
    }
  }

  for (const attr of removed) {
    const [start, end] = attrRange(code, open, attr);
    s.remove(start, end);
  }

  if (added.length) {
    // After the last attribute that stays (on its own line when the tag is written one attribute per line).
    const kept = open.attributes.filter((a) => !(a.type === "JSXAttribute" && removed.has(a)));
    const last = kept.at(-1);
    const at = last ? last.end! : (open.typeParameters ?? open.name).end!;
    const ownLine = last && startsLine(code, last.start!) && lineOf(code, last.start!) !== lineOf(code, open.start!);
    const indent = last ? lineIndent(code, last.start!) : "";
    s.appendLeft(at, added.map((a) => (ownLine ? `${eol}${indent}${a}` : ` ${a}`)).join(""));
  }
  return { ok, failed };
}

/** `name="value"`, or just `name` for a boolean attribute set to "". */
function formatJsxAttr(prop: string, value: string): string {
  return value === "" && BOOLEAN_ATTRS.has(prop) ? prop : `${prop}=${formatAttrValue(value)}`;
}

function formatAttrValue(v: string): string {
  // JSX attribute strings have no escapes, decode HTML entities and fold newlines.
  const risky = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|[\r\n]/i.test(v);
  if (!risky && !v.includes('"')) return `"${v}"`;
  if (!risky && !v.includes("'")) return `'${v}'`;
  return `{${JSON.stringify(v)}}`;
}

/** Remove an attribute with the whitespace before it (its whole line when it has one to itself). */
function attrRange(code: string, open: t.JSXOpeningElement, attr: t.JSXAttribute | t.JSXSpreadAttribute): [number, number] {
  const line = wholeLines(code, attr.start!, attr.end!, false);
  if (line) return line;
  let start = attr.start!;
  while (start > open.start! && /\s/.test(code[start - 1]!)) start--;
  return [start, attr.end!];
}

/** CSS property → React style key: background-color → backgroundColor, -webkit-x → WebkitX, --x stays. */
function cssToCamel(key: string): string {
  if (key.startsWith("--")) return key;
  const k = key.startsWith("-ms-") ? key.slice(1) : key;
  return k.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function styleKey(cssKey: string): string {
  const k = cssToCamel(cssKey);
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function propKeyName(p: t.ObjectProperty): string | undefined {
  const k = p.key;
  if (!p.computed && k.type === "Identifier") return k.name;
  if (k.type === "StringLiteral") return k.value;
  return undefined;
}

/**
 * Edit `style={{ … }}` in place: set or remove keys, keeping the layout
 * (one per line or inline), comments and the quote style. "empty" when no
 * key is left, so the caller removes the whole attribute.
 */
function editStyleObject(
  s: MagicString,
  code: string,
  obj: t.ObjectExpression,
  edits: Map<string, string | null>,
  eol: string,
  preferSingle: boolean,
): "ok" | "empty" | "failed" {
  const props = obj.properties;
  const hasSpread = props.some((p) => p.type === "SpreadElement");
  const removed = new Set<t.Node>();
  const updates: [t.Node, string][] = [];
  const added: string[] = [];
  const q = quoteOf(code, props.find((p) => p.type === "ObjectProperty" && p.value.type === "StringLiteral") ?? null) ?? (preferSingle ? "'" : '"');

  for (const [cssKey, value] of edits) {
    const names = new Set([cssToCamel(cssKey), cssKey]);
    const matches = props.filter((p): p is t.ObjectProperty => p.type === "ObjectProperty" && names.has(propKeyName(p) ?? "\0"));
    if (value === null) {
      if (matches.length === 0 && hasSpread) return "failed"; // might come from the spread
      for (const m of matches) removed.add(m);
      continue;
    }
    const target = matches.at(-1);
    if (!target) {
      added.push(`${styleKey(cssKey)}: ${quote(value, q)}`);
      continue;
    }
    const v = target.value;
    const literal = staticString(v) !== undefined || v.type === "NumericLiteral" || (v.type === "UnaryExpression" && v.argument.type === "NumericLiteral");
    if (!literal) return "failed"; // e.g. color: theme.primary
    updates.push([v, quote(value, v.type === "StringLiteral" ? (quoteOf(code, v) ?? q) : q)]);
  }

  const kept = props.filter((p) => !removed.has(p));
  if (kept.length === 0 && added.length === 0) return "empty";
  if (kept.length === 0) {
    s.overwrite(obj.start!, obj.end!, `{ ${added.join(", ")} }`);
    return "ok";
  }

  for (const [node, text] of updates) s.overwrite(node.start!, node.end!, text);

  // Removals: whole lines when the key has its line to itself, else the key and its comma.
  const ranges: [number, number][] = [];
  props.forEach((p, i) => {
    if (!removed.has(p)) return;
    const line = wholeLines(code, p.start!, p.end!, true);
    if (line) return void ranges.push(line);
    const next = props.slice(i + 1).find((x) => !removed.has(x));
    if (next) return void ranges.push([p.start!, next.start!]);
    const prev = props.slice(0, i).reverse().find((x) => !removed.has(x))!;
    ranges.push([prev.end!, p.end!]);
  });
  for (const [a, b] of mergeRanges(ranges)) s.remove(a, b);

  if (added.length) {
    const last = kept.at(-1)!;
    const closeLine = lineStart(code, obj.end! - 1);
    const multiline = startsLine(code, obj.end! - 1) && startsLine(code, last.start!) && lineOf(code, last.start!) !== lineOf(code, obj.start!);
    if (multiline) {
      const indent = lineIndent(code, last.start!);
      const trailing = /^\s*,/.test(code.slice(props.at(-1)!.end!, obj.end!));
      if (!/^[ \t]*,/.test(code.slice(last.end!, obj.end!))) s.appendLeft(last.end!, ",");
      const lines = added.map((a, i) => `${indent}${a}${i < added.length - 1 || trailing ? "," : ""}${eol}`);
      s.appendRight(closeLine, lines.join(""));
    } else {
      s.appendLeft(last.end!, `, ${added.join(", ")}`);
    }
  }
  return "ok";
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function quote(value: string, q: string): string {
  if (q === "'") return `'${JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
  return JSON.stringify(value);
}

function quoteOf(code: string, node: t.Node | null): "'" | '"' | undefined {
  if (!node) return undefined;
  const n = node.type === "ObjectProperty" ? node.value : node;
  const ch = code[n.start!];
  return ch === "'" ? "'" : ch === '"' ? '"' : undefined;
}

/** Whether the file writes JS strings with single quotes (judged from its imports). */
function prefersSingleQuotes(code: string): boolean {
  const single = (code.match(/\bfrom\s+'/g) ?? []).length;
  const double = (code.match(/\bfrom\s+"/g) ?? []).length;
  return single > double;
}

/* ── structure ───────────────────────────────────────────────────────── */

function isJsxParent(node: t.Node | null): boolean {
  return node?.type === "JSXElement" || node?.type === "JSXFragment";
}

function tagOf(el: t.JSXElement): string {
  const n = el.openingElement.name;
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXNamespacedName") return `${n.namespace.name}:${n.name.name}`;
  const parts: string[] = [];
  let cur: t.JSXMemberExpression | t.JSXIdentifier = n;
  while (cur.type === "JSXMemberExpression") {
    parts.unshift(cur.property.name);
    cur = cur.object as t.JSXMemberExpression | t.JSXIdentifier;
  }
  parts.unshift(cur.name);
  return parts.join(".");
}

/**
 * The element's range, widened to whole lines when it sits alone on its line(s),
 * so deleting or moving it doesn't leave blank lines behind.
 */
function lineRange(code: string, startOffset: number, endOffset: number): [number, number] {
  let start = startOffset;
  while (start > 0 && (code[start - 1] === " " || code[start - 1] === "\t")) start--;
  const aloneStart = start === 0 || code[start - 1] === "\n";
  let end = endOffset;
  while (end < code.length && (code[end] === " " || code[end] === "\t")) end++;
  if (code[end] === "\r") end++;
  const aloneEnd = end >= code.length || code[end] === "\n";
  if (aloneStart && aloneEnd) return [start, Math.min(end + 1, code.length)];
  return [startOffset, endOffset];
}

/**
 * [start, end) widened to whole lines when it has its line(s) to itself, allowing
 * a trailing comma (`withComma`) and a line comment after it; null otherwise.
 */
function wholeLines(code: string, start: number, end: number, withComma: boolean): [number, number] | null {
  let a = start;
  while (a > 0 && (code[a - 1] === " " || code[a - 1] === "\t")) a--;
  if (a > 0 && code[a - 1] !== "\n") return null;
  const tail = (withComma ? /^[ \t]*,?[ \t]*(?:\/\/[^\r\n]*)?\r?\n/ : /^[ \t]*\r?\n/).exec(code.slice(end, end + 1000));
  return tail ? [a, end + tail[0].length] : null;
}

/** Where to put an element: before its "before" neighbour, after its "after" neighbour, or at the end of the parent. */
function insertionPoint(
  code: string,
  before: JsxElementInfo | undefined,
  after: JsxElementInfo | undefined,
  parent?: JsxElementInfo,
): { pos: number; newlineFirst: boolean } | null {
  if (before) {
    const [start] = lineRange(code, before.el.start!, before.el.end!);
    return { pos: start, newlineFirst: start === before.el.start! };
  }
  if (after) {
    const [, end] = lineRange(code, after.el.start!, after.el.end!);
    return { pos: end, newlineFirst: end === after.el.end! };
  }
  const close = parent?.el.closingElement;
  if (close) {
    // On a new line just before the parent's closing tag.
    let pos = close.start!;
    while (pos > 0 && (code[pos - 1] === " " || code[pos - 1] === "\t")) pos--;
    return { pos, newlineFirst: !(pos === 0 || code[pos - 1] === "\n") };
  }
  return null;
}

function lineStart(code: string, offset: number): number {
  return code.lastIndexOf("\n", offset - 1) + 1;
}

function lineOf(code: string, offset: number): number {
  let n = 0;
  for (let i = code.indexOf("\n"); i !== -1 && i < offset; i = code.indexOf("\n", i + 1)) n++;
  return n;
}

function lineIndent(code: string, offset: number): string {
  return /^[ \t]*/.exec(code.slice(lineStart(code, offset)))![0];
}

/** Whether only whitespace precedes `offset` on its line. */
function startsLine(code: string, offset: number): boolean {
  return /^[ \t]*$/.test(code.slice(lineStart(code, offset), offset));
}

/** Step back from `pos` over whitespace (not past `min`): where "/>" really starts after the last attribute. */
function trimEndBefore(code: string, pos: number, min: number): number {
  let p = pos;
  while (p > min && /\s/.test(code[p - 1]!)) p--;
  return p;
}

function indentUnit(code: string): string {
  return /\n(\t| +)\S/.exec(code)?.[1] ?? "  ";
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Turn added scene nodes into JSX: className, style={{ camelCase: "value" }}, void elements self-closing. */
function serializeJsx(nodes: SceneNode[], id: string, indent: string, unit: string, eol: string): string {
  const n = nodes.find((x) => x.id === id)!;
  const tag = n.tag && /^[a-z][a-z0-9-]*$/.test(n.tag) ? n.tag : "div";
  const attrs: string[] = [];
  for (const [k, v] of Object.entries(n.props)) {
    if (k === "text" || k === SRC_ATTR || k === "style") continue;
    const prop = reactPropName(k, tag);
    if (!/^[A-Za-z_$][\w$-]*$/.test(prop)) continue; // not expressible as a JSX attribute
    attrs.push(` ${formatJsxAttr(prop, v)}`);
  }
  if (n.hidden && !("hidden" in n.props)) attrs.push(" hidden");
  const style = Object.entries(n.style).map(([k, v]) => `${styleKey(k)}: ${JSON.stringify(v)}`);
  if (style.length) attrs.push(` style={{ ${style.join(", ")} }}`);
  const open = `<${tag}${attrs.join("")}`;
  if (VOID.has(tag)) return `${open} />`;
  const text = n.props.text ? jsxText(n.props.text) : "";
  if (n.children.length === 0) return text ? `${open}>${text}</${tag}>` : `${open} />`;
  const inner = n.children.map((c) => indent + unit + serializeJsx(nodes, c, indent + unit, unit, eol)).join(eol);
  return `${open}>${text}${eol}${inner}${eol}${indent}</${tag}>`;
}
