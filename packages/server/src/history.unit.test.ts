import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History, isIgnored, isSecretFile, MAX_FILE_BYTES, MAX_FILES, writablePath, type Snapshot } from "./history.js";

let dir: string;
let history: History;
const events: [string, Snapshot][] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-history-unit-"));
  events.length = 0;
  history = new History(dir, { warn: () => undefined, onSnapshot: (s, change) => events.push([change, { ...s }]) });
});

afterEach(async () => {
  await history.idle();
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | Buffer): Promise<void> {
  const file = join(dir, ...path.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

describe("what the history ignores", () => {
  it("ignores git, dependencies, Glimpse's state, caches and OS junk, in any letter case", () => {
    for (const p of [".git/config", ".Git/config", ".GIT/hooks/pre-commit", ".git./config", ".GLIMPSE/history/snapshots.json", "Node_Modules/x/index.js"]) {
      expect(isIgnored(p), p).toBe(true);
    }
    for (const p of [".venv/lib/x.py", ".next/cache/a", ".yarn/cache/a.zip", "dist/app.js", "a/__pycache__/m.pyc", "coverage/index.html"]) {
      expect(isIgnored(p), p).toBe(true);
    }
    for (const p of [".DS_Store", "img/Thumbs.db", "desktop.ini", ".index.html.swp", "index.html~", ".#index.html", "a.css___jb_tmp___"]) {
      expect(isIgnored(p), p).toBe(true);
    }
    for (const p of ["index.html", "src/app.tsx", ".env", ".github/workflows/ci.yml", "gitignore.md", "distance.css", "a~b.txt"]) {
      expect(isIgnored(p), p).toBe(false);
    }
  });

  it("never copies files that hold secrets into the history", async () => {
    for (const name of [".env", ".env.local", ".ENV.production", ".npmrc", "server.pem", "tls.key", "id_rsa", "id_ed25519", "cert.p12", ".netrc"]) {
      expect(isSecretFile(name), name).toBe(true);
    }
    for (const name of [".env.example", ".env.sample", "index.html", "keyboard.js", "id_card.png", "monkey.css", "env.ts"]) {
      expect(isSecretFile(name), name).toBe(false);
    }
    await put("index.html", "<p>hi</p>");
    await put(".env", "API_KEY=secret");
    await put("config/.env.local", "TOKEN=secret");
    await put("certs/server.pem", "-----BEGIN PRIVATE KEY-----");
    await put(".env.example", "API_KEY=");
    const { snapshot } = await history.snapshot("manual", "x");
    expect(Object.keys(snapshot.files).sort()).toEqual([".env.example", "index.html"]);
    for (const name of await readdir(join(dir, ".glimpse", "history", "objects"))) {
      expect(await readFile(join(dir, ".glimpse", "history", "objects", name), "utf8")).not.toContain("secret");
    }
  });

  it("never writes into ignored folders or through a symlink", async () => {
    await put("ok/a.txt", "a");
    expect(await writablePath(dir, "ok/a.txt")).toBe(join(dir, "ok", "a.txt"));
    expect(await writablePath(dir, "new/folder/b.txt")).toBe(join(dir, "new", "folder", "b.txt"));
    expect(await writablePath(dir, ".Git/config")).toBeNull();
    expect(await writablePath(dir, "../outside.txt")).toBeNull();
    expect(await writablePath(dir, "ok")).toBeNull(); // a folder, not a file
  });

  it.skipIf(process.platform === "win32")("refuses paths through symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "glimpse-outside-"));
    try {
      await symlink(outside, join(dir, "shared"));
      await writeFile(join(outside, "theme.css"), "PRECIOUS");
      await symlink(join(outside, "theme.css"), join(dir, "theme.css"));
      expect(await writablePath(dir, "shared/theme.css")).toBeNull();
      expect(await writablePath(dir, "theme.css")).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("History", () => {
  it("keeps the real source when a dot-folder alone has more files than the cap", async () => {
    for (let i = 0; i < MAX_FILES + 5; i++) await put(`.docs/p${String(i).padStart(4, "0")}.md`, `${i}`);
    for (let i = 0; i < 50; i++) await put(`.venv/lib/m${i}.py`, `${i}`);
    await put("index.html", "<p>hi</p>");
    const { snapshot } = await history.snapshot("initial", "Opened");
    expect(snapshot.files["index.html"]).toBeDefined();
    expect(Object.keys(snapshot.files).some((p) => p.startsWith(".venv/"))).toBe(false);
    expect(snapshot.cappedAfter).toBe(".docs/p1998.md");
  }, 60_000);

  it("restore leaves files alone that the snapshot can't speak for (past its file cap)", async () => {
    for (let i = 0; i <= MAX_FILES; i++) await put(`f${String(i).padStart(4, "0")}.txt`, `v${i}`);
    const { snapshot: s1 } = await history.snapshot("initial", "Opened");
    expect(Object.keys(s1.files)).toHaveLength(MAX_FILES);
    expect(s1.cappedAfter).toBe("f1999.txt");

    await rm(join(dir, "f0000.txt"));
    const r = await history.restore(s1.id);
    expect(r.written).toEqual(["f0000.txt"]);
    expect(r.deleted).toEqual([]);
    expect(r.skipped).toEqual(["f2000.txt"]);
    // It existed when s1 was taken, it just wasn't versioned.
    expect(await readFile(join(dir, "f2000.txt"), "utf8")).toBe("v2000");
  }, 60_000);

  it("restore never overwrites a file no backup holds (too big to version)", async () => {
    await put("index.html", "<p>A</p>");
    await put("data.json", "small");
    const { snapshot: s1 } = await history.snapshot("initial", "Opened");
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
    await put("data.json", big);
    await put("index.html", "<p>B</p>");

    const r = await history.restore(s1.id);
    expect(r.written).toEqual(["index.html"]);
    expect(r.skipped).toEqual(["data.json"]);
    expect((await stat(join(dir, "data.json"))).size).toBe(big.length);
    // Undoing the restore doesn't delete it either: it isn't in either version.
    const undo = await history.restore(r.backup!.id);
    expect(undo.deleted).toEqual([]);
    expect(existsSync(join(dir, "data.json"))).toBe(true);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<p>B</p>");
  });

  it("restore deletes before it writes, so a file can become a folder and back", async () => {
    await put("a/b.txt", "in a folder");
    const { snapshot: s1 } = await history.snapshot("initial", "Opened");
    await rm(join(dir, "a"), { recursive: true });
    await put("a", "now a file");
    const { snapshot: s2 } = await history.snapshot("manual", "File");

    const r = await history.restore(s1.id);
    expect(r).toMatchObject({ deleted: ["a"], written: ["a/b.txt"] });
    expect(await readFile(join(dir, "a", "b.txt"), "utf8")).toBe("in a folder");

    // And back: the emptied folder goes, so the file can take its place.
    const back = await history.restore(s2.id);
    expect(back).toMatchObject({ deleted: ["a/b.txt"], written: ["a"] });
    expect(await readFile(join(dir, "a"), "utf8")).toBe("now a file");
  });

  it.skipIf(process.platform === "win32")("restore doesn't write through a folder that became a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "glimpse-outside-"));
    try {
      await put("lib/a.js", "s1 content");
      const { snapshot: s1 } = await history.snapshot("initial", "Opened");
      await rm(join(dir, "lib"), { recursive: true });
      await writeFile(join(outside, "a.js"), "OUTSIDE ORIGINAL");
      await symlink(outside, join(dir, "lib"));

      const r = await history.restore(s1.id);
      expect(r.skipped).toEqual(["lib/a.js"]);
      expect(await readFile(join(outside, "a.js"), "utf8")).toBe("OUTSIDE ORIGINAL");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("saves the restored state as the newest version, so the AI's next round compares against it", async () => {
    await put("index.html", "<p>A</p>");
    const { snapshot: s1 } = await history.snapshot("initial", "Opened");
    await put("index.html", "<p>B</p>");
    const s2 = await history.aiRound();
    expect(s2).toMatchObject({ id: "s2", kind: "ai" });

    const r = await history.restore(s1.id);
    expect(r.backup).toMatchObject({ id: "s2" });
    expect(r.snapshot).toMatchObject({ id: "s3", kind: "restore", label: "Restored Opened" });

    await put("index.html", "<p>C</p>");
    const s4 = await history.aiRound();
    expect(s4).toMatchObject({ id: "s4", kind: "ai" });
    // What the editor compares the last round against: the version right before it.
    expect(await history.readFile("s3", "index.html")).toEqual(Buffer.from("<p>A</p>"));
  });

  it("grows one AI round until the agent waits for the human, then starts a new one", async () => {
    await put("index.html", "<p>A</p>");
    await history.snapshot("initial", "Opened");
    await put("a.css", "a");
    const round = await history.aiRound();
    expect(round).toMatchObject({ id: "s2", label: "AI edited a.css" });
    await history.setThumb("s2", Buffer.from("png"));

    await put("b.css", "b");
    const grown = await history.aiRound();
    expect(grown).toMatchObject({ id: "s2", label: "AI edited a.css, b.css", thumb: false });
    expect(history.list().map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(events.at(-1)).toMatchObject(["updated", { id: "s2", label: "AI edited a.css, b.css" }]);

    // Saves still pending when the agent waits belong to the round that ends.
    await put("c.css", "c");
    expect(await history.endRound(true)).toMatchObject({ id: "s2", label: "AI edited a.css, b.css, c.css" });
    await put("d.css", "d");
    expect(await history.aiRound()).toMatchObject({ id: "s3", label: "AI edited d.css" });
  });

  it("records unsaved AI changes as their round before another snapshot", async () => {
    await put("index.html", "<p>A</p>");
    await history.snapshot("initial", "Opened");
    await put("index.html", "<p>B</p>");
    const { snapshot, created } = await history.snapshot("handoff", "Sent 1 change to the AI");
    expect(created).toBe(true);
    expect(snapshot).toMatchObject({ id: "s2", kind: "ai", label: "AI edited index.html" });
    // Nothing left for the quiet-period timer to record.
    expect(await history.aiRound()).toBeNull();
  });

  it("keeps an unreadable history file instead of overwriting it, and ignores bad ids", async () => {
    await mkdir(history.root, { recursive: true });
    await writeFile(join(history.root, "snapshots.json"), '[{"id":"s1","seq":1,"files":{}');
    await history.load();
    expect(history.list()).toEqual([]);
    expect((await readdir(history.root)).some((n) => n.startsWith("snapshots.json.unreadable-"))).toBe(true);

    const bad = [
      { id: "s1", seq: 1, at: "", kind: "initial", label: "ok", files: {}, thumb: false },
      { id: "..\\..\\x", seq: 2, at: "", kind: "ai", label: "bad", files: {}, thumb: false },
    ];
    await writeFile(join(history.root, "snapshots.json"), JSON.stringify(bad));
    const fresh = new History(dir);
    await fresh.load();
    expect(fresh.list().map((s) => s.id)).toEqual(["s1"]);
  });

  it("finds a file ignoring case when asked to (macOS and Windows)", async () => {
    await put("img/hero.jpg", "jpg");
    const { snapshot } = await history.snapshot("initial", "Opened");
    expect(history.findPath(snapshot.id, "img/Hero.jpg", false)).toBeNull();
    expect(history.findPath(snapshot.id, "img/Hero.jpg", true)).toBe("img/hero.jpg");
    expect(history.findPath(snapshot.id, "img/hero.jpg", false)).toBe("img/hero.jpg");
  });
});

describe("History storage", () => {
  it("stores each version as its changes from the one before, and loads them back", async () => {
    await put("a.txt", "a1");
    await put("b.txt", "b1");
    const first = (await history.snapshot("initial", "Opened")).snapshot;
    await put("a.txt", "a2");
    await rm(join(dir, "b.txt"));
    await put("c/__proto__", "c1");
    const second = (await history.snapshot("manual", "Saved")).snapshot;
    const raw = JSON.parse(await readFile(join(history.root, "snapshots.json"), "utf8")) as Record<string, unknown>[];
    expect(raw[0]!.files).toBeDefined();
    expect(raw[1]!.files).toBeUndefined();
    expect(Object.keys(raw[1]!.changes as object).sort()).toEqual(["a.txt", "b.txt", "c/__proto__"]);

    const again = new History(dir, { warn: () => undefined });
    await again.load();
    expect(again.list()).toEqual(history.list());
    expect({ ...again.get(first.id)!.files }).toEqual({ ...first.files });
    expect({ ...again.get(second.id)!.files }).toEqual({ ...second.files });
    expect(String(await again.readFile(second.id, "c/__proto__"))).toBe("c1");
  });

  it("prunes the oldest AI rounds and the file contents only they held", async () => {
    const pruned: string[] = [];
    history = new History(dir, { warn: () => undefined, keepAiRounds: 2, onPruned: (ids) => pruned.push(...ids) });
    await put("page.html", "v0");
    const initial = (await history.snapshot("initial", "Opened")).snapshot;
    const objects = () => readdir(join(history.root, "objects"));
    for (let i = 1; i <= 23; i++) {
      await put("page.html", `v${i}`);
      await history.endRound(true);
    }
    expect(pruned).toEqual([]);
    expect(await objects()).toHaveLength(24);
    await put("page.html", "v24");
    await history.endRound(true);
    // 24 rounds: all but the newest two (and the newest version) go.
    expect(pruned).toHaveLength(21);
    const left = history.list();
    expect(left.map((s) => s.kind)).toEqual(["initial", "ai", "ai", "ai"]);
    expect(left[0]!.id).toBe(initial.id);
    expect(await objects()).toHaveLength(4);
    expect(String(await history.readFile(left.at(-1)!.id, "page.html"))).toBe("v24");
    expect(String(await history.readFile(initial.id, "page.html"))).toBe("v0");

    // Content whose object was pruned is stored again when it comes back.
    await put("page.html", "v5");
    await history.endRound(true);
    const latest = history.list().at(-1)!;
    expect(String(await history.readFile(latest.id, "page.html"))).toBe("v5");
  });
});
