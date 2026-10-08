import MagicString, { type SourceMap } from "magic-string";
import { isHostName, parseModule, SRC_ATTR, walk } from "./jsx-ast.js";

export interface InstrumentJsxOptions {
  /** Source name written into the source map (default: `file`). Vite passes the module id. */
  source?: string;
}

/**
 * Tag every host JSX element (`<div>`, `<button>`, …) with
 * `data-glimpse-src="file:line:col"` so the editor knows where each rendered
 * DOM element lives in the source. `line` and `col` are 1-based and point at
 * the element's "<", like the HTML instrumentation. Components, member
 * expressions (`motion.div`), namespaced names and fragments are left alone:
 * they don't render a DOM element of their own.
 *
 * Returns null when nothing changed (no host JSX, or code that doesn't parse).
 */
export function instrumentJsx(code: string, file: string, options: InstrumentJsxOptions = {}): { code: string; map: SourceMap } | null {
  if (!code.includes("<")) return null;
  const ast = parseModule(code, file);
  if (!ast) return null;
  const name = file.split("\\").join("/");
  // JSX attribute strings decode HTML entities, so escape the two that matter.
  const value = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const s = new MagicString(code);
  let changed = false;

  walk(ast.program, (node) => {
    if (node.type !== "JSXOpeningElement" || !isHostName(node.name)) return;
    const tagged = node.attributes.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === SRC_ATTR);
    if (tagged) return;
    const start = node.loc!.start;
    // Right after the tag name (and type arguments, if any): `<button` → `<button data-glimpse-src="…"`.
    const after = (node.typeParameters ?? node.typeArguments ?? node.name).end!;
    s.appendLeft(after, ` ${SRC_ATTR}="${value}:${start.line}:${start.column + 1}"`);
    changed = true;
  });

  if (!changed) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true, source: options.source ?? name, includeContent: true }) };
}
