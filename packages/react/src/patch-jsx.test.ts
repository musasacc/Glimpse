import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Change, SceneNode } from "@glimpse/core";
import { instrumentJsx } from "./instrument-jsx.js";
import { isJsxChange, mergePatchPlans, patchJsx, planJsxPatch } from "./patch-jsx.js";

const APP = `import "./App.css";

export function App() {
  return (
    <main className="app">
      <h1 className="title">Donut Shop</h1>
      <nav className="buttons">
        <button className="btn">Glazed</button>
        <button className="btn">Chocolate</button>
        <button className="btn" style={{ color: "red" }}>Maple</button>
      </nav>
    </main>
  );
}
`;

const F = "src/App.tsx";
const main = `${F}:5:5`;
const h1 = `${F}:6:7`;
const nav = `${F}:7:7`;
const glazed = `${F}:8:9`;
const choc = `${F}:9:9`;
const maple = `${F}:10:9`;

function patch(...changes: Change[]) {
  return patchJsx(APP, changes, F);
}

function node(id: string, parent: string, over: Partial<SceneNode> = {}): SceneNode {
  return { id, type: "box", tag: "div", parent, children: [], layout: { x: 0, y: 0, w: 0, h: 0 }, style: {}, props: {}, ...over };
}

describe("source locations", () => {
  it("uses the coordinates instrumentJsx writes", () => {
    const out = instrumentJsx(APP, F)!.code;
    for (const src of [main, h1, nav, glazed, choc, maple]) expect(out).toContain(`data-glimpse-src="${src}"`);
  });
});

describe("patchJsx: setText", () => {
  it("changes text in place", () => {
    const { after, ok } = patch({ op: "setText", node: "g", src: glazed, from: "Glazed", to: "Honey" });
    expect(after).toBe(APP.replace(">Glazed<", ">Honey<"));
    expect(ok).toHaveLength(1);
  });

  it("writes text JSX can't hold as a string expression", () => {
    const { after } = patch({ op: "setText", node: "g", src: glazed, from: "Glazed", to: "Honey <Glazed> {1}" });
    expect(after).toContain('<button className="btn">{"Honey <Glazed> {1}"}</button>');
  });

  it("keeps the whitespace around multi-line text", () => {
    const code = "const a = (\n  <p>\n    Hello there\n  </p>\n);\n";
    const { after } = patchJsx(code, [{ op: "setText", node: "p", src: "a.jsx:2:3", from: "Hello there", to: "Hi" }], "a.jsx");
    expect(after).toBe("const a = (\n  <p>\n    Hi\n  </p>\n);\n");
  });

  it("replaces a string literal child and fills empty elements", () => {
    const code = `const a = <div>
  <b>{"Buy"}</b>
  <i></i>
  <u />
</div>;
`;
    const { after, failed } = patchJsx(
      code,
      [
        { op: "setText", node: "b", src: "a.jsx:2:3", from: "Buy", to: "Buy now" },
        { op: "setText", node: "i", src: "a.jsx:3:3", from: "", to: "new" },
        { op: "setText", node: "u", src: "a.jsx:4:3", from: "", to: "under" },
      ],
      "a.jsx",
    );
    expect(failed).toEqual([]);
    expect(after).toBe(`const a = <div>
  <b>{"Buy now"}</b>
  <i>new</i>
  <u>under</u>
</div>;
`);
  });

  it("leaves text that comes from code to the AI", () => {
    const code = `const a = <div>
  <p>Count: {count}</p>
  <p>{label}</p>
  <p>One<br />Two</p>
  <p><b>x</b></p>
</div>;
`;
    const changes: Change[] = [2, 3, 4, 5].map((line) => ({ op: "setText", node: `n${line}`, src: `a.jsx:${line}:3`, from: "x", to: "y" }));
    const { after, ok, failed } = patchJsx(code, changes, "a.jsx");
    expect(after).toBe(code);
    expect(ok).toEqual([]);
    expect(failed).toHaveLength(4);
  });
});

