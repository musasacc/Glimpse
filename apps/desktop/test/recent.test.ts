import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { canonicalDir } from "../src/paths.js";
import { RecentProjects } from "../src/recent.js";

const root = mkdtempSync(join(tmpdir(), "glimpse-recent-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function folder(name: string): string {
  const dir = join(root, `${n++}-${name}`);
  mkdirSync(dir, { recursive: true });
  return canonicalDir(dir);
}

describe("RecentProjects", () => {
  it("starts empty when there is no file", async () => {
    const store = new RecentProjects(join(root, "none", "recent.json"));
    assert.deepEqual(await store.load(), []);
  });

  it("adds most recent first, moves re-opened folders to the top and persists", async () => {
    const file = join(root, "a", "recent.json");
    const store = new RecentProjects(file);
    await store.load();
    const [one, two] = [folder("one"), folder("two")];
    await store.add(one, new Date("2026-01-01T00:00:00Z"));
    await store.add(two, new Date("2026-01-02T00:00:00Z"));
    await store.add(one, new Date("2026-01-03T00:00:00Z"));
    assert.deepEqual(
      store.list().map((p) => p.path),
      [one, two],
    );
    assert.equal(store.list()[0]!.openedAt, "2026-01-03T00:00:00.000Z");
    assert.match(store.list()[0]!.name, /-one$/);

    const reloaded = new RecentProjects(file);
    assert.deepEqual(
      (await reloaded.load()).map((p) => p.path),
      [one, two],
    );
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(json.version, 1);
    assert.equal(json.projects.length, 2);
  });

  it("keeps at most `max` entries", async () => {
    const store = new RecentProjects(join(root, "b", "recent.json"), 3);
    for (const name of ["p1", "p2", "p3", "p4"]) await store.add(folder(name));
    assert.equal(store.list().length, 3);
    assert.match(store.list()[0]!.name, /p4$/);
    assert.match(store.list()[2]!.name, /p2$/);
  });

  it("removes and clears", async () => {
    const file = join(root, "c", "recent.json");
    const store = new RecentProjects(file);
    const [x, y] = [folder("x"), folder("y")];
    await store.add(x);
    await store.add(y);
    await store.remove(x);
    assert.deepEqual(
      store.list().map((p) => p.path),
      [y],
    );
    assert.equal(store.has(y), true);
    assert.equal(store.has(x), false);
    await store.clear();
    assert.deepEqual(await new RecentProjects(file).load(), []);
  });

  it("treats a corrupt file as empty and repairs it on the next write", async () => {
    const file = join(root, "d", "recent.json");
    mkdirSync(join(root, "d"), { recursive: true });
    writeFileSync(file, "{ not json");
    const store = new RecentProjects(file);
    assert.deepEqual(await store.load(), []);
    await store.add(folder("fixed"));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).projects.length, 1);
  });

  it("drops invalid and duplicate entries when loading", async () => {
    const file = join(root, "e", "recent.json");
    mkdirSync(join(root, "e"), { recursive: true });
    const dir = folder("dup");
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: dir }, { path: dir, name: "again" }, { nope: true }, null, { path: "" }] }));
    const items = await new RecentProjects(file).load();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.path, dir);
    assert.ok(items[0]!.name.endsWith("dup"));
  });

  it("flags folders that no longer exist", async () => {
    const store = new RecentProjects(join(root, "f", "recent.json"));
    const [kept, gone] = [folder("kept"), folder("gone")];
    await store.add(kept);
    await store.add(gone);
    rmSync(gone, { recursive: true });
    const status = Object.fromEntries(store.withStatus().map((p) => [p.path, p.exists]));
    assert.deepEqual(status, { [kept]: true, [gone]: false });
  });

  it("serializes concurrent writes", async () => {
    const file = join(root, "g", "recent.json");
    const store = new RecentProjects(file);
    const dirs = ["c1", "c2", "c3", "c4", "c5"].map(folder);
    await Promise.all(dirs.map((d) => store.add(d)));
    const saved = JSON.parse(readFileSync(file, "utf8")).projects.map((p: { path: string }) => p.path);
    assert.deepEqual(saved, store.list().map((p) => p.path));
    assert.equal(saved.length, 5);
  });
});
