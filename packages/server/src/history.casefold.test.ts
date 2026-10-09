import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * macOS (APFS) and Windows (NTFS) ignore case by default: "Button.tsx" opens
 * "button.tsx" and keeps its name. Linux CI can't mount such a file system,
 * so the history's fs calls go through a shim that resolves every path the
 * same way, under the test's project folder only.
 */
const ROOT = { dir: "" };

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const { readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const fold = (p: unknown): unknown => {
    if (typeof p !== "string" || !ROOT.dir || !p.startsWith(ROOT.dir + path.sep)) return p;
    let cur = ROOT.dir;
    for (const part of path.relative(ROOT.dir, p).split(path.sep)) {
      let names: string[] = [];
      try {
        names = readdirSync(cur);
      } catch {
        // not a folder (yet): keep the rest as given
      }
      cur = path.join(cur, names.find((n) => n.toLowerCase() === part.toLowerCase()) ?? part);
    }
    return cur;
  };
  const wrap = <A extends unknown[], R>(fn: (...args: A) => R) => ((...args: A) => fn(...(args.map((a, i) => (i < 2 ? fold(a) : a)) as A))) as typeof fn;
  const shim = {
    ...real,
    lstat: wrap(real.lstat),
    stat: wrap(real.stat),
    readFile: wrap(real.readFile),
    writeFile: wrap(real.writeFile),
    mkdir: wrap(real.mkdir),
    rm: wrap(real.rm),
    rmdir: wrap(real.rmdir),
    readdir: wrap(real.readdir),
    rename: wrap(real.rename),
  };
  return { ...shim, default: shim };
});

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { History } = await import("./history.js");

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "glimpse-casefold-"));
  ROOT.dir = dir;
});

afterEach(async () => {
  ROOT.dir = "";
  await fs.rm(dir, { recursive: true, force: true });
});

describe("restore on a case-insensitive file system", () => {
  it("keeps a file that was only renamed by case", async () => {
    await fs.mkdir(join(dir, "components"));
    await fs.writeFile(join(dir, "components", "button.tsx"), "export const v = 1;");
    const history = new History(dir, { warn: () => undefined });
    const { snapshot: s1 } = await history.snapshot("initial", "Opened");

    // The agent's refactor: a case-only rename, plus an edit.
    await fs.rename(join(dir, "components", "button.tsx"), join(dir, "components", "Button.tsx"));
    await fs.writeFile(join(dir, "components", "Button.tsx"), "export const v = 2;");
    expect(await history.aiRound()).toMatchObject({ label: "AI edited components/Button.tsx, components/button.tsx" });

    const r = await history.restore(s1.id);
    expect(r).toMatchObject({ deleted: ["components/Button.tsx"], written: ["components/button.tsx"], skipped: [] });
    expect(await fs.readdir(join(dir, "components"))).toEqual(["button.tsx"]);
    expect(await fs.readFile(join(dir, "components", "button.tsx"), "utf8")).toBe("export const v = 1;");
  });
});