describe("patchJsx: attributes and style", () => {
  it("adds, edits and removes inline styles and props in one opening tag", () => {
    const { after, ok } = patch(
      { op: "setStyle", node: "m", src: maple, key: "background", from: null, to: "pink" },
      { op: "setStyle", node: "m", src: maple, key: "color", from: "red", to: null },
      { op: "setProp", node: "m", src: maple, key: "title", from: null, to: 'say "hi"' },
      { op: "setHidden", node: "g", src: glazed, from: false, to: true },
    );
    expect(after).toContain(`<button className="btn" style={{ background: "pink" }} title='say "hi"'>Maple</button>`);
    expect(after).toContain('<button className="btn" hidden>Glazed</button>');
    expect(ok).toHaveLength(4);
  });

  it("removes the style prop when it becomes empty", () => {
    const { after } = patch({ op: "setStyle", node: "m", src: maple, key: "color", from: "red", to: null });
    expect(after).toBe(APP.replace(' style={{ color: "red" }}', ""));
  });

  it("adds a style prop with camelCased keys when there is none", () => {
    const { after } = patch(
      { op: "setStyle", node: "g", src: glazed, key: "background-color", from: null, to: "pink" },
      { op: "setStyle", node: "g", src: glazed, key: "--accent", from: null, to: "#f28fb1" },
    );
    expect(after).toContain('<button className="btn" style={{ backgroundColor: "pink", "--accent": "#f28fb1" }}>Glazed</button>');
  });

  it("edits a style object in place, keeping its layout, comments and other keys", () => {
    const code = `export const Box = () => (
  <div
    className="box"
    style={{
      color: "red", // brand
      padding: 4,
      fontWeight: 700,
    }}
  >
    hi
  </div>
);
`;
    const { after, ok } = patchJsx(
      code,
      [
        { op: "setStyle", node: "d", src: "Box.jsx:2:3", key: "padding", from: "4px", to: "8px" },
        { op: "setStyle", node: "d", src: "Box.jsx:2:3", key: "margin-top", from: null, to: "2px" },
        { op: "setStyle", node: "d", src: "Box.jsx:2:3", key: "color", from: "red", to: null },
      ],
      "Box.jsx",
    );
    expect(ok).toHaveLength(3);
    expect(after).toBe(`export const Box = () => (
  <div
    className="box"
    style={{
      padding: "8px",
      fontWeight: 700,
      marginTop: "2px",
    }}
  >
    hi
  </div>
);
`);
  });

  it("adds a key to a one-line style object and keeps single quotes", () => {
    const code = `import x from './x';\nconst a = <p style={{ color: 'red' }}>x</p>;\n`;
    const { after } = patchJsx(code, [{ op: "setStyle", node: "p", src: "a.jsx:2:11", key: "font-size", from: null, to: "12px" }], "a.jsx");
    expect(after).toBe(`import x from './x';\nconst a = <p style={{ color: 'red', fontSize: '12px' }}>x</p>;\n`);
  });

  it("leaves style that comes from code to the AI", () => {
    const code = `const a = <div>
  <p style={styles.p}>a</p>
  <p style={{ color: theme.primary }}>b</p>
  <p style={{ ...base }}>c</p>
</div>;
`;
    const { after, failed } = patchJsx(
      code,
      [
        { op: "setStyle", node: "a", src: "a.jsx:2:3", key: "color", from: null, to: "red" },
        { op: "setStyle", node: "b", src: "a.jsx:3:3", key: "color", from: "blue", to: "red" },
        { op: "setStyle", node: "c", src: "a.jsx:4:3", key: "color", from: "blue", to: null },
      ],
      "a.jsx",
    );
    expect(after).toBe(code);
    expect(failed).toHaveLength(3);
  });

  it("maps HTML attribute names to React props and only overwrites literal values", () => {
    const code = `const a = <form>
  <label className="l" htmlFor="x">Name</label>
  <input className={cls} disabled={false} tabIndex="1" />
</form>;
`;
    const { after, ok, failed } = patchJsx(
      code,
      [
        { op: "setProp", node: "l", src: "a.jsx:2:3", key: "class", from: "l", to: "l big" },
        { op: "setProp", node: "l", src: "a.jsx:2:3", key: "for", from: "x", to: null },
        { op: "setProp", node: "i", src: "a.jsx:3:3", key: "class", from: "c", to: "d" },
        { op: "setProp", node: "i", src: "a.jsx:3:3", key: "disabled", from: null, to: "" },
        { op: "setProp", node: "i", src: "a.jsx:3:3", key: "tabindex", from: "1", to: "2" },
        { op: "setProp", node: "i", src: "a.jsx:3:3", key: "placeholder", from: null, to: "Tom & Jerry" },
      ],
      "a.jsx",
    );
    expect(ok).toHaveLength(5);
    expect(failed.map((c) => c.op === "setProp" && c.key)).toEqual(["class"]);
    expect(after).toBe(`const a = <form>
  <label className="l big">Name</label>
  <input className={cls} disabled tabIndex="2" placeholder="Tom & Jerry" />
</form>;
`);
  });

  it("puts new props on their own line when the tag has one prop per line", () => {
    const code = `const a = (
  <button
    className="btn"
    onClick={go}
  >
    Go
  </button>
);
`;
    const { after } = patchJsx(code, [{ op: "setProp", node: "b", src: "a.jsx:2:3", key: "title", from: null, to: "Go!" }], "a.jsx");
    expect(after).toBe(code.replace("    onClick={go}\n", '    onClick={go}\n    title="Go!"\n'));
  });

  it("shows hidden elements again", () => {
    const code = `const a = <div>
  <p hidden>a</p>
  <p
    hidden
    className="b"
  >
    b
  </p>
  <p hidden={isHidden}>c</p>
</div>;
`;
    const { after, failed } = patchJsx(
      code,
      [
        { op: "setHidden", node: "a", src: "a.jsx:2:3", from: true, to: false },
        { op: "setHidden", node: "b", src: "a.jsx:3:3", from: true, to: false },
        { op: "setHidden", node: "c", src: "a.jsx:9:3", from: true, to: false },
      ],
      "a.jsx",
    );
    expect(failed).toHaveLength(1);
    expect(after).toBe(`const a = <div>
  <p>a</p>
  <p
    className="b"
  >
    b
  </p>
  <p hidden={isHidden}>c</p>
</div>;
`);
  });
});

