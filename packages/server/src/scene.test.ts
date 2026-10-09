import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffScenes, parseSceneFile, type ChangeList, type Op, type Scene } from "@glimpse/core";
import { detectProject } from "./detect.js";
import { applyScenePatch, describeSceneTarget, planScenePatch, readScene, sceneChangesPrompt, SceneConflictError } from "./scene.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function project(example?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "glimpse-scene-"));
  dirs.push(dir);
  if (example) await copyFile(join(examples, example, "glimpse.scene.json"), join(dir, "glimpse.scene.json"));
  return dir;
}

/** The human's session: edits on the file's scene, plus a comment and a lock. */
function edit(base: Scene): { final: Scene; ops: Op[] } {
  const final = structuredClone(base);
  final.nodes.add!.props.text = "Add todo";
  final.nodes.add!.locked = true;
  final.nodes.todos!.layout = { ...final.nodes.todos!.layout, w: 36 };
  final.nodes.details!.layout = { ...final.nodes.details!.layout, x: 36, w: 44 };
  delete final.nodes.delete;
  final.nodes["detail-actions"]!.children = ["done"];
  final.nodes.todos!.props.items += "\nWater the plants";
  const ops: Op[] = [{ op: "comment", node: "todos", id: "c1", text: "Show a count of open todos" }];
  return { final, ops };
}

describe("readScene", () => {
  it("returns null when there is no scene file", async () => {
    expect(await readScene(await project())).toBeNull();
  });

  it("reads and parses the scene file", async () => {
    const dir = await project("tui-todo");
    const read = (await readScene(dir))!;
    expect(read.file).toBe("glimpse.scene.json");
    expect(read.errors).toEqual([]);
    expect(read.format).toBe("nested");
    expect(read.extras.meta?.framework).toBe("textual");
    expect(read.scene.nodes.todos!.tag).toBe("ListView");
    expect(read.text).toBe(await readFile(join(dir, "glimpse.scene.json"), "utf8"));
    expect(read.version).toMatch(/^[0-9a-f]{16}$/);
    expect(read.invalid).toBeUndefined();
  });

  it("reads a scene file in a subdirectory, with forward slashes", async () => {
    const dir = await project();
    await mkdir(join(dir, "ui"));
    await writeFile(join(dir, "ui", "screen.json"), JSON.stringify({ target: "native", root: { type: "window", layout: { x: 0, y: 0, w: 300, h: 200 } } }));
    const read = (await readScene(dir, "ui/screen.json"))!;
    expect(read.file).toBe("ui/screen.json");
    expect(read.scene.target).toBe("native");
  });

  it("reports invalid JSON instead of throwing, with an empty placeholder scene", async () => {
    const dir = await project();
    await writeFile(join(dir, "glimpse.scene.json"), '{\n  "target": "native",\n  "root": {\n    "type": "window",\n');
    const read = (await readScene(dir))!;
    expect(read.invalid).toMatchObject({ line: 5, column: 1 });
    expect(read.errors).toEqual([read.invalid!.message]);
    expect(read.scene.target).toBe("native");
    expect(read.scene.nodes[read.scene.rootId]!.children).toEqual([]);
  });

  it("refuses paths outside the project", async () => {
    await expect(readScene(await project(), "../outside.json")).rejects.toThrow(/inside the project/);
  });
});

