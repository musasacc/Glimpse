import { describe, expect, it } from "vitest";
import {
  describeChange,
  diffScenes,
  NODE_TYPES,
  parseSceneFile,
  SceneFileSyntaxError,
  serializeSceneFile,
  validateSceneFile,
  type Scene,
} from "./index.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** A canonical nested file, exactly as serializeSceneFile writes it. */
const NESTED = `{
  "$schema": "https://example.com/scene.json",
  "target": "tui",
  "meta": { "framework": "textual", "command": "python app.py", "title": "Todo" },
  "root": {
    "type": "root",
    "tag": "TodoApp",
    "layout": { "x": 0, "y": 0, "w": 80, "h": 24 },
    "children": [
      {
        "type": "statusbar",
        "tag": "Header",
        "layout": { "x": 0, "y": 0, "w": 80, "h": 1 },
        "props": { "text": "Todo" },
        "source": { "file": "app.py", "line": 12, "col": 15 }
      },
      {
        "id": "todos",
        "type": "list",
        "tag": "ListView",
        "layout": { "x": 0, "y": 1, "w": 32, "h": 22 },
        "style": { "border": "round", "color": "cyan" },
        "props": { "items": ["Buy milk", "Write report", "Call mom"], "selected": 1 },
        "source": { "file": "app.py", "line": 14, "col": 13 }
      },
      {
        "id": "details",
        "type": "panel",
        "layout": { "x": 32, "y": 1, "w": 48, "h": 22 },
        "props": { "title": "Details" },
        "children": [
          {
            "type": "checkbox",
            "layout": { "x": 1, "y": 1, "w": 20, "h": 1 },
            "props": { "text": "Done", "checked": true, "disabled": false }
          },
          {
            "type": "table",
            "layout": { "x": 1, "y": 3, "w": 46, "h": 6 },
            "props": {
              "columns": ["Field", "Value"],
              "items": [["Due", "Friday"], ["Owner", "Sam"]]
            }
          },
          {
            "type": "progress",
            "layout": { "x": 1, "y": 10, "w": 46, "h": 1 },
            "props": { "value": 40, "max": 100 }
          },
          {
            "type": "button",
            "layout": { "x": 1, "y": 12, "w": 12, "h": 3 },
            "props": { "text": "Delete" },
            "hidden": true
          }
        ]
      },
      {
        "type": "statusbar",
        "tag": "Footer",
        "layout": { "x": 0, "y": 23, "w": 80, "h": 1 },
        "props": { "items": ["q Quit"] }
      }
    ]
  }
}
`;

/** A canonical flat file. */
const FLAT = `{
  "target": "native",
  "theme": "windows",
  "rootId": "win",
  "nodes": {
    "win": {
      "id": "win",
      "type": "window",
      "tag": "QMainWindow",
      "parent": null,
      "children": ["name", "ok"],
      "layout": { "x": 0, "y": 0, "w": 400, "h": 200 },
      "style": {},
      "props": { "title": "Rename" }
    },
    "name": {
      "id": "name",
      "type": "input",
      "tag": "QLineEdit",
      "parent": "win",
      "children": [],
      "layout": { "x": 16, "y": 16, "w": 368, "h": 28 },
      "style": { "font-size": "13px" },
      "props": { "text": "report.txt", "placeholder": "File name" },
      "source": { "file": "main.py", "line": 20, "col": 21 }
    },
    "ok": {
      "id": "ok",
      "type": "button",
      "tag": "QPushButton",
      "parent": "win",
      "children": [],
      "layout": { "x": 296, "y": 152, "w": 88, "h": 32 },
      "style": {},
      "props": { "text": "OK", "default": true },
      "locked": true,
      "source": { "file": "main.py", "line": 24, "col": 14 }
    }
  }
}
`;