describe("patchJsx: structure", () => {
  it("deletes an element without leaving a blank line", () => {
    const { after, ok } = patch({ op: "delete", parent: "nav", index: 1, nodes: [], src: choc });
    expect(after).toBe(APP.replace('        <button className="btn">Chocolate</button>\n', ""));
    expect(ok).toHaveLength(1);
  });

  it("won't delete the element a component returns", () => {
    const { after, failed } = patch({ op: "delete", parent: "root", index: 0, nodes: [], src: main });
    expect(after).toBe(APP);
    expect(failed).toHaveLength(1);
  });

  it("deletes children of fragments but not elements inside expressions", () => {
    const code = `const a = (
  <>
    <h1>a</h1>
    {show && <p>b</p>}
  </>
);
`;
    const { after, failed } = patchJsx(
      code,
      [
        { op: "delete", parent: "r", index: 0, nodes: [], src: "a.jsx:3:5" },
        { op: "delete", parent: "r", index: 1, nodes: [], src: "a.jsx:4:14" },
      ],
      "a.jsx",
    );
    expect(failed).toHaveLength(1);
    expect(after).toBe("const a = (\n  <>\n    {show && <p>b</p>}\n  </>\n);\n");
  });

  it("inserts a new element between its neighbours with matching indentation", () => {
    const { after } = patch({
      op: "add",
      parent: "nav",
      index: 1,
      src: nav,
      anchor: { after: glazed, before: choc },
      nodes: [node("n", "nav", { type: "button", tag: "button", props: { class: "btn", text: "Sprinkles" } })],
    });
    expect(after).toContain(
      '        <button className="btn">Glazed</button>\n        <button className="btn">Sprinkles</button>\n        <button className="btn">Chocolate</button>\n',
    );
  });

  it("appends inside the parent when there are no neighbours, serializing a whole subtree", () => {
    const code = "const a = (\n  <section>\n  </section>\n);\n";
    const { after } = patchJsx(
      code,
      [
        {
          op: "add",
          parent: "s",
          index: 0,
          src: "a.jsx:2:3",
          nodes: [
            node("f", "s", { tag: "form", children: ["l", "i", "e"], style: { "background-color": "#fff", "--gap": "4px" }, props: { class: "card" } }),
            node("l", "f", { tag: "label", props: { for: "q", text: "Search {here}" } }),
            node("i", "f", { tag: "input", props: { id: "q", placeholder: 'say "hi"', disabled: "" } }),
            node("e", "f", { tag: "div", props: { class: "spacer" } }),
          ],
        },
      ],
      "a.jsx",
    );
    expect(after).toBe(`const a = (
  <section>
    <form className="card" style={{ backgroundColor: "#fff", "--gap": "4px" }}>
      <label htmlFor="q">{"Search {here}"}</label>
      <input id="q" placeholder='say "hi"' disabled />
      <div className="spacer" />
    </form>
  </section>
);
`);
  });

  it("opens up a self-closing parent to add a child", () => {
    const code = "const a = (\n  <div className=\"x\" />\n);\n";
    const { after } = patchJsx(
      code,
      [{ op: "add", parent: "d", index: 0, src: "a.jsx:2:3", nodes: [node("p", "d", { tag: "p", props: { text: "Hi" } })] }],
      "a.jsx",
    );
    expect(after).toBe('const a = (\n  <div className="x">\n    <p>Hi</p>\n  </div>\n);\n');
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
      '<nav className="buttons">\n        <button className="btn" style={{ color: "red" }}>Maple</button>\n        <button className="btn">Glazed</button>\n        <button className="btn">Chocolate</button>\n      </nav>',
    );
  });

  it("only reorders among siblings of the same JSX parent", () => {
    const { after, failed } = patch({
      op: "reorder",
      node: "g",
      src: glazed,
      from: { parent: "nav", index: 0 },
      to: { parent: "main", index: 0 },
      anchor: { before: h1 },
    });
    expect(after).toBe(APP);
    expect(failed).toHaveLength(1);
  });

  it("ignores anchors located in other files", () => {
    const { after, failed } = patch({
      op: "reorder",
      node: "m",
      src: maple,
      from: { parent: "nav", index: 2 },
      to: { parent: "nav", index: 0 },
      anchor: { before: "src/Other.tsx:8:9" },
    });
    expect(after).toBe(APP);
    expect(failed).toHaveLength(1);
  });

  it("keeps Windows line endings", () => {
    const crlf = APP.replace(/\n/g, "\r\n");
    const { after } = patchJsx(
      crlf,
      [
        { op: "delete", parent: "nav", index: 1, nodes: [], src: choc },
        {
          op: "add",
          parent: "main",
          index: 2,
          src: main,
          anchor: { after: nav },
          nodes: [node("p", "main", { tag: "p", children: ["s"], props: { text: "Fresh daily" } }), node("s", "p", { tag: "small", props: { text: "*" } })],
        },
      ],
      F,
    );
    expect(after).toBe(
      crlf
        .replace('        <button className="btn">Chocolate</button>\r\n', "")
        .replace("      </nav>\r\n", "      </nav>\r\n      <p>Fresh daily\r\n        <small>*</small>\r\n      </p>\r\n"),
    );
  });

  it("reports changes it cannot place, and ops it doesn't handle, as failed", () => {
    const { after, failed } = patch(
      { op: "setText", node: "x", src: `${F}:99:1`, from: "a", to: "b" },
      { op: "move", node: "g", src: glazed, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
      { op: "comment", node: "g", src: glazed, id: "c1", text: "make it pop" },
    );
    expect(after).toBe(APP);
    expect(failed).toHaveLength(3);
  });

  it("leaves elements the page renders more than once (lists, reused components) to the AI", () => {
    const code = `export const List = ({ items }) => (
  <ul>
    {items.map((i) => (
      <li key={i}>
        <span>{i}</span>
        <button className="x">Remove</button>
      </li>
    ))}
    <li className="end">End</li>
  </ul>
);
`;
    const li = "List.jsx:4:7";
    const btn = "List.jsx:6:9";
    const end = "List.jsx:9:5";
    const { after, ok, failed } = patchJsx(
      code,
      [
        { op: "delete", parent: "li", index: 1, nodes: [], src: btn },
        { op: "setText", node: "b", src: btn, from: "Remove", to: "Drop" },
        { op: "setStyle", node: "e", src: end, key: "color", from: null, to: "red" },
        {
          op: "reorder",
          node: "e",
          src: end,
          from: { parent: "ul", index: 3 },
          to: { parent: "ul", index: 0 },
          anchor: { before: li },
        },
      ],
      { file: "List.jsx", repeated: [li, btn] },
    );
    expect(ok.map((c) => c.op)).toEqual(["setStyle"]);
    expect(failed.map((c) => c.op)).toEqual(["delete", "setText", "reorder"]);
    expect(after).toBe(code.replace('<li className="end">', '<li className="end" style={{ color: "red" }}>'));
  });

  it("fails edits to an element deleted in the same change list instead of throwing", () => {
    const { after, ok, failed } = patch(
      { op: "delete", parent: "nav", index: 2, nodes: [], src: maple },
      { op: "setStyle", node: "m", src: maple, key: "color", from: "red", to: "blue" },
      { op: "setProp", node: "m", src: maple, key: "title", from: null, to: "x" },
      { op: "setText", node: "m", src: maple, from: "Maple", to: "Syrup" },
    );
    expect(after).toBe(APP.replace('        <button className="btn" style={{ color: "red" }}>Maple</button>\n', ""));
    expect(ok.map((c) => c.op)).toEqual(["delete"]);
    expect(failed).toHaveLength(3);
  });

  it("handles inline and nested deletes together with edits around them", () => {
    const code = `const a = (
  <div>
    <p><b className="x">bold</b> and <i>it</i></p>
    <ul>
      <li>one</li>
    </ul>
  </div>
);
`;
    const { after, ok, failed } = patchJsx(
      code,
      [
        { op: "setProp", node: "b", src: "a.jsx:3:8", key: "class", from: "x", to: "y" },
        { op: "delete", parent: "p", index: 0, nodes: [], src: "a.jsx:3:8" },
        { op: "setText", node: "i", src: "a.jsx:3:38", from: "it", to: "italic" },
        { op: "delete", parent: "ul", index: 0, nodes: [], src: "a.jsx:5:7" },
        { op: "delete", parent: "div", index: 1, nodes: [], src: "a.jsx:4:5" },
      ],
      "a.jsx",
    );
    expect(ok.map((c) => c.op)).toEqual(["delete", "setText", "delete", "delete"]);
    expect(failed.map((c) => c.op)).toEqual(["setProp"]);
    expect(after).toBe("const a = (\n  <div>\n    <p> and <i>italic</i></p>\n  </div>\n);\n");
  });

  it("fails everything when the file doesn't parse", () => {
    const { after, failed } = patchJsx("const a = <div>;", [{ op: "delete", parent: "x", index: 0, nodes: [], src: "a.jsx:1:11" }], "a.jsx");
    expect(after).toBe("const a = <div>;");
    expect(failed).toHaveLength(1);
  });
});

