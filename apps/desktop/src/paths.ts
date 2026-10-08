import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Absolute path with symlinks resolved when possible (so /tmp and /private/tmp are one project on macOS). */
export function canonicalDir(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Key for comparing project folders: canonical, and case-insensitive on Windows. */
export function dirKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  const p = canonicalDir(dir);
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Folder name for window titles and lists ("C:\\" and "/" fall back to the full path). */
export function folderName(dir: string): string {
  return basename(dir) || dir;
}