describe("planScenePatch", () => {
  it("writes the edited scene back in the file's form, with a diff, and hands every change to the AI", async () => {
    const dir = await project("tui-todo");
    const read = (await readScene(dir))!;
    const { final, ops } = edit(read.scene);
    const changes = diffScenes(read.scene, final, ops);

    const plan = await planScenePatch(dir, "glimpse.scene.json", final, changes, { expectedVersion: read.version });
    expect(plan.version).toBe(read.version);
    expect(plan.files).toHaveLength(1);
    const [f] = plan.files;
    expect(f!.file).toBe("glimpse.scene.json");
    expect(f!.before).toBe(read.text);
    expect(f!.diff).toMatch(/^- +"props": \{ "text": "Add", "variant": "primary" \},$/m);
    expect(f!.diff).toMatch(/^\+ +"props": \{ "text": "Add todo", "variant": "primary" \},$/m);
    expect(f!.diff).toMatch(/^\+ +"Water the plants"$/m);
    expect(f!.diff).toMatch(/^- +"id": "delete",$/m);

    // Still nested, extras kept, and the lock (editor-only) is not written.
    const after = parseSceneFile(f!.after);
    expect(after.errors).toEqual([]);
    expect(after.format).toBe("nested");
    expect(after.extras).toEqual(read.extras);
    const expected = structuredClone(final);
    delete expected.nodes.add!.locked;
    expect(after.scene).toEqual(expected);
    expect(f!.after).not.toContain('"locked"');

    const kinds = (xs: { op: string }[]) => xs.map((c) => c.op).sort();
    // The details panel was moved and resized at once: one resize.
    expect(kinds(changes)).toEqual(["comment", "delete", "resize", "resize", "setLocked", "setProp", "setText"]);
    expect(kinds(plan.applied)).toEqual(["delete", "resize", "resize", "setProp", "setText"]);
    expect(kinds(plan.needsAi)).toEqual(["comment", "delete", "resize", "resize", "setProp", "setText"]);

    // Nothing is written until applyScenePatch.
    expect(await readFile(join(dir, "glimpse.scene.json"), "utf8")).toBe(read.text);
    expect(await applyScenePatch(dir, plan)).toEqual(["glimpse.scene.json"]);
    const reread = (await readScene(dir))!;
    expect(reread.text).toBe(f!.after);
    expect(reread.scene).toEqual(expected);
  });

  it("keeps a flat file flat and its list props as arrays", async () => {
    const dir = await project();
    const flat = parseSceneFile(await readFile(join(examples, "native-settings", "glimpse.scene.json"), "utf8"));
    const { serializeSceneFile } = await import("@glimpse/core");
    await writeFile(join(dir, "glimpse.scene.json"), serializeSceneFile(flat.scene, "flat", flat.extras));
    const read = (await readScene(dir))!;
    expect(read.format).toBe("flat");

    const final = structuredClone(read.scene);
    final.nodes.language!.props.items += "\nItaliano";
    final.nodes.usage!.props.checked = "true";
    const plan = await planScenePatch(dir, "glimpse.scene.json", final, diffScenes(read.scene, final));
    const out = JSON.parse(plan.files[0]!.after) as { rootId: string; theme: string; nodes: Record<string, { props: Record<string, unknown> }> };
    expect(out.rootId).toBe("root");
    expect(out.theme).toBe("macos");
    expect(out.nodes.language!.props.items).toEqual(["English", "Deutsch", "Español", "Français", "日本語", "Italiano"]);
    expect(out.nodes.usage!.props.checked).toBe(true);
    expect(plan.applied.map((c) => c.op)).toEqual(["setProp", "setProp"]);
  });

  it("keeps locks that are in the file", async () => {
    const dir = await project("tui-todo");
    const text = (await readFile(join(dir, "glimpse.scene.json"), "utf8")).replace('"id": "add",', '"id": "add",\n"locked": true,');
    await writeFile(join(dir, "glimpse.scene.json"), text);
    const read = (await readScene(dir))!;
    expect(read.scene.nodes.add!.locked).toBe(true);
    const final = structuredClone(read.scene);
    final.nodes.add!.locked = false;
    final.nodes.todos!.locked = true;
    final.nodes.add!.props.text = "Add todo";
    const after = parseSceneFile((await planScenePatch(dir, "glimpse.scene.json", final, [])).files[0]!.after).scene;
    expect(after.nodes.add!.locked).toBe(true);
    expect(after.nodes.todos!.locked).toBeUndefined();
  });

  it("leaves a file in the agent's own format alone when the scene didn't change", async () => {
    const dir = await project();
    const text = JSON.stringify(
      { target: "tui", root: { type: "screen", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ id: "t", type: "text", source: "app.py:12", layout: { x: 0, y: 0, w: "100%", h: 1 }, props: { text: "Hi" } }] } },
      null,
      4,
    );
    await writeFile(join(dir, "glimpse.scene.json"), text);
    const read = (await readScene(dir))!;
    const comment = { op: "comment" as const, node: "t", id: "c", text: "make it green" };
    expect((await planScenePatch(dir, "glimpse.scene.json", read.scene, [comment])).files).toEqual([]);
    // Locks are editor-only too.
    const locked = structuredClone(read.scene);
    locked.nodes.t!.locked = true;
    expect((await planScenePatch(dir, "glimpse.scene.json", locked, [])).files).toEqual([]);
    // A real edit still writes it.
    const edited = structuredClone(read.scene);
    edited.nodes.t!.props.text = "Hello";
    expect((await planScenePatch(dir, "glimpse.scene.json", edited, diffScenes(read.scene, edited))).files).toHaveLength(1);
  });

  it("has nothing to write when the scene is unchanged", async () => {
    const dir = await project("tui-todo");
    const read = (await readScene(dir))!;
    const plan = await planScenePatch(dir, "glimpse.scene.json", read.scene, [{ op: "comment", node: "todos", id: "c", text: "hi" }]);
    expect(plan.files).toEqual([]);
    expect(plan.applied).toEqual([]);
    expect(plan.needsAi).toHaveLength(1);
  });

  it("creates the file when it doesn't exist yet", async () => {
    const dir = await project();
    const scene = parseSceneFile(JSON.stringify({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 } } })).scene;
    const plan = await planScenePatch(dir, "glimpse.scene.json", scene, []);
    expect(plan.version).toBeNull();
    expect(plan.files[0]!.before).toBe("");
    await applyScenePatch(dir, plan);
    expect((await readScene(dir))!.scene).toEqual(scene);
  });

  it("refuses to write over a file that changed or is half written", async () => {
    const dir = await project("tui-todo");
    const read = (await readScene(dir))!;
    await writeFile(join(dir, "glimpse.scene.json"), read.text.replace('"Todo"', '"Todos"'));
    await expect(planScenePatch(dir, "glimpse.scene.json", read.scene, [], { expectedVersion: read.version })).rejects.toBeInstanceOf(SceneConflictError);
    await writeFile(join(dir, "glimpse.scene.json"), "{ \"target\": ");
    await expect(planScenePatch(dir, "glimpse.scene.json", read.scene, [])).rejects.toThrow(/isn't valid JSON right now/);
  });
});