describe("planJsxPatch", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("plans diffs for JSX files and leaves the rest to the AI, without writing", async () => {
    dir = await mkdtemp(join(tmpdir(), "glimpse-react-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "App.tsx"), APP);
    const changes: Change[] = [
      { op: "move", node: "g", src: glazed, from: { x: 0, y: 0 }, to: { x: 4, y: 0 } },
      { op: "setText", node: "g", src: glazed, from: "Glazed", to: "Honey" },
      { op: "setLocked", node: "g", src: glazed, from: false, to: true },
      { op: "setText", node: "h", src: "index.html:3:5", from: "a", to: "b" },
      { op: "setText", node: "o", src: "../outside/App.tsx:1:1", from: "a", to: "b" },
      { op: "setText", node: "z", src: "src/Missing.tsx:1:1", from: "a", to: "b" },
    ];
    const plan = await planJsxPatch(dir, changes);
    expect(plan.files.map((f) => f.file)).toEqual(["src/App.tsx"]);
    expect(plan.files[0]!.after).toBe(APP.replace(">Glazed<", ">Honey<"));
    expect(plan.files[0]!.diff).toContain('-        <button className="btn">Glazed</button>');
    expect(plan.files[0]!.diff).toContain('+        <button className="btn">Honey</button>');
    expect(plan.applied).toEqual([changes[1]]);
    expect(plan.needsAi).toEqual([changes[0], changes[3], changes[4], changes[5]]);
    expect(await readFile(join(dir, "src", "App.tsx"), "utf8")).toBe(APP);
  });

  it("splits and merges plans by engine in change-list order", () => {
    const a: Change = { op: "setText", node: "a", src: "index.html:1:1", from: "", to: "x" };
    const b: Change = { op: "setText", node: "b", src: "src/App.jsx:1:1", from: "", to: "x" };
    const c: Change = { op: "comment", node: "c", id: "1", text: "hi" };
    expect([a, b, c].map(isJsxChange)).toEqual([false, true, false]);
    const merged = mergePatchPlans([a, b, c], { files: [], applied: [b], needsAi: [c] }, { files: [], applied: [a], needsAi: [] });
    expect(merged.applied).toEqual([a, b]);
    expect(merged.needsAi).toEqual([c]);
  });
});
