import { describe, expect, it } from "vitest";
import { createScene, diffScenes, MOVED_ANCHOR, OpLog, type Change, type Scene } from "@glimpse/core";
import { instrumentHtml } from "./instrument.js";
import { patchHtml } from "./patch-html.js";

const PAGE = `<!doctype html>
<html>
  <body>
    <h1 class="title">Donut Shop</h1>
    <nav class="buttons">
      <button class="btn">Glazed</button>
      <button class="btn">Chocolate</button>
      <button class="btn" style="color: red">Maple</button>
    </nav>
  </body>
</html>
`;

const h1 = "index.html:4:5";
const nav = "index.html:5:5";
const glazed = "index.html:6:7";
const choc = "index.html:7:7";
const maple = "index.html:8:7";

function patch(...changes: Change[]) {
  return patchHtml(PAGE, changes);
}

describe("instrumentHtml", () => {
  it("tags every body element with its source location, leaving the rest untouched", () => {
    const out = instrumentHtml(PAGE, "index.html");
    expect(out).toContain(`<h1 data-glimpse-src="${h1}" class="title">Donut Shop</h1>`);
    expect(out).toContain(`<button data-glimpse-src="${maple}" class="btn" style="color: red">Maple</button>`);
    expect(out.replace(/ data-glimpse-src="[^"]*"/g, "")).toBe(PAGE);
  });

  it("uses forward slashes for nested files on every OS", () => {
    expect(instrumentHtml("<body><p>x</p></body>", "pages\\about.html")).toContain('data-glimpse-src="pages/about.html:1:7"');
  });

  it("escapes the file name in the attribute", () => {
    const out = instrumentHtml("<body><p>x</p></body>", 'a"b<c>&.html');
    expect(out).toContain('<p data-glimpse-src="a&#34;b&#60;c&#62;&#38;.html:1:7">x</p>');
  });
});

describe("patchHtml", () => {
  it("changes text in place", () => {
    const { after, ok } = patch({ op: "setText", node: "a", src: glazed, from: "Glazed", to: "Honey <Glazed>" });
    expect(after).toContain('<button class="btn">Honey &lt;Glazed&gt;</button>');
    expect(ok).toHaveLength(1);
  });

  it("adds, edits and removes inline styles and attributes in one start tag", () => {
    const { after } = patch(
      { op: "setStyle", node: "m", src: maple, key: "background", from: null, to: "pink" },
      { op: "setStyle", node: "m", src: maple, key: "color", from: "red", to: null },
      { op: "setProp", node: "m", src: maple, key: "title", from: null, to: 'say "hi"' },
      { op: "setHidden", node: "g", src: glazed, from: false, to: true },
    );
    expect(after).toContain('<button class="btn" style="background: pink" title="say &quot;hi&quot;">Maple</button>');
    expect(after).toContain('<button class="btn" hidden>Glazed</button>');
  });

  it("keeps declarations whose values contain semicolons (data URLs, quoted strings)", () => {
    const page = `<body>\n<p style="background: url('data:image/png;base64,AAAA'); content: &quot;a;b&quot;; color: red">x</p>\n</body>`;
    const { after } = patchHtml(page, [{ op: "setStyle", node: "p", src: "index.html:2:1", key: "color", from: "red", to: "blue" }]);
    expect(after).toContain(`<p style="background: url('data:image/png;base64,AAAA'); content: &quot;a;b&quot;; color: blue">x</p>`);
  });

  it("removes the style attribute when it becomes empty", () => {
    const { after } = patch({ op: "setStyle", node: "m", src: maple, key: "color", from: "red", to: null });
    expect(after).toContain('<button class="btn">Maple</button>');
  });

  it("deletes an element without leaving a blank line", () => {
    const { after } = patch({ op: "delete", parent: "nav", index: 1, nodes: [], src: choc });
    expect(after).toBe(PAGE.replace('      <button class="btn">Chocolate</button>\n', ""));
  });

  it("inserts a new element between its neighbours with matching indentation", () => {
    const { after } = patch({
      op: "add",
      parent: "nav",
      index: 1,
      src: nav,
      anchor: { after: glazed, before: choc },
      nodes: [{ id: "n", type: "button", tag: "button", parent: "nav", children: [], layout: { x: 0, y: 0, w: 0, h: 0 }, style: {}, props: { class: "btn", text: "Sprinkles" } }],
    });
    expect(after).toContain(
      '      <button class="btn">Glazed</button>\n      <button class="btn">Sprinkles</button>\n      <button class="btn">Chocolate</button>\n',
    );
  });

  it("appends inside the parent when there are no neighbours", () => {
    const { after } = patchHtml("<body>\n  <nav>\n  </nav>\n</body>\n", [
      {
        op: "add",
        parent: "nav",
        index: 0,
        src: "index.html:2:3",
        nodes: [{ id: "n", type: "text", tag: "p", parent: "nav", children: [], layout: { x: 0, y: 0, w: 0, h: 0 }, style: { color: "red" }, props: { text: "Hi" } }],
      },
    ]);
    expect(after).toBe('<body>\n  <nav>\n    <p style="color: red">Hi</p>\n  </nav>\n</body>\n');
  });

  it("moves an element to its new place among its siblings", () => {
    const { after } = patch({
      op: "reorder",
      node: "m",
      src: maple,
      from: { parent: "nav", index: 2 },
      to: { parent: "nav", index: 0 },
      anchor: { before: glazed },
    });
    expect(after).toContain(
      '<nav class="buttons">\n      <button class="btn" style="color: red">Maple</button>\n      <button class="btn">Glazed</button>\n      <button class="btn">Chocolate</button>\n    </nav>',
    );
  });

  it("reverses a list (A B C → C B A) in the right order", () => {
    const base: Scene = createScene("html");
    base.nodes.nav = { id: "nav", type: "nav", tag: "nav", parent: "root", children: ["g", "c", "m"], layout: { x: 0, y: 0, w: 300, h: 40 }, style: {}, props: {}, source: { file: "index.html", line: 5, col: 5 } };
    base.nodes.root!.children.push("nav");
    ["g", "c", "m"].forEach((id, i) => {
      base.nodes[id] = { id, type: "button", tag: "button", parent: "nav", children: [], layout: { x: i * 100, y: 0, w: 100, h: 40 }, style: {}, props: {}, source: { file: "index.html", line: 6 + i, col: 7 } };
    });
    const log = new OpLog(base);
    log.apply({ op: "reorder", node: "m", from: { parent: "nav", index: 2 }, to: { parent: "nav", index: 0 } });
    log.apply({ op: "reorder", node: "c", from: { parent: "nav", index: 2 }, to: { parent: "nav", index: 1 } });
    expect(log.scene.nodes.nav!.children).toEqual(["m", "c", "g"]);
    const changes = diffScenes(log.base, log.scene);
    const { after, ok, failed } = patchHtml(PAGE, changes);
    expect(failed).toEqual([]);
    expect(ok).toHaveLength(2);
    expect(after).toContain(
      '<nav class="buttons">\n      <button class="btn" style="color: red">Maple</button>\n      <button class="btn">Chocolate</button>\n      <button class="btn">Glazed</button>\n    </nav>',
    );
  });

  it("leaves reorders anchored to another moved element to the AI, never writing a wrong order", () => {
    // Anchors to neighbours that move too (as older editors sent them): C before B, B after C and before A.
    const { after, ok, failed } = patch(
      { op: "reorder", node: "m", src: maple, from: { parent: "nav", index: 2 }, to: { parent: "nav", index: 0 }, anchor: { before: choc } },
      { op: "reorder", node: "c", src: choc, from: { parent: "nav", index: 1 }, to: { parent: "nav", index: 1 }, anchor: { after: maple, before: glazed } },
    );
    expect(ok).toEqual([]);
    expect(failed).toHaveLength(2);
    expect(failed.every((c) => c.reason === MOVED_ANCHOR)).toBe(true);
    expect(after).toBe(PAGE);
  });

  it("keeps Windows line endings", () => {
    const crlf = PAGE.replace(/\n/g, "\r\n");
    const { after } = patchHtml(crlf, [{ op: "delete", parent: "nav", index: 1, nodes: [], src: choc }]);
    expect(after).toBe(crlf.replace('      <button class="btn">Chocolate</button>\r\n', ""));
  });

  it("reports changes it cannot place as failed", () => {
    const { failed } = patch({ op: "setText", node: "x", src: "index.html:99:1", from: "a", to: "b" });
    expect(failed).toHaveLength(1);
  });
});