describe("parseSceneFile: nested form", () => {
  it("reads a valid file without errors", () => {
    const { scene, errors, format, extras } = parseSceneFile(NESTED);
    expect(errors).toEqual([]);
    expect(format).toBe("nested");
    expect(extras).toEqual({
      $schema: "https://example.com/scene.json",
      meta: { framework: "textual", command: "python app.py", title: "Todo" },
    });
    expect(scene.target).toBe("tui");
    expect(scene.rootId).toBe("root");
    expect(scene.nodes.root!.children).toEqual(["statusbar-0", "todos", "details", "statusbar-1"]);
    expect(scene.nodes.todos).toEqual({
      id: "todos",
      type: "list",
      tag: "ListView",
      parent: "root",
      children: [],
      layout: { x: 0, y: 1, w: 32, h: 22 },
      style: { border: "round", color: "cyan" },
      props: { items: "Buy milk\nWrite report\nCall mom", selected: "1" },
      source: { file: "app.py", line: 14, col: 13 },
    });
  });

  it("generates ids from type and same-type index, under the parent's id", () => {
    const { scene } = parseSceneFile(NESTED);
    expect(scene.nodes.details!.children).toEqual(["details.checkbox-0", "details.table-0", "details.progress-0", "details.button-0"]);
    expect(scene.nodes["details.button-0"]!.parent).toBe("details");
    expect(scene.nodes["details.button-0"]!.hidden).toBe(true);
  });

  it("turns list props into lines, table rows into tab-separated cells, and flags into strings", () => {
    const { scene } = parseSceneFile(NESTED);
    expect(scene.nodes["details.table-0"]!.props).toEqual({ columns: "Field\nValue", items: "Due\tFriday\nOwner\tSam" });
    expect(scene.nodes["details.checkbox-0"]!.props).toEqual({ text: "Done", checked: "true", disabled: "false" });
    expect(scene.nodes["details.progress-0"]!.props).toEqual({ value: "40", max: "100" });
  });

  it("round-trips byte for byte", () => {
    const { scene, format, extras } = parseSceneFile(NESTED);
    expect(serializeSceneFile(scene, format, extras)).toBe(NESTED);
  });
});

describe("parseSceneFile: flat form", () => {
  it("reads a valid file without errors", () => {
    const { scene, errors, format, extras } = parseSceneFile(FLAT);
    expect(errors).toEqual([]);
    expect(format).toBe("flat");
    expect(extras).toEqual({ theme: "windows" });
    expect(scene.rootId).toBe("win");
    expect(Object.keys(scene.nodes)).toEqual(["win", "name", "ok"]);
    expect(scene.nodes.ok!.locked).toBe(true);
    expect(scene.nodes.ok!.props).toEqual({ text: "OK", default: "true" });
  });

  it("round-trips byte for byte", () => {
    const { scene, format, extras } = parseSceneFile(FLAT);
    expect(serializeSceneFile(scene, format, extras)).toBe(FLAT);
  });

  it("derives children from parent pointers when no list mentions a node", () => {
    const { scene, errors } = parseSceneFile(
      json({
        target: "tui",
        rootId: "r",
        nodes: {
          r: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } },
          a: { type: "box", parent: "r", layout: { x: 0, y: 0, w: 10, h: 5 } },
          b: { type: "text", parent: "a", layout: { x: 1, y: 1, w: 5, h: 1 }, props: { text: "hi" } },
        },
      }),
    );
    expect(errors).toEqual([]);
    expect(scene.nodes.r!.children).toEqual(["a"]);
    expect(scene.nodes.a!.children).toEqual(["b"]);
    expect(scene.nodes.b!.parent).toBe("a");
  });
});

describe("converting between forms", () => {
  it("keeps the scene when going nested → flat → nested", () => {
    const nested = parseSceneFile(NESTED);
    const flatText = serializeSceneFile(nested.scene, "flat", nested.extras);
    const flat = parseSceneFile(flatText);
    expect(flat.errors).toEqual([]);
    expect(flat.format).toBe("flat");
    expect(flat.scene).toEqual(nested.scene);
    expect(serializeSceneFile(flat.scene, "nested", flat.extras)).toBe(NESTED);
  });

  it("keeps the scene when going flat → nested → flat", () => {
    const flat = parseSceneFile(FLAT);
    const nested = parseSceneFile(serializeSceneFile(flat.scene, "nested", flat.extras));
    expect(nested.errors).toEqual([]);
    expect(nested.scene).toEqual(flat.scene);
    expect(serializeSceneFile(nested.scene, "flat", nested.extras)).toBe(FLAT);
  });
});

