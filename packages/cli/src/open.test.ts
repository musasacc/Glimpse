import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The built CLI (`pnpm build`); these tests run it as the user would. */
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.pid) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function glimpse(args: string[]): { child: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d));
  child.stderr!.on("data", (d: Buffer) => (out += d));
  const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  return { child, out: () => out, exited };
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!existsSync(CLI) || process.platform === "win32")("glimpse open", () => {
  it("reuses the Glimpse already running for the folder, and only removes its own server.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glimpse-cli-"));
    dirs.push(dir);
    await writeFile(join(dir, "index.html"), "<!doctype html><p>hi</p>");
    const info = join(dir, ".glimpse", "server.json");

    const first = glimpse(["open", dir, "--no-browser", "--port", "0"]);
    await until(() => first.out().includes("Live mode is on"));
    const own = JSON.parse(await readFile(info, "utf8")) as { url: string; pid: number };
    expect(own.pid).toBe(first.child.pid);

    // A second `glimpse open` of the same folder uses the first one instead of starting another server.
    const second = glimpse(["open", dir, "--no-browser", "--port", "0"]);
    expect(await second.exited).toBe(0);
    expect(second.out()).toContain("already open");
    expect(second.out()).toContain(own.url);
    expect(JSON.parse(await readFile(info, "utf8"))).toEqual(own);

    // Another Glimpse wrote its own server.json since: stopping this one leaves that file alone.
    const other = { url: "http://127.0.0.1:1", pid: 999_999_999 };
    await writeFile(info, JSON.stringify(other));
    first.child.kill("SIGTERM");
    await first.exited;
    expect(JSON.parse(await readFile(info, "utf8"))).toEqual(other);
  }, 30_000);
});
