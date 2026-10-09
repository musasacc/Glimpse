import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { Change, ChangeList, Scene } from "@glimpse/core";
import { startServer, type GlimpseServer } from "./index.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function open(example = "tui-todo", opts: { command?: string } = {}): Promise<{ dir: string; srv: GlimpseServer }> {
  const dir = await mkdtemp(join(tmpdir(), "glimpse-scene-srv-"));
  await copyFile(join(examples, example, "glimpse.scene.json"), join(dir, "glimpse.scene.json"));
  const srv = await startServer({ dir, port: 0, ...opts });
  cleanups.push(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, srv };
}

interface ScenePayload {
  exists: boolean;
  file: string;
  scene: Scene;
  errors: string[];
  format: string;
  extras: { meta?: { command?: string } };
  version: string;
  invalid?: { message: string };
}

const post = async (srv: GlimpseServer, path: string, body: unknown) => {
  const res = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** The human renames the Add button and leaves a comment for the AI. */
function edit(scene: Scene): { scene: Scene; changeList: ChangeList } {
  const final = structuredClone(scene);
  final.nodes.add!.props.text = "Add todo";
  const changes: Change[] = [
    { op: "setText", node: "add", from: "Add", to: "Add todo", label: 'button "Add"' },
    { op: "comment", node: "todos", text: "Show a count of open todos", label: "todos list" },
  ];
  return { scene: final, changeList: { version: 1, target: "tui", createdAt: new Date().toISOString(), changes } };
}

describe("scene targets", () => {
  it("serves the scene file on GET /api/scene", async () => {
    const { srv } = await open();
    expect(srv.project).toMatchObject({ target: "tui", entry: "glimpse.scene.json" });
    const scene = (await (await fetch(`${srv.url}/api/scene`)).json()) as ScenePayload;
    expect(scene).toMatchObject({ exists: true, file: "glimpse.scene.json", errors: [], format: "nested" });
    expect(scene.extras.meta?.command).toBe("python app.py");
    expect(scene.scene.nodes.add!.props.text).toBe("Add");
    expect(scene.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("writes the edited scene with Edit source, hands the code changes back, and refuses a stale version with 409", async () => {
    const { dir, srv } = await open();
    const read = (await (await fetch(`${srv.url}/api/scene`)).json()) as ScenePayload;
    const { scene, changeList } = edit(read.scene);

    const preview = await post(srv, "/api/patch/preview", { changeList, scene, sceneVersion: read.version });
    expect(preview.status).toBe(200);
    expect(preview.body.files).toEqual([{ file: "glimpse.scene.json", diff: expect.stringMatching(/^\+.*"text": "Add todo"/m) }]);
    expect((preview.body.needsAi as Change[]).map((c) => c.op)).toEqual(["setText", "comment"]);
    expect(await readFile(join(dir, "glimpse.scene.json"), "utf8")).toBe(await readFile(join(examples, "tui-todo", "glimpse.scene.json"), "utf8"));

    const applied = await post(srv, "/api/patch/apply", { changeList, scene, sceneVersion: read.version });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ files: ["glimpse.scene.json"], applied: 1, backup: expect.stringMatching(/^\.glimpse\/backups\//) });
    const written = await readFile(join(dir, "glimpse.scene.json"), "utf8");
    expect(written).toContain('"text": "Add todo"');
    expect(await readFile(join(dir, applied.body.backup as string, "glimpse.scene.json"), "utf8")).toContain('"text": "Add"');
    const after = (await (await fetch(`${srv.url}/api/scene`)).json()) as ScenePayload;
    expect(applied.body.version).toBe(after.version);
    // Nothing for the agent yet: the code still has to change, which goes through Send to AI.
    const list = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: unknown[] };
    expect(list.handoffs).toEqual([]);

    // The editor still holds the old version: refused, nothing written.
    const stale = await post(srv, "/api/patch/apply", { changeList, scene: read.scene, sceneVersion: read.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed on disk/);
    expect(await readFile(join(dir, "glimpse.scene.json"), "utf8")).toBe(written);

    // A broken scene in the body is a 400, not a crash.
    expect((await post(srv, "/api/patch/preview", { changeList, scene: { nodes: {} } })).status).toBe(400);
  });

  it("writes the scene on Send to AI and asks the AI for the code changes only", async () => {
    const { dir, srv } = await open();
    const read = (await (await fetch(`${srv.url}/api/scene`)).json()) as ScenePayload;
    const { scene, changeList } = edit(read.scene);
    changeList.changes.push({ op: "setLocked", node: "add", from: false, to: true });

    const waiting = srv.nextHandoff(undefined, 5000);
    const sent = await post(srv, "/api/handoff", { kind: "ai", changeList, scene, sceneVersion: read.version });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ seq: 1, sceneVersion: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(await readFile(join(dir, "glimpse.scene.json"), "utf8")).toContain('"text": "Add todo"');

    const h = (await waiting)!;
    expect(h.kind).toBe("ai");
    expect(h.prompt).toContain("a Textual (Python) terminal UI, run with `python app.py`");
    expect(h.prompt).toContain("glimpse.scene.json already matches the edited mock");
    expect(h.changeList.changes.map((c) => c.op)).toEqual(["setText", "comment"]); // the lock is editor-only

    // Again with the old version: the file changed since, so 409 and no handoff.
    const stale = await post(srv, "/api/handoff", { kind: "ai", changeList, scene, sceneVersion: read.version });
    expect(stale.status).toBe(409);

    // Without a scene, nothing is written and the AI updates the scene file too.
    const plain = await post(srv, "/api/handoff", { kind: "ai", changeList: edit(read.scene).changeList });
    expect(plain.body.sceneVersion).toBeUndefined();
    const second = (await srv.nextHandoff(1, 1000))!;
    expect(second.prompt).toContain("Then update glimpse.scene.json to match");
  });

  it("pushes scene file changes over the websocket, and the terminal state in hello", async () => {
    const { dir, srv } = await open();
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await expect.poll(() => messages[0]?.type).toBe("hello");
    expect(messages[0]).toMatchObject({
      project: { target: "tui", entry: "glimpse.scene.json" },
      entryExists: true,
      previewError: null,
      terminal: { command: null, running: false, autoRestart: true, pty: expect.any(Boolean) },
    });

    await writeFile(join(dir, "glimpse.scene.json"), '{ "target": "tui", "root": {');
    await expect.poll(() => messages.find((m) => m.type === "scene"), { timeout: 5000 }).toMatchObject({ exists: true, invalid: { message: expect.any(String) } });
    ws.close();
  }, 15_000);

  it("runs --run's command in the terminal right away, and restarts it from the editor", async () => {
    const command = `${JSON.stringify(process.execPath)} -e "console.log('app ' + process.argv.length)"`;
    const { srv } = await open("tui-todo", { command });
    await expect.poll(() => srv.terminal.output, { timeout: 10_000 }).toContain("app 1");
    expect(srv.terminal.command).toBe(command);

    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await expect.poll(() => messages.find((m) => m.type === "hello")).toMatchObject({ terminal: { command } });
    // The catch-up: what ran, its output, and that it exited.
    await expect.poll(() => messages.map((m) => m.type)).toEqual(expect.arrayContaining(["term-start", "term-data", "term-exit"]));
    messages.length = 0;
    ws.send(JSON.stringify({ type: "term-restart" }));
    await expect.poll(() => messages.find((m) => m.type === "term-start"), { timeout: 10_000 }).toMatchObject({ command, cols: 80, rows: 24 });
    ws.close();
  }, 30_000);
});