describe("ids", () => {
  const base = (children: unknown[]) => json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children } });
  const L = { x: 0, y: 0, w: 10, h: 1 };

  it("are stable when a widget of another type is inserted", () => {
    const before = parseSceneFile(base([{ type: "button", layout: L }, { type: "text", layout: L }]));
    const after = parseSceneFile(base([{ type: "input", layout: L }, { type: "button", layout: L }, { type: "text", layout: L }]));
    expect(before.scene.nodes.root!.children).toEqual(["button-0", "text-0"]);
    expect(after.scene.nodes.root!.children).toEqual(["input-0", "button-0", "text-0"]);
  });

  it("never take an id that a node sets explicitly, and rename duplicates", () => {
    const { scene, errors } = parseSceneFile(
      base([
        { type: "button", layout: L },
        { id: "button-0", type: "text", layout: L },
        { id: "x", type: "text", layout: L },
        { id: "x", type: "text", layout: L },
      ]),
    );
    expect(scene.nodes.root!.children).toEqual(["button-0~2", "button-0", "x", "x~2"]);
    expect(errors).toEqual(['root.children[3]: duplicate id "x" (renamed to "x~2").']);
  });

  it("are written only when they differ from the generated one", () => {
    const parsed = parseSceneFile(base([{ type: "button", layout: L }, { type: "button", layout: L, props: { text: "B" } }]));
    const scene = structuredClone(parsed.scene);
    // The human swaps the two buttons: each keeps its id, so both are now written out.
    scene.nodes.root!.children.reverse();
    const text = serializeSceneFile(scene, "nested", parsed.extras);
    const again = parseSceneFile(text);
    expect(again.scene.nodes.root!.children).toEqual(["button-1", "button-0"]);
    expect(again.scene.nodes["button-1"]!.props.text).toBe("B");
    expect(text).toContain('"id": "button-1"');
    // Unchanged positions stay implicit.
    expect(serializeSceneFile(parsed.scene, "nested", parsed.extras)).not.toContain('"id": "button-0"');
  });

  it("use the root's own id as the prefix only below the root", () => {
    const { scene } = parseSceneFile(
      json({
        target: "tui",
        root: { id: "app", type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ id: "side", type: "box", layout: L, children: [{ type: "button", layout: L }] }, { type: "text", layout: L }] },
      }),
    );
    expect(scene.rootId).toBe("app");
    expect(Object.keys(scene.nodes)).toEqual(["app", "side", "side.button-0", "text-0"]);
  });

  it("are new nodes' own ids after an edit, so a re-read gives the same scene", () => {
    const parsed = parseSceneFile(NESTED);
    const scene = structuredClone(parsed.scene);
    scene.nodes.n7 = { id: "n7", type: "button", parent: "details", children: [], layout: { x: 30, y: 12, w: 10, h: 3 }, style: {}, props: { text: "Save" } };
    scene.nodes.details!.children.splice(1, 0, "n7");
    const text = serializeSceneFile(scene, "nested", parsed.extras);
    expect(parseSceneFile(text).scene).toEqual(scene);
  });
});

