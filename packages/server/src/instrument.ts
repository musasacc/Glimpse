import MagicString from "magic-string";
import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export type Document = DefaultTreeAdapterMap["document"];

const SKIP = new Set(["script", "style", "template", "noscript"]);

/** Parse HTML keeping exact source offsets for every element. */
export function parseWithLocations(html: string): Document {
  return parse(html, { sourceCodeLocationInfo: true });
}

/** Depth-first walk over every element that really appears in the source (not implied by the parser). */
export function walkElements(root: Node, visit: (el: Element) => void): void {
  const children = "childNodes" in root ? root.childNodes : [];
  for (const child of children) {
    if (!("tagName" in child)) continue;
    if (child.sourceCodeLocation?.startTag) visit(child);
    if (!SKIP.has(child.tagName)) walkElements(child, visit);
  }
}

/**
 * Tag every element inside <body> with `data-glimpse-src="file:line:col"` so the
 * editor knows where each element lives in the source. The original markup is
 * left untouched apart from the inserted attribute.
 */
export function instrumentHtml(html: string, file: string): string {
  const doc = parseWithLocations(html);
  const s = new MagicString(html);
  const htmlEl = doc.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "html");
  const body = htmlEl?.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "body");
  if (!body) return html;
  // Escaped for the attribute: a file named `a"b.html` must not end the attribute (the browser decodes it back).
  const name = file.split("\\").join("/").replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const tag = (el: Element) => {
    const loc = el.sourceCodeLocation!;
    const start = loc.startTag!;
    if (SKIP.has(el.tagName) || el.attrs.some((a) => a.name === "data-glimpse-src")) return;
    // Insert right after the tag name: `<button` → `<button data-glimpse-src="…"`.
    const tagName = /^<([A-Za-z][\w:-]*)/.exec(html.slice(start.startOffset, start.startOffset + 64));
    if (!tagName) return;
    s.appendLeft(start.startOffset + 1 + tagName[1]!.length, ` data-glimpse-src="${name}:${loc.startLine}:${loc.startCol}"`);
  };
  // <body> itself too (when written out), so new elements can be appended to the page.
  if (body.sourceCodeLocation?.startTag) tag(body);
  walkElements(body, tag);
  return s.toString();
}
