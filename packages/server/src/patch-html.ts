import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import MagicString from "magic-string";
import { createTwoFilesPatch } from "diff";
import type { Change, SceneNode } from "@glimpse/core";
import { parseWithLocations, walkElements, type Element } from "./instrument.js";

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

/** Ops that are pure editor state and never touch code. */
const EDITOR_ONLY = new Set(["setLocked"]);

/**
 * Work out how to write `changes` into the project's HTML files. Nothing is
 * written here; `applyPatch` does that after the human approves the diff.
 */
export async function planPatch(dir: string, changes: Change[]): Promise<PatchPlan> {
  const applied: Change[] = [];
  const needsAi: Change[] = [];
  const byFile = new Map<string, Change[]>();

  for (const c of changes) {
    if (EDITOR_ONLY.has(c.op)) continue;
    const file = patchable(c);
    if (!file) {
      needsAi.push(c);
      continue;
    }
    byFile.set(file, [...(byFile.get(file) ?? []), c]);
  }

  const files: FilePatch[] = [];
  for (const [file, fileChanges] of byFile) {
    const path = normalize(join(dir, file));
    if (!(path === dir || path.startsWith(dir + sep)) || !/\.html?$/i.test(file)) {
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
    const { after, ok, failed } = patchHtml(before, fileChanges);
    applied.push(...ok);
    needsAi.push(...failed);
    if (after !== before) files.push({ file, before, after, diff: createTwoFilesPatch(file, file, before, after, "", "", { context: 3 }) });
  }

  // Keep the original order of the change list.
  const order = new Map(changes.map((c, i) => [c, i]));
  const sort = (xs: Change[]) => xs.sort((a, b) => order.get(a)! - order.get(b)!);
  return { files, applied: sort(applied), needsAi: sort(needsAi) };
}

/** Which file a change would be written to, or null when it needs the AI. */
function patchable(c: Change): string | null {
  switch (c.op) {
    case "setText":
    case "setStyle":
    case "setProp":
    case "setHidden":
    case "delete":
    case "add":
    case "reorder":
      return c.src ? parseLoc(c.src)?.file ?? null : null;
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

/**
 * Apply changes to one HTML file's text. Edits are made in place with
 * magic-string, so formatting, comments and everything else stay as they were.
 */
export function patchHtml(html: string, changes: Change[]): { after: string; ok: Change[]; failed: Change[] } {
  const doc = parseWithLocations(html);
  const els = new Map<string, Element>();
  walkElements(doc, (el) => {
    const l = el.sourceCodeLocation!;
    els.set(`${l.startLine}:${l.startCol}`, el);
  });
  const find = (src?: string) => {
    const l = src ? parseLoc(src) : null;
    return l ? els.get(`${l.line}:${l.col}`) : undefined;
  };

  const s = new MagicString(html);
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const ok: Change[] = [];
  const failed: Change[] = [];

  // Attribute edits are grouped per element so several edits to one start tag don't collide.
  const attrEdits = new Map<Element, { attrs: Map<string, string | null>; style: Map<string, string | null>; changes: Change[] }>();
  const attrsFor = (el: Element) => {
    let e = attrEdits.get(el);
    if (!e) attrEdits.set(el, (e = { attrs: new Map(), style: new Map(), changes: [] }));
    return e;
  };

  for (const c of changes) {
    const el = c.op === "add" ? undefined : find(c.src);
    try {
      switch (c.op) {
        case "setText": {
          if (!el || !setText(s, html, el, c.to)) throw new Error("text is spread over several nodes");
          ok.push(c);
          break;
        }
        case "setStyle": {
          if (!el) throw new Error("element not found");
          const e = attrsFor(el);
          e.style.set(c.key, c.to);
          e.changes.push(c);
          break;
        }
        case "setProp": {
          if (!el) throw new Error("element not found");
          const e = attrsFor(el);
          e.attrs.set(c.key, c.to);
          e.changes.push(c);
          break;
        }
        case "setHidden": {
          if (!el) throw new Error("element not found");
          const e = attrsFor(el);
          e.attrs.set("hidden", c.to ? "" : null);
          e.changes.push(c);
          break;
        }
        case "delete": {
          if (!el) throw new Error("element not found");
          const [start, end] = lineRange(html, el);
          s.remove(start, end);
          ok.push(c);
          break;
        }
        case "reorder": {
          if (!el) throw new Error("element not found");
          const target = insertionPoint(html, c.anchor, find, el);
          if (target === null) throw new Error("no anchor");
          const [start, end] = lineRange(html, el);
          s.move(start, end, target.pos);
          ok.push(c);
          break;
        }
        case "add": {
          const parent = find(c.src);
          const target = insertionPoint(html, c.anchor, find, undefined, parent);
          if (target === null) throw new Error("no place to insert");
          const indent = indentAt(html, target.pos ?? 0, parent, find(c.anchor?.after ?? c.anchor?.before));
          const markup = serialize(c.nodes, c.nodes[0]!.id, indent, eol);
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
      writeAttrs(s, html, el, e.attrs, e.style);
      ok.push(...e.changes);
    } catch {
      failed.push(...e.changes);
    }
  }

  return { after: s.toString(), ok, failed };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function setText(s: MagicString, html: string, el: Element, text: string): boolean {
  const texts = el.childNodes.filter((n) => n.nodeName === "#text" && "value" in n && n.value.trim() !== "");
  const hasElements = el.childNodes.some((n) => "tagName" in n);
  if (texts.length > 1) return false;
  const escaped = escapeText(text);
  if (texts.length === 0) {
    if (hasElements) return false;
    const loc = el.sourceCodeLocation!;
    if (!loc.startTag) return false;
    s.appendLeft(loc.startTag.endOffset, escaped);
    return true;
  }
  const loc = texts[0]!.sourceCodeLocation!;
  const raw = html.slice(loc.startOffset, loc.endOffset);
  // Keep the whitespace around the text (indentation, newlines) exactly as it was.
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  s.overwrite(loc.startOffset + lead, loc.endOffset - trail, escaped);
  return true;
}

function writeAttrs(s: MagicString, html: string, el: Element, attrs: Map<string, string | null>, style: Map<string, string | null>): void {
  const loc = el.sourceCodeLocation!;
  const tag = loc.startTag!;
  const attrLocs = loc.attrs ?? {};
  const tagText = html.slice(tag.startOffset, tag.endOffset);
  const insertAt = tag.endOffset - (tagText.endsWith("/>") ? 2 : 1);

  if (style.size > 0) {
    const current = el.attrs.find((a) => a.name === "style")?.value ?? "";
    const decls = parseStyle(current);
    for (const [k, v] of style) {
      if (v === null) decls.delete(k);
      else decls.set(k, v);
    }
    const value = [...decls].map(([k, v]) => `${k}: ${v}`).join("; ");
    attrs.set("style", value === "" ? null : value);
  }

  for (const [name, value] of attrs) {
    const existing = attrLocs[name];
    if (existing) {
      if (value === null) {
        // Remove the attribute together with the whitespace before it.
        let start = existing.startOffset;
        while (start > tag.startOffset && /\s/.test(html[start - 1]!)) start--;
        s.remove(start, existing.endOffset);
      } else {
        s.overwrite(existing.startOffset, existing.endOffset, formatAttr(name, value));
      }
    } else if (value !== null) {
      // appendRight attaches to the ">" so an overwrite of the attribute before it can't swallow it.
      s.appendRight(insertAt, ` ${formatAttr(name, value)}`);
    }
  }
}

function formatAttr(name: string, value: string): string {
  return value === "" ? name : `${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

function parseStyle(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of splitDeclarations(css)) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

/** Split a declaration list on its `;`s, but not those inside quotes, parentheses (`url(data:…;base64,…)`) or escapes. */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") i++;
    else if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/**
 * The element's range, widened to whole lines when it sits alone on its line(s),
 * so deleting or moving it doesn't leave blank lines behind.
 */
function lineRange(html: string, el: Element): [number, number] {
  const { startOffset, endOffset } = el.sourceCodeLocation!;
  let start = startOffset;
  while (start > 0 && (html[start - 1] === " " || html[start - 1] === "\t")) start--;
  const aloneStart = start === 0 || html[start - 1] === "\n";
  let end = endOffset;
  while (end < html.length && (html[end] === " " || html[end] === "\t")) end++;
  if (html[end] === "\r") end++;
  const aloneEnd = end >= html.length || html[end] === "\n";
  if (aloneStart && aloneEnd) return [start, Math.min(end + 1, html.length)];
  return [startOffset, endOffset];
}

/** Where to put an element: before its "before" neighbour, after its "after" neighbour, or at the end of the parent. */
function insertionPoint(
  html: string,
  anchor: Change["anchor"],
  find: (src?: string) => Element | undefined,
  moving?: Element,
  parent?: Element,
): { pos: number; newlineFirst: boolean } | null {
  const before = find(anchor?.before);
  if (before && before !== moving) {
    const [start] = lineRange(html, before);
    const lineStart = start !== before.sourceCodeLocation!.startOffset;
    return { pos: start, newlineFirst: !lineStart };
  }
  const after = find(anchor?.after);
  if (after && after !== moving) {
    const [, end] = lineRange(html, after);
    const lineEnd = end !== after.sourceCodeLocation!.endOffset;
    return lineEnd ? { pos: end, newlineFirst: false } : { pos: end, newlineFirst: true };
  }
  const endTag = parent?.sourceCodeLocation?.endTag;
  if (endTag) {
    // Insert on a new line just before the parent's closing tag.
    let pos = endTag.startOffset;
    while (pos > 0 && (html[pos - 1] === " " || html[pos - 1] === "\t")) pos--;
    return { pos, newlineFirst: !(pos === 0 || html[pos - 1] === "\n") };
  }
  return null;
}

function indentAt(html: string, pos: number, parent: Element | undefined, sibling: Element | undefined): string {
  const lineIndent = (offset: number) => {
    const lineStart = html.lastIndexOf("\n", offset - 1) + 1;
    return /^[ \t]*/.exec(html.slice(lineStart))![0];
  };
  if (sibling) return lineIndent(sibling.sourceCodeLocation!.startOffset);
  if (parent) {
    const unit = /\n(\t| +)\S/.exec(html)?.[1] ?? "  ";
    return lineIndent(parent.sourceCodeLocation!.startOffset) + unit;
  }
  return lineIndent(pos);
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Turn added scene nodes back into HTML. */
function serialize(nodes: SceneNode[], id: string, indent: string, eol: string): string {
  const n = nodes.find((x) => x.id === id)!;
  const tag = n.tag ?? "div";
  const attrs = Object.entries(n.props)
    .filter(([k]) => k !== "text" && k !== "data-glimpse-src")
    .map(([k, v]) => ` ${formatAttr(k, v)}`)
    .join("");
  const style = Object.entries(n.style).map(([k, v]) => `${k}: ${v}`).join("; ");
  const open = `<${tag}${attrs}${style ? ` ${formatAttr("style", style)}` : ""}>`;
  if (VOID.has(tag)) return open;
  const text = n.props.text ? escapeText(n.props.text) : "";
  if (n.children.length === 0) return `${open}${text}</${tag}>`;
  const inner = n.children.map((c) => indent + "  " + serialize(nodes, c, indent + "  ", eol)).join(eol);
  return `${open}${text}${eol}${inner}${eol}${indent}</${tag}>`;
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