describe("detectProject for scene targets", () => {
  it("opens the scene file, even before it exists or while it's half written", async () => {
    const dir = await project();
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", ink: "^6.0.0" } }));
    expect(detectProject(dir, { target: "tui" })).toEqual({ dir, target: "tui", entry: "glimpse.scene.json" });
    expect(detectProject(dir, { target: "native" }).entry).toBe("glimpse.scene.json");

    await writeFile(join(dir, "glimpse.scene.json"), '{ "target": "native", "root": {');
    expect(detectProject(dir)).toEqual({ dir, target: "native", entry: "glimpse.scene.json" });
    await writeFile(join(dir, "glimpse.scene.json"), JSON.stringify({ target: "tui", root: { type: "root" } }));
    expect(detectProject(dir).target).toBe("tui");
  });

  it("keeps a native GUI one while its scene file is empty, cut short or gone for a moment", async () => {
    const dir = await project();
    const previous = { dir, target: "native" as const, entry: "glimpse.scene.json" };
    await writeFile(join(dir, "index.html"), "<!doctype html>");
    for (const text of ["", "{", '{ "tar']) {
      await writeFile(join(dir, "glimpse.scene.json"), text);
      expect(detectProject(dir, {}, previous)).toEqual(previous);
    }
    await rm(join(dir, "glimpse.scene.json"));
    expect(detectProject(dir, {}, previous)).toEqual(previous);
    // Without a scene target before, it is the HTML page.
    expect(detectProject(dir, {}, { dir, target: "html", entry: "index.html" }).target).toBe("html");
  });
});

describe("prompts", () => {
  it("names the real app", () => {
    expect(describeSceneTarget("tui", { meta: { framework: "textual", command: "python app.py" } })).toBe("a Textual (Python) terminal UI, run with `python app.py`");
    expect(describeSceneTarget("native", { meta: { framework: "Tkinter" } })).toBe("a Tkinter (Python) desktop GUI");
    expect(describeSceneTarget("tui", { meta: { framework: "ink", command: "npm start" } })).toBe("an Ink (React for the terminal) terminal UI, run with `npm start`");
    expect(describeSceneTarget("tui", { meta: { framework: "Bubble Tea" } })).toBe("a Bubble Tea (Go) terminal UI");
    expect(describeSceneTarget("native", { meta: { framework: "Fltk" } })).toBe("a Fltk desktop GUI");
    expect(describeSceneTarget("tui")).toBe("a terminal UI");
  });

  it("tells the AI the units, the toolkit and whether the scene file is already updated", async () => {
    const dir = await project("tui-todo");
    const read = (await readScene(dir))!;
    const { final, ops } = edit(read.scene);
    const list: ChangeList = { version: 1, target: "tui", createdAt: "", note: "Make it roomier", changes: diffScenes(read.scene, final, ops) };
    const written = sceneChangesPrompt(list, { extras: read.extras, sceneWritten: true });
    expect(written).toContain("In Glimpse, the human edited the mock of a Textual (Python) terminal UI, run with `python app.py`. Apply these");
    expect(written).toContain("glimpse.scene.json already matches the edited mock");
    expect(written).toContain("terminal cells (columns and rows)");
    expect(written).toContain("Note from the human: Make it roomier");
    expect(written).toContain('Change the text of button<Button> "Add todo" (app.py:65:19) from "Add" to "Add todo".');
    expect(written).toContain("Resize panel<Vertical> details (app.py:56:18): size 48×19 → 44×19 (-4w, 0h); also moved 4 cells right.");
    expect(written).toContain(
      'Set `items` of list<ListView> todos (app.py:55:19) to ["○ Buy groceries","○ Write the weekly report","○ Call the plumber","✔ Book train tickets","Water the plants"] (was [',
    );
    expect(written).toContain('Instruction for list<ListView> todos (app.py:55:19): "Show a count of open todos"');

    const notWritten = sceneChangesPrompt({ ...list, target: "native" }, { file: "ui/scene.json", sceneWritten: false });
    expect(notWritten).toContain("Then update ui/scene.json to match");
    expect(notWritten).toContain("pixels");
  });
});