describe("defaults and problems", () => {
  it("fills in a missing layout and type and reports them", () => {
    const { scene, errors } = parseSceneFile(json({ target: "native", root: { children: [{ layout: { x: 10, y: 10, h: 30 } }, { type: "label" }] } }));
    expect(scene.nodes.root).toMatchObject({ type: "root", layout: { x: 0, y: 0, w: 800, h: 600 } });
    expect(scene.nodes["box-0"]!.layout).toEqual({ x: 10, y: 10, w: 790, h: 30 });
    expect(scene.nodes["label-0"]!.layout).toEqual({ x: 0, y: 0, w: 800, h: 24 });
    expect(errors).toEqual([
      'root: "layout" is missing; give { "x", "y", "w", "h" } in pixels, relative to the parent (using x 0, y 0, w 800, h 600).',
      'root.children[0]: "type" is missing (using "box").',
      "root.children[0]: layout.w is missing (using 790).",
      'root.children[1]: "layout" is missing; give { "x", "y", "w", "h" } in pixels, relative to the parent (using x 0, y 0, w 800, h 24).',
    ]);
  });

  it("uses an 80×24 terminal by default", () => {
    const { scene } = parseSceneFile(json({ target: "tui", root: { type: "root" } }));
    expect(scene.nodes.root!.layout).toEqual({ x: 0, y: 0, w: 80, h: 24 });
  });

  it("shows unknown types as custom, keeping the type as the tag", () => {
    const { scene, errors } = parseSceneFile(
      json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ type: "sparkline", layout: { x: 0, y: 0, w: 20, h: 2 } }] } }),
    );
    expect(scene.nodes["custom-0"]).toMatchObject({ type: "custom", tag: "sparkline" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^root\.children\[0\]: unknown type "sparkline" \(shown as "custom"\)\. Known types: root, box, text/);
  });

  it("rounds fractional cells and clamps negative sizes", () => {
    const { scene, errors } = parseSceneFile(
      json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ id: "a", type: "box", layout: { x: 1.4, y: 2, w: -3, h: "4" } }] } }),
    );
    expect(scene.nodes.a!.layout).toEqual({ x: 1, y: 2, w: 0, h: 1 });
    expect(errors).toEqual([
      'node "a": layout.x is 1.4, but terminal layouts are whole cells (rounded to 1).',
      'node "a": layout.w can\'t be negative (using 0).',
      'node "a": layout.h must be a number, got "4" (using 1).',
    ]);
  });

  it("keeps pixel fractions for native scenes", () => {
    const { scene, errors } = parseSceneFile(json({ target: "native", root: { type: "window", layout: { x: 0, y: 0, w: 300.5, h: 200 } } }));
    expect(errors).toEqual([]);
    expect(scene.nodes.root!.layout.w).toBe(300.5);
  });

  it("reports bad top-level fields and keeps going", () => {
    const { scene, errors, extras } = parseSceneFile(json({ target: "web", theme: "amiga", meta: { command: 3, cwd: "src" }, extra: 1, root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } } }));
    expect(scene.target).toBe("tui");
    expect(extras).toEqual({ meta: { cwd: "src" } });
    expect(errors).toEqual([
      'Unknown top-level key "extra" (ignored).',
      '"target" must be "tui" or "native", got "web". Assuming "tui".',
      '"theme" must be one of "macos", "windows", "linux" (ignored).',
      '"meta.command" must be a string (ignored).',
    ]);
  });

  it("warns that a theme does nothing for a terminal UI, but keeps it", () => {
    const { errors, extras } = parseSceneFile(json({ target: "tui", theme: "macos", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } } }));
    expect(extras.theme).toBe("macos");
    expect(errors).toEqual(['"theme" only applies to native scenes; terminal UIs ignore it.']);
  });

  it("reports unknown node keys, bad props, styles, flags and sources", () => {
    const { scene, errors } = parseSceneFile(
      json({
        target: "tui",
        root: {
          type: "root",
          layout: { x: 0, y: 0, w: 80, h: 24 },
          children: [
            {
              id: "b",
              type: "button",
              text: "Save",
              layout: { x: 0, y: 0, w: 10, h: 3, z: 1 },
              style: { color: "red", bold: true, padding: 1 },
              props: { text: "Save", data: { a: 1 }, nothing: null },
              hidden: "yes",
              source: "app.py:10",
            },
            "not-a-node",
          ],
        },
      }),
    );
    expect(scene.nodes.b).toMatchObject({ style: { color: "red", padding: "1" }, props: { text: "Save" } });
    expect(scene.nodes.b!.hidden).toBeUndefined();
    expect(scene.nodes.b!.source).toBeUndefined();
    expect(errors).toEqual([
      'node "b": unknown key "text" (ignored).',
      'node "b": unknown layout key "z" (ignored; use x, y, w, h).',
      'node "b": style "bold" must be a string (ignored).',
      'node "b": prop "data" must be a string, number, boolean or array of strings (ignored).',
      'node "b": prop "nothing" must be a string, number, boolean or array of strings (ignored).',
      'node "b": "hidden" must be true or false (ignored).',
      'node "b": "source" must be { "file": "app.py", "line": 12, "col": 5 } (1-based) or "app.py:12:5" (ignored).',
      'root.children[1]: in the nested form, children are node objects, got "not-a-node" (ignored).',
    ]);
  });

  it("accepts a source as a file:line:col string and normalizes backslashes", () => {
    const { scene } = parseSceneFile(
      json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, source: "src\\ui\\app.py:3:7" } }),
    );
    expect(scene.nodes.root!.source).toEqual({ file: "src/ui/app.py", line: 3, col: 7 });
    const objectForm = parseSceneFile(json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, source: { file: "app.py", line: 3 } } }));
    expect(objectForm.scene.nodes.root!.source).toEqual({ file: "app.py", line: 3, col: 1 });
  });

  it("drops children that reference unknown ids, the root or themselves", () => {
    const { scene, errors } = parseSceneFile(
      json({
        target: "tui",
        rootId: "r",
        nodes: {
          r: { type: "root", children: ["a", "ghost", "r"], layout: { x: 0, y: 0, w: 80, h: 24 } },
          a: { type: "box", children: ["a", 5], layout: { x: 0, y: 0, w: 5, h: 5 } },
        },
      }),
    );
    expect(scene.nodes.r!.children).toEqual(["a"]);
    expect(scene.nodes.a!.children).toEqual([]);
    expect(errors).toEqual([
      'node "r": child "ghost" is not one of the nodes (ignored).',
      'node "r": the root "r" can\'t be a child (ignored).',
      'node "a": a node can\'t be its own child (ignored).',
      'node "a": children must be node ids (strings), got 5 (ignored).',
    ]);
  });

  it("keeps the first parent of a node listed twice, and trusts children over parent", () => {
    const { scene, errors } = parseSceneFile(
      json({
        target: "tui",
        rootId: "r",
        nodes: {
          r: { type: "root", children: ["a", "b"], layout: { x: 0, y: 0, w: 80, h: 24 } },
          a: { type: "box", children: ["c"], layout: { x: 0, y: 0, w: 5, h: 5 } },
          b: { type: "box", children: ["c"], layout: { x: 5, y: 0, w: 5, h: 5 } },
          c: { type: "text", parent: "b", layout: { x: 0, y: 0, w: 5, h: 1 } },
        },
      }),
    );
    expect(scene.nodes.a!.children).toEqual(["c"]);
    expect(scene.nodes.b!.children).toEqual([]);
    expect(scene.nodes.c!.parent).toBe("a");
    expect(errors).toEqual([
      'node "c": listed as a child of both "a" and "b" (keeping "a").',
      'node "c": "parent" is "b" but it is listed in the children of "a" (using "a").',
    ]);
  });

  it("breaks cycles and attaches orphans to the root", () => {
    const { scene, errors } = parseSceneFile(
      json({
        target: "tui",
        rootId: "r",
        nodes: {
          r: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } },
          a: { type: "box", children: ["b"], layout: { x: 0, y: 0, w: 5, h: 5 } },
          b: { type: "box", children: ["a"], layout: { x: 0, y: 0, w: 5, h: 5 } },
          lost: { type: "text", parent: "nowhere", layout: { x: 0, y: 0, w: 5, h: 1 } },
          free: { type: "text", layout: { x: 0, y: 0, w: 5, h: 1 } },
        },
      }),
    );
    expect(errors).toEqual([
      'node "lost": parent "nowhere" is not one of the nodes (attached to the root).',
      'node "free": not attached to the tree (no parent lists it as a child; attached to the root).',
      'node "a": its parents form a cycle (moved it from "b" to the root).',
    ]);
    expect(scene.nodes.r!.children).toEqual(["lost", "free", "a"]);
    expect(scene.nodes.a!.children).toEqual(["b"]);
    expect(scene.nodes.b!.children).toEqual([]);
    expect(scene.nodes.a!.parent).toBe("r");
  });

  it("reports a missing or wrong rootId and guesses the root", () => {
    const missing = parseSceneFile(json({ target: "tui", nodes: { main: { type: "root", parent: null, layout: { x: 0, y: 0, w: 80, h: 24 } } } }));
    expect(missing.scene.rootId).toBe("main");
    expect(missing.errors).toEqual(['"rootId" is missing (using "main").']);
    const wrong = parseSceneFile(json({ target: "tui", rootId: "nope", nodes: { root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } } } }));
    expect(wrong.scene.rootId).toBe("root");
    expect(wrong.errors).toEqual(['"rootId" "nope" is not one of the nodes (using "root").']);
  });

  it("reports a key that disagrees with the node's id", () => {
    const { scene, errors } = parseSceneFile(json({ target: "tui", rootId: "r", nodes: { r: { id: "x", type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } } } }));
    expect(Object.keys(scene.nodes)).toEqual(["r"]);
    expect(errors).toEqual(['node "r": "id" is "x" but its key is "r" (using the key).']);
  });

  it("prefers the nested form when both are given, and survives an empty object", () => {
    const both = parseSceneFile(json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } }, rootId: "x", nodes: {} }));
    expect(both.format).toBe("nested");
    expect(both.errors).toEqual(['Use either "root" (nested form) or "rootId" + "nodes" (flat form), not both. Using "root".']);

    const empty = parseSceneFile("{}");
    expect(empty.scene.nodes.root!.layout).toEqual({ x: 0, y: 0, w: 80, h: 24 });
    expect(empty.errors[0]).toMatch(/"target" is missing/);
    expect(empty.errors[1]).toMatch(/The scene has no nodes/);

    const notObject = parseSceneFile("[]");
    expect(notObject.errors).toEqual(['The scene file must be a JSON object like { "target": "tui", "root": { … } }.']);
  });
});

