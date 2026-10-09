import { parse, type ParserPlugin } from "@babel/parser";
import type * as t from "@babel/types";

/** Added to every host JSX element: where it lives in source ("file:line:col", 1-based, at the "<"). */
export const SRC_ATTR = "data-glimpse-src";

/** Files Glimpse reads JSX from (and writes Edit source into). */
export const JSX_FILE = /\.[jt]sx?$/i;

function parserPlugins(file: string): ParserPlugin[] {
  return /\.tsx?$/i.test(file) ? ["jsx", "typescript"] : ["jsx"];
}

/** Parse a module with exact offsets; null when it isn't valid (JSX) source. */
export function parseModule(code: string, file: string): t.File | null {
  try {
    return parse(code, { sourceType: "module", plugins: parserPlugins(file), errorRecovery: false });
  } catch {
    return null;
  }
}

const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);

function isNode(v: unknown): v is t.Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/**
 * Visit every node under `root` with its parent. Iterative, so very deep
 * trees (long JSX, long expression chains) can't overflow the stack.
 */
export function walk(root: t.Node, visit: (node: t.Node, parent: t.Node | null) => void): void {
  const stack: [t.Node, t.Node | null][] = [[root, null]];
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    visit(node, parent);
    const record = node as unknown as Record<string, unknown>;
    const children: t.Node[] = [];
    for (const key of Object.keys(record)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = record[key];
      if (Array.isArray(value)) {
        for (const v of value) if (isNode(v)) children.push(v);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    // Reversed so nodes are visited in source order.
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, node]);
  }
}

/**
 * Host DOM elements (`div`, `button`, `my-element`): a plain JSX name starting
 * lowercase. Components (`Button`), member expressions (`motion.div`),
 * namespaced names (`svg:rect`) and fragments are not.
 */
export function isHostName(name: t.JSXOpeningElement["name"]): name is t.JSXIdentifier {
  return name.type === "JSXIdentifier" && /^[a-z]/.test(name.name) && name.name !== "this";
}

/** The "line:col" key of a JSX element: 1-based, pointing at its "<" (what instrumentJsx writes). */
function locKey(node: t.Node): string {
  const start = node.loc!.start;
  return `${start.line}:${start.column + 1}`;
}

export interface JsxElementInfo {
  el: t.JSXElement;
  /** The node the element sits in: a JSXElement or JSXFragment when it is a child, anything else otherwise. */
  parent: t.Node | null;
}

/** Every JSX element in the file, by the "line:col" of its opening "<". */
export function indexElements(ast: t.File): Map<string, JsxElementInfo> {
  const out = new Map<string, JsxElementInfo>();
  walk(ast.program, (node, parent) => {
    if (node.type === "JSXElement") out.set(locKey(node), { el: node, parent });
  });
  return out;
}
