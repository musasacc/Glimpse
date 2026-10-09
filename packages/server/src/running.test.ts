import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameDir, servesProject, startServer, withProjectLock } from "./index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "glimpse-running-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("finding a running Glimpse", () => {
  it("compares folders the way the file system does", () => {
    expect(sameDir(root, join(root, "."))).toBe(true);
    expect(sameDir("/Users/Me/App", "/users/me/app", "darwin")).toBe(true);
    expect(sameDir("/home/me/App", "/home/me/app", "linux")).toBe(false);
  });

  it("only reuses a server that shows the same project", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    const srv = await startServer({ dir: b, port: 0 });
    try {
      // A server.json left behind in A by a killed Glimpse, pointing at the port B's Glimpse has now.
      expect(await servesProject(srv.url, b)).toBe(true);
      expect(await servesProject(srv.url, a)).toBe(false);
    } finally {
      await srv.close();
    }
    expect(await servesProject(srv.url, b, 500)).toBe(false);
  });
});

describe("withProjectLock", () => {
  it("runs one opener at a time per folder", async () => {
    const order: string[] = [];
    const run = (name: string) =>
      withProjectLock(root, async () => {
        order.push(`${name} in`);
        await new Promise((r) => setTimeout(r, 150));
        order.push(`${name} out`);
      });
    await Promise.all([run("a"), run("b")]);
    // Either may go first; what matters is that they never overlap.
    expect([
      ["a in", "a out", "b in", "b out"],
      ["b in", "b out", "a in", "a out"],
    ]).toContainEqual(order);
    expect(existsSync(join(root, ".glimpse", "server.lock"))).toBe(false);
  });

  it("takes over a lock whose process is gone", async () => {
    await mkdir(join(root, ".glimpse"), { recursive: true });
    await writeFile(join(root, ".glimpse", "server.lock"), "999999999");
    const t0 = Date.now();
    expect(await withProjectLock(root, async () => "ran")).toBe("ran");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("releases the lock when the opener fails", async () => {
    await expect(withProjectLock(root, async () => Promise.reject(new Error("port trouble")))).rejects.toThrow("port trouble");
    expect(existsSync(join(root, ".glimpse", "server.lock"))).toBe(false);
  });
});