describe("invalid JSON", () => {
  const syntaxError = (text: string) => {
    try {
      parseSceneFile(text);
    } catch (err) {
      expect(err).toBeInstanceOf(SceneFileSyntaxError);
      return err as SceneFileSyntaxError;
    }
    throw new Error("expected a syntax error");
  };

  it("throws with the line and column", () => {
    const err = syntaxError('{\n  "target": "tui",\n  "root" {}\n}');
    expect(err.line).toBe(3);
    expect(err.column).toBe(10);
    expect(err.message).toBe('The scene file is not valid JSON at line 3, column 10: expected ":" after the property name, found "{".');
  });

  it("explains trailing commas, comments, single quotes and truncation", () => {
    // Points at the comma itself.
    expect(syntaxError('{\n  "a": [1, 2,],\n}').message).toBe("The scene file is not valid JSON at line 2, column 13: trailing commas aren't allowed in JSON.");
    expect(syntaxError('{\n  // hi\n  "a": 1\n}').message).toBe("The scene file is not valid JSON at line 2, column 3: comments aren't allowed in JSON.");
    expect(syntaxError("{'a': 1}").message).toBe(
      'The scene file is not valid JSON at line 1, column 2: expected a property name in double quotes, found "\'".',
    );
    expect(syntaxError('{"target": "tui", "root": {').message).toBe(
      "The scene file is not valid JSON at line 1, column 28: the text ends too early (is a closing bracket or quote missing?).",
    );
    expect(syntaxError("").line).toBe(1);
  });

  it("ignores a byte order mark", () => {
    expect(parseSceneFile(`﻿${NESTED}`).errors).toEqual([]);
  });

  it("validateSceneFile returns the message instead of throwing", () => {
    expect(validateSceneFile("{")).toEqual(["The scene file is not valid JSON at line 1, column 2: the text ends too early (is a closing bracket or quote missing?)."]);
    expect(validateSceneFile(NESTED)).toEqual([]);
    expect(validateSceneFile("{}")).toHaveLength(2);
  });
});

