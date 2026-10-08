import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseSceneFile, SCENE_JSON_SCHEMA } from "@glimpse/core";
import { registerSceneTools } from "./scene-tool.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Content = { type: string; text: string }[];

async function setup(defaultDir?: string) {
  const mcp = new McpServer({ name: "glimpse-test", version: "0.0.0" });
  registerSceneTools(mcp, { defaultDir: () => defaultDir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await mcp.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Content; isError?: boolean };
    return { texts: res.content.map((c) => c.text), isError: res.isError ?? false };
  };
  return { client, call };
}

describe("scene tools", () => {
  it("registers glimpse_scene_schema and glimpse_scene_validate", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["glimpse_scene_schema", "glimpse_scene_validate"]);
  });

  it("returns the guide, two examples and the JSON schema", async () => {
    const { call } = await setup();
    const { texts, isError } = await call("glimpse_scene_schema");
    expect(isError).toBe(false);
    const [guide, examplesText, schema] = texts;
    expect(guide).toContain("# Writing glimpse.scene.json");
    expect(guide).toContain("whole character cells");
    expect(guide).toContain("meta");
    expect(guide).toContain('"source"');
    expect(guide).toContain("- statusbar: ");

    expect(examplesText).toContain("## Example: A Textual terminal UI");
    expect(examplesText).toContain("## Example: A Tkinter window");
    expect(examplesText).toContain("from textual.app import App");
    // Each example's scene is valid.
    const scenes = [...examplesText!.matchAll(/glimpse\.scene\.json:\n```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(scenes).toHaveLength(2);
    for (const s of scenes) expect(parseSceneFile(s).errors).toEqual([]);

    const json = /```json\n([\s\S]*)\n```/.exec(schema!)![1]!;
    expect(JSON.parse(json)).toEqual(SCENE_JSON_SCHEMA);
  });

  it("validates a project's scene file by directory or path", async () => {
    const { call } = await setup(join(examples, "tui-todo"));
    const byDefault = await call("glimpse_scene_validate");
    expect(byDefault.isError).toBe(false);
    expect(byDefault.texts[0]).toMatch(/glimpse\.scene\.json: no problems found\. tui scene with 15 nodes \(nested form\)\.$/);

    const byPath = await call("glimpse_scene_validate", { path: join(examples, "native-settings", "glimpse.scene.json") });
    expect(byPath.texts[0]).toContain("no problems found. native scene with 18 nodes (nested form).");
  });

  it("lists problems, tips and JSON syntax errors", async () => {
    const { call } = await setup();
    const problems = await call("glimpse_scene_validate", {
      text: JSON.stringify({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 80, h: 24 }, children: [{ type: "gauge", layout: { x: 0, y: 0, w: 5, h: 1 } }] } }),
    });
    expect(problems.isError).toBe(true);
    expect(problems.texts[0]).toContain("the given text: 1 problem in a tui scene with 2 nodes (nested form).");
    expect(problems.texts[0]).toContain('1. root.children[0]: unknown type "gauge"');
    expect(problems.texts[0]).toContain("Set meta.command");
    expect(problems.texts[0]).toContain('1 widget has no "source"');

    const syntax = await call("glimpse_scene_validate", { text: '{ "target": "tui", }' });
    expect(syntax.isError).toBe(true);
    expect(syntax.texts[0]).toBe("the given text: The scene file is not valid JSON at line 1, column 18: trailing commas aren't allowed in JSON.");
  });

  it("says when there is no scene file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-scene-tool-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { call } = await setup(dir);
    const missing = await call("glimpse_scene_validate");
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toMatch(/^No scene file at .*glimpse\.scene\.json\. Write one first/);

    await writeFile(join(dir, "glimpse.scene.json"), JSON.stringify({ target: "native", meta: { command: "python app.py" }, root: { type: "window", layout: { x: 0, y: 0, w: 400, h: 300 } } }));
    const ok = await call("glimpse_scene_validate", { path: dir });
    expect(ok.isError).toBe(false);
    expect(ok.texts[0]).not.toContain("Tips");
  });
});
