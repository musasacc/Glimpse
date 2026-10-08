import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "@glimpse/core";

export interface ProjectInfo {
  dir: string;
  target: Target;
  /** Entry file relative to `dir` (HTML page or scene file). */
  entry: string;
}

export const SCENE_FILE = "glimpse.scene.json";

/** Work out what kind of UI lives in `dir` and which file to open first. */
export function detectProject(dir: string, override?: { target?: Target; entry?: string }): ProjectInfo {
  if (override?.target && override.entry) return { dir, target: override.target, entry: override.entry };

  const scenePath = join(dir, override?.entry ?? SCENE_FILE);
  if (existsSync(scenePath) && scenePath.endsWith(".json")) {
    const text = readFileSync(scenePath, "utf8");
    let target: Target | undefined;
    try {
      target = (JSON.parse(text) as { target?: Target }).target;
    } catch {
      // The agent may be halfway through writing it; the editor shows the error once it loads.
      target = /"target"\s*:\s*"native"/.test(text) ? "native" : undefined;
    }
    return { dir, target: override?.target ?? target ?? "tui", entry: override?.entry ?? SCENE_FILE };
  }
  // A terminal UI or desktop GUI whose scene file the agent hasn't written yet.
  if (override?.target === "tui" || override?.target === "native") return { dir, target: override.target, entry: SCENE_FILE };

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.react && (override?.target ?? "react") === "react") {
      return { dir, target: "react", entry: override?.entry ?? "index.html" };
    }
  }

  return { dir, target: override?.target ?? "html", entry: override?.entry ?? "index.html" };
}