describe("serializeSceneFile", () => {
  it("writes empty list props as empty arrays and keeps non-flag strings", () => {
    const parsed = parseSceneFile(
      json({
        target: "tui",
        root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ id: "l", type: "list", layout: { x: 0, y: 0, w: 9, h: 9 }, props: { items: [], checked: "maybe", value: "abc", selected: "2" } }] },
      }),
    );
    const out = JSON.parse(serializeSceneFile(parsed.scene, "nested")) as { root: { children: { props: unknown }[] } };
    expect(out.root.children[0]!.props).toEqual({ items: [], checked: "maybe", value: "abc", selected: 2 });
  });

  it("breaks long lines and is stable", () => {
    const parsed = parseSceneFile(NESTED);
    const scene: Scene = parsed.scene;
    scene.nodes.todos!.props.items = Array.from({ length: 12 }, (_, i) => `Todo number ${i + 1}`).join("\n");
    const text = serializeSceneFile(scene, "nested", parsed.extras);
    expect(text).toContain('"items": [\n            "Todo number 1",\n');
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(serializeSceneFile(parseSceneFile(text).scene, "nested", parsed.extras)).toBe(text);
  });

  it("knows every node type", () => {
    const children = NODE_TYPES.filter((t) => t !== "root").map((type, i) => ({ type, layout: { x: 0, y: i, w: 10, h: 1 } }));
    const { scene, errors } = parseSceneFile(json({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 40 }, children } }));
    expect(errors).toEqual([]);
    expect(scene.nodes.root!.children).toHaveLength(NODE_TYPES.length - 1);
  });
});

