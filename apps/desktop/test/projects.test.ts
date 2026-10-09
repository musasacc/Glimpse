// Server lifecycle with the real Glimpse library the app ships (app/glimpse, copied from packages/cli/dist).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { startGlimpse } from "../app/glimpse/lib.js";
import { canonicalDir } from "../src/paths.js";
import { ProjectServers, type StartedServer } from "../src/projects.js";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "donut");
const root = mkdtempSync(join(tmpdir(), "glimpse-projects-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

let n = 0;
function project(): string {
  const dir = join(root, `p${n++}`);
  cpSync(example, dir, { recursive: true });
  return dir;
}

/** Port 0: never collide with a Glimpse already running on 4321. */
const started: string[] = [];
async function start(dir: string): Promise<StartedServer> {
  started.push(dir);
  const srv = await startGlimpse({ dir, port: 0 });
  return { url: srv.url, token: srv.token, close: () => srv.close() };
}

const info = (dir: string) => JSON.parse(readFileSync(join(dir, ".glimpse", "server.json"), "utf8")) as { url: string; pid: number; token?: string };
const alive = (url: string) =>
  fetch(`${url}/api/session`).then(
    (r) => r.ok,
    () => false,
  );

describe("ProjectServers", () => {
  it("starts one Glimpse per folder, serves the editor and the preview, and cleans up on close", async () => {
    const servers = new ProjectServers({ start, pid: 4242 });
    const dir = project();
    const [a, b] = await Promise.all([servers.open(dir), servers.open(dir)]);
    assert.equal(a.url, b.url, "concurrent opens share one server");
    assert.equal(a.owned, true);
    assert.equal(a.dir, canonicalDir(dir));
    assert.equal((await servers.open(join(dir, "."))).url, a.url, "same folder, different spelling");
    assert.equal(servers.size, 1);

    const home = await fetch(`${a.url}/`).then((r) => r.text());
    assert.match(home, /id="root"/, "GET / is the bundled editor");
    const preview = await fetch(`${a.url}/preview/`).then((r) => r.text());
    assert.match(preview, /Donut Shop/);
    assert.deepEqual(info(dir), { url: a.url, pid: 4242, token: info(dir).token }, "agents can find it through .glimpse/server.json");
    assert.match(info(dir).token ?? "", /^[\w-]{40,}$/, "with the token that lets the MCP server run the app there");

    await servers.close(dir);
    assert.equal(servers.size, 0);
    assert.equal(await alive(a.url), false, "server stopped");
    assert.equal(existsSync(join(dir, ".glimpse", "server.json")), false, "server.json removed");
  });

  it("reuses a Glimpse that is already running for the folder and leaves it running", async () => {
    const dir = project();
    const foreign = await startGlimpse({ dir, port: 0 });
    try {
      mkdirSync(join(dir, ".glimpse"), { recursive: true });
      writeFileSync(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: foreign.url, pid: 99999 }));
      const before = started.length;
      const servers = new ProjectServers({ start, pid: 4242 });
      const p = await servers.open(dir);
      assert.equal(p.url, foreign.url);
      assert.equal(p.owned, false);
      assert.equal(started.length, before, "didn't start a second server");
      await servers.close(dir);
      assert.equal(await alive(foreign.url), true, "a server we didn't start keeps running");
      assert.equal(info(dir).pid, 99999, "its server.json is left alone");
    } finally {
      await foreign.close();
    }
  });

  it("ignores a stale server.json and starts its own", async () => {
    const dir = project();
    mkdirSync(join(dir, ".glimpse"), { recursive: true });
    writeFileSync(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: 99999 }));
    const servers = new ProjectServers({ start, pid: 4242, probeTimeoutMs: 500 });
    const p = await servers.open(dir);
    assert.equal(p.owned, true);
    assert.notEqual(p.url, "http://127.0.0.1:9");
    assert.equal(info(dir).pid, 4242);
    await servers.closeAll();
  });

  it("closeAll stops every server", async () => {
    const servers = new ProjectServers({ start, pid: 4242 });
    const opened = await Promise.all([servers.open(project()), servers.open(project())]);
    assert.notEqual(opened[0]!.url, opened[1]!.url);
    await servers.closeAll();
    assert.equal(servers.size, 0);
    for (const p of opened) assert.equal(await alive(p.url), false);
  });

  it("rejects folders that don't exist", async () => {
    const servers = new ProjectServers({ start, pid: 4242 });
    await assert.rejects(servers.open(join(root, "missing")), /Folder not found/);
    assert.equal(servers.size, 0);
  });

  it("forgets a folder whose server failed to start, so it can be retried", async () => {
    let fail = true;
    const servers = new ProjectServers({
      start: async (dir) => {
        if (fail) throw new Error("port trouble");
        return start(dir);
      },
      pid: 4242,
    });
    const dir = project();
    await assert.rejects(servers.open(dir), /port trouble/);
    fail = false;
    const p = await servers.open(dir);
    assert.equal(p.owned, true);
    await servers.closeAll();
  });
});
