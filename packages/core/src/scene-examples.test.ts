import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  NODE_TYPES,
  parseSceneFile,
  SCENE_AUTHORING_GUIDE,
  SCENE_EXAMPLES,
  SCENE_JSON_SCHEMA,
  serializeSceneFile,
  type Scene,
} from "./index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const EXAMPLE_DIRS = ["examples/tui-todo", "examples/native-settings"];
const SCHEMA_FILE = join(repo, "docs", "glimpse.scene.schema.json");

/** Every node with a source and a tag must point at code that creates that widget (module prefixes allowed). */
function sourceMismatches(scene: Scene, readFile: (file: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const n of Object.values(scene.nodes)) {
    if (!n.source) continue;
    const text = readFile(n.source.file);
    if (text === undefined) {
      out.push(`${n.id}: ${n.source.file} doesn't exist`);
      continue;
    }
    const line = text.split(/\r?\n/)[n.source.line - 1] ?? "";
    const at = line.slice(n.source.col - 1);
    const tag = (n.tag ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^(?:\\w+\\.)*${tag}\\b`).test(at)) out.push(`${n.id}: ${n.source.file}:${n.source.line}:${n.source.col} is "${at.slice(0, 30)}", not ${n.tag}`);
  }
  return out;
}

function validator() {
  // Strict about unknown keywords; union types and `required` in oneOf branches are fine in JSON Schema.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  return ajv.compile(SCENE_JSON_SCHEMA);
}

describe("example projects", () => {
  for (const dir of EXAMPLE_DIRS) {
    describe(dir, () => {
      const text = readFileSync(join(repo, dir, "glimpse.scene.json"), "utf8");
      const parsed = parseSceneFile(text);

      it("has a scene file without errors, in the canonical nested form", () => {
        expect(parsed.errors).toEqual([]);
        expect(parsed.format).toBe("nested");
        expect(parsed.extras.meta?.command).toBe("python3 app.py");
        expect(serializeSceneFile(parsed.scene, parsed.format, parsed.extras)).toBe(text.replace(/\r\n/g, "\n"));
      });

      it("points every widget at the line of code that creates it", () => {
        const read = (file: string) => (existsSync(join(repo, dir, file)) ? readFileSync(join(repo, dir, file), "utf8") : undefined);
        expect(sourceMismatches(parsed.scene, read)).toEqual([]);
        const withoutSource = Object.values(parsed.scene.nodes).filter((n) => !n.source).map((n) => n.id);
        expect(withoutSource).toEqual([]);
      });

      it("matches the JSON schema", () => {
        const validate = validator();
        expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);
        const flat = JSON.parse(serializeSceneFile(parsed.scene, "flat", parsed.extras));
        expect(validate(flat), JSON.stringify(validate.errors)).toBe(true);
      });

      it("keeps child layouts inside their parents", () => {
        for (const n of Object.values(parsed.scene.nodes)) {
          if (n.parent === null) continue;
          const p = parsed.scene.nodes[n.parent]!.layout;
          const l = n.layout;
          expect(l.x >= 0 && l.y >= 0 && l.x + l.w <= p.w && l.y + l.h <= p.h, `${n.id} sticks out of ${n.parent}`).toBe(true);
        }
      });
    });
  }

  it("has a native example with a theme and a terminal example without one", () => {
    const tui = parseSceneFile(readFileSync(join(repo, "examples/tui-todo/glimpse.scene.json"), "utf8"));
    const native = parseSceneFile(readFileSync(join(repo, "examples/native-settings/glimpse.scene.json"), "utf8"));
    expect([tui.scene.target, tui.extras.theme]).toEqual(["tui", undefined]);
    expect([native.scene.target, native.extras.theme]).toEqual(["native", "macos"]);
    expect(tui.scene.nodes.root!.layout).toMatchObject({ w: 80, h: 24 });
  });

  const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0);
  it.skipIf(!python)("has Python apps that compile", () => {
    const out = mkdtempSync(join(tmpdir(), "glimpse-pyc-"));
    try {
      for (const dir of EXAMPLE_DIRS) {
        const file = join(repo, dir, "app.py");
        // Compile into a temp file so no __pycache__ lands in the examples.
        const r = spawnSync(python!, ["-c", "import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)", file, join(out, "app.pyc")], {
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("built-in examples for agents", () => {
  for (const example of SCENE_EXAMPLES) {
    it(`${example.name}: parses without errors, matches the schema and points at its code`, () => {
      const text = serializeSceneFile(parseSceneFile(JSON.stringify(example.scene)).scene, "nested", {});
      const parsed = parseSceneFile(JSON.stringify(example.scene));
      expect(parsed.errors).toEqual([]);
      expect(parseSceneFile(text).errors).toEqual([]);
      expect(sourceMismatches(parsed.scene, (file) => example.files[file])).toEqual([]);
      const validate = validator();
      expect(validate(example.scene), JSON.stringify(validate.errors)).toBe(true);
    });
  }

  it("covers every node type in the guide", () => {
    for (const t of NODE_TYPES) expect(SCENE_AUTHORING_GUIDE).toContain(`- ${t}: `);
  });
});

describe("SCENE_JSON_SCHEMA", () => {
  const validate = validator();
  const L = { x: 0, y: 0, w: 80, h: 24 };

  it("accepts both forms and rejects mixing them", () => {
    expect(validate({ target: "tui", root: { type: "root", layout: L } })).toBe(true);
    expect(validate({ target: "tui", rootId: "r", nodes: { r: { type: "root", layout: L, parent: null, children: [] } } })).toBe(true);
    expect(validate({ target: "tui", root: { type: "root", layout: L }, rootId: "r", nodes: {} })).toBe(false);
    expect(validate({ target: "tui" })).toBe(false);
  });

  it("rejects unknown types, keys and targets", () => {
    expect(validate({ target: "web", root: { type: "root", layout: L } })).toBe(false);
    expect(validate({ target: "tui", root: { type: "sparkline", layout: L } })).toBe(false);
    expect(validate({ target: "tui", root: { type: "root", layout: L, text: "x" } })).toBe(false);
    expect(validate({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 1 } } })).toBe(false);
  });

  it("accepts list props as arrays, flags as booleans and sources as strings", () => {
    const node = {
      type: "table",
      layout: L,
      props: { columns: ["A", "B"], items: [["1", "2"]], selected: 0, disabled: true, custom: "x" },
      source: "app.py:3:5",
    };
    expect(validate({ target: "tui", root: { type: "root", layout: L, children: [node] } }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ target: "tui", root: { type: "root", layout: L, children: [{ ...node, props: { checked: "yes" } }] } })).toBe(false);
  });

  it("is published in docs/glimpse.scene.schema.json", () => {
    const expected = `${JSON.stringify(SCENE_JSON_SCHEMA, null, 2)}\n`;
    // Regenerate with GLIMPSE_WRITE_SCHEMA=1 pnpm --filter @glimpse/core test
    if (process.env.GLIMPSE_WRITE_SCHEMA === "1") writeFileSync(SCHEMA_FILE, expected);
    expect(readFileSync(SCHEMA_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(expected);
  });
});