describe("diffScenes on terminal scenes", () => {
  it("describes moves in cells", () => {
    const base = parseSceneFile(NESTED).scene;
    const final = structuredClone(base);
    final.nodes.todos!.layout.x = 1;
    final.nodes["details.checkbox-0"]!.layout.y = 4;
    const changes = diffScenes(base, final);
    expect(changes.map((c) => c.intent)).toEqual([
      expect.stringMatching(/^moved 1 cell right; now /),
      expect.stringMatching(/^moved 3 cells down; now /),
    ]);
  });

  it("mentions the move that comes with resizing from the left or top edge", () => {
    const base = parseSceneFile(NESTED).scene;
    const final = structuredClone(base);
    final.nodes.details!.layout = { x: 30, y: 1, w: 50, h: 22 };
    const [change] = diffScenes(base, final);
    expect(change!.intent).toBe("size 48×22 → 50×22 (+2w, 0h); also moved 2 cells left");
    expect(describeChange(change!)).toBe("Resize panel details: size 48×22 → 50×22 (+2w, 0h); also moved 2 cells left.");
  });

  it("describes list props as lists", () => {
    const base = parseSceneFile(NESTED).scene;
    const final = structuredClone(base);
    final.nodes.todos!.props.items = "Buy milk\nCall mom";
    final.nodes["details.table-0"]!.props.items += "\nTags\thome";
    const text = diffScenes(base, final).map(describeChange);
    expect(text).toEqual([
      'Set `items` of list<ListView> todos (app.py:14:13) to ["Buy milk","Call mom"] (was ["Buy milk","Write report","Call mom"]).',
      'Set `items` of table details.table-0 to [["Due","Friday"],["Owner","Sam"],["Tags","home"]] (was [["Due","Friday"],["Owner","Sam"]]).',
    ]);
  });
});
