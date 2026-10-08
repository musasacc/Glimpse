import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  describeChange,
  parseSceneFile,
  SCENE_FILE_NAME,
  SceneFileSyntaxError,
  serializeSceneFile,
  type Change,
  type ChangeList,
  type ParsedSceneFile,
  type Scene,
  type SceneFileExtras,
  type SceneFileFormat,
  type SceneNode,
  type Target,
} from "@glimpse/core";
import type { FilePatch, PatchPlan } from "./patch-html.js";

/**
 * glimpse.scene.json on disk: reading it for the editor, and writing the
 * human's edited scene back in the same form (nested or flat) with the same
 * $schema/theme/meta, as a reviewable diff.
 */

export interface SceneRead extends ParsedSceneFile {
  /** Project-relative path of the scene file, with forward slashes. */
  file: string;
  /** The file's text as it is on disk. */
  text: string;
  /** Content hash of `text`. Hand it back to planScenePatch to refuse writing over a newer file. */
  version: string;
  /**
   * Set when the file isn't valid JSON (often: the agent is halfway through writing it).
   * `scene` is then an empty placeholder and `errors` holds the message; keep showing the last good scene.
   */
  invalid?: { message: string; line?: number; column?: number };
}

/** The scene file changed on disk since the editor read it. */
export class SceneConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "SceneConflictError";
  }
}

/** Ops that never change the scene file: notes for the AI, and editor-only state. */
const NOT_IN_SCENE = new Set<Change["op"]>(["comment", "behavior", "region", "setLocked"]);
/** Ops the AI never needs to act on. */
const EDITOR_ONLY = new Set<Change["op"]>(["setLocked"]);

export function sceneVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Read and parse the scene file; null when it doesn't exist. Never throws for bad content. */
export async function readScene(dir: string, entry: string = SCENE_FILE_NAME): Promise<SceneRead | null> {
  const path = scenePath(dir, entry);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const file = relFile(entry);
  const version = sceneVersion(text);
  try {
    return { ...parseSceneFile(text), file, text, version };
  } catch (err) {
    if (!(err instanceof SceneFileSyntaxError)) throw err;
    // Guess enough from the broken text to keep the editor in the right mode.
    const target = /"target"\s*:\s*"native"/.test(text) ? "native" : "tui";
    const empty = parseSceneFile(JSON.stringify({ target, root: { type: "root" } })).scene;
    return {
      scene: empty,
      errors: [err.message],
      format: /"nodes"\s*:/.test(text) && !/"root"\s*:/.test(text) ? "flat" : "nested",
      extras: {},
      file,
      text,
      version,
      invalid: { message: err.message, ...(err.line !== undefined && { line: err.line, column: err.column }) },
    };
  }
}

export interface ScenePatchPlan extends PatchPlan {
  /** Version of the scene file the plan was made against (null when it didn't exist). */
  version: string | null;
}

/**
 * Plan "Edit source" for a scene target: write `finalScene` (the editor's scene
 * after the human's edits) back into the scene file, keeping its form and extras.
 * Nothing is written here; `applyScenePatch` does that after the human approves.
 *
 * - `applied`: the changes the scene file reflects (all but comments, behaviors, regions and locks).
 * - `needsAi`: every change except editor-only ones: the real code still has to be updated by the AI.
 *
 * With `expectedVersion` (from `readScene`), a file that changed since then is refused with a SceneConflictError.
 */
export async function planScenePatch(
  dir: string,
  entry: string,
  finalScene: Scene,
  changes: Change[],
  opts: { expectedVersion?: string } = {},
): Promise<ScenePatchPlan> {
  const current = await readScene(dir, entry);
  if (current?.invalid) {
    throw new SceneConflictError(`${current.file} isn't valid JSON right now (${current.invalid.message}). Wait for the agent to finish writing it, or fix it.`);
  }
  if (opts.expectedVersion !== undefined && (current?.version ?? null) !== opts.expectedVersion) {
    throw new SceneConflictError(`${relFile(entry)} changed on disk since the editor loaded it. Reload the scene and redo the edits.`);
  }

  const before = current?.text ?? "";
  const format: SceneFileFormat = current?.format ?? "nested";
  const extras: SceneFileExtras = current?.extras ?? {};
  const scene = withFileLocks(finalScene, current?.scene);
  const after = serializeSceneFile(scene, format, extras);

  const file = relFile(entry);
  const files: FilePatch[] = after === before ? [] : [{ file, before, after, diff: createTwoFilesPatch(file, file, before, after, "", "", { context: 3 }) }];
  return {
    files,
    applied: changes.filter((c) => !NOT_IN_SCENE.has(c.op)),
    needsAi: changes.filter((c) => !EDITOR_ONLY.has(c.op)),
    version: current?.version ?? null,
  };
}

/** Write a planned scene patch. Callers make backups first. Returns the files written. */
export async function applyScenePatch(dir: string, plan: Pick<PatchPlan, "files">): Promise<string[]> {
  for (const f of plan.files) {
    const path = scenePath(dir, f.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.after);
  }
  return plan.files.map((f) => f.file);
}

/** Locks are editor-only: the file keeps the lock state it had, and new nodes are written unlocked. */
function withFileLocks(scene: Scene, fileScene: Scene | undefined): Scene {
  const out: Scene = { ...scene, nodes: {} };
  for (const [id, node] of Object.entries(scene.nodes)) {
    const copy: SceneNode = { ...node };
    if (fileScene?.nodes[id]?.locked) copy.locked = true;
    else delete copy.locked;
    out.nodes[id] = copy;
  }
  return out;
}

function scenePath(dir: string, entry: string): string {
  const root = resolve(dir);
  const path = normalize(join(root, entry));
  if (!path.startsWith(root + sep)) throw new Error(`The scene file must be inside the project: ${entry}`);
  return path;
}

function relFile(entry: string): string {
  return normalize(entry).split(sep).join("/").replace(/^\.\//, "");
}

/* ── Prompt helpers ───────────────────────────────────────────────────── */

const FRAMEWORKS: Record<string, string> = {
  textual: "Textual (Python)",
  rich: "Rich (Python)",
  curses: "curses (Python)",
  prompt_toolkit: "prompt_toolkit (Python)",
  urwid: "urwid (Python)",
  ink: "Ink (React for the terminal)",
  blessed: "blessed (Node.js)",
  ratatui: "Ratatui (Rust)",
  cursive: "Cursive (Rust)",
  bubbletea: "Bubble Tea (Go)",
  tview: "tview (Go)",
  tkinter: "Tkinter (Python)",
  pyqt: "PyQt (Python)",
  pyside: "PySide (Python)",
  qt: "Qt",
  wxpython: "wxPython",
  gtk: "GTK",
  swiftui: "SwiftUI",
  appkit: "AppKit",
  winforms: "Windows Forms (.NET)",
  wpf: "WPF (.NET)",
  avalonia: "Avalonia (.NET)",
  javafx: "JavaFX",
  swing: "Swing (Java)",
  egui: "egui (Rust)",
  iced: "iced (Rust)",
  slint: "Slint",
  fyne: "Fyne (Go)",
  flutter: "Flutter",
  kivy: "Kivy (Python)",
};

/**
 * One phrase naming the real app, e.g. "a Textual (Python) terminal UI, run with `python app.py`"
 * or "a desktop GUI".
 */
export function describeSceneTarget(target: Target, extras: SceneFileExtras = {}): string {
  const kind = target === "native" ? "desktop GUI" : target === "tui" ? "terminal UI" : target === "react" ? "React app" : "web page";
  const fw = extras.meta?.framework?.trim();
  const name = fw ? (FRAMEWORKS[fw.toLowerCase().replace(/[\s-]/g, "")] ?? fw) : "";
  const command = extras.meta?.command?.trim();
  const article = name ? (/^[aeiou]/i.test(name) ? "an" : "a") : "a";
  return `${article} ${name ? `${name} ` : ""}${kind}${command ? `, run with \`${command}\`` : ""}`;
}

/**
 * The instructions for the AI when the human edited a scene (TUI/native) mock.
 * With `sceneWritten`, Glimpse has already saved the edited scene, so only the code is left.
 */
export function sceneChangesPrompt(list: ChangeList, opts: { file?: string; extras?: SceneFileExtras; sceneWritten: boolean }): string {
  const file = opts.file ?? SCENE_FILE_NAME;
  const target = list.target === "native" ? "native" : "tui";
  const units = target === "tui" ? "terminal cells (columns and rows)" : "pixels";
  const lines = [
    `In Glimpse, the human edited the mock of ${describeSceneTarget(list.target, opts.extras)}. Apply these changes 1:1 to the real source code.`,
    opts.sceneWritten
      ? `${file} already matches the edited mock; only update it again if your code ends up different.`
      : `Then update ${file} to match, so the mock stays in sync with the code.`,
    `Positions and sizes are in ${units}, relative to the parent widget. Express moves and resizes with the toolkit's own layout (containers, docking, CSS, grid/pack options, constraints) rather than absolute positions; use the intent hints.`,
    "",
  ];
  if (list.note) lines.push(`Note from the human: ${list.note}`, "");
  if (list.changes.length === 0) lines.push("No changes were made.");
  list.changes.forEach((c, i) => lines.push(`${i + 1}. ${describeChange(c)}`));
  return lines.join("\n");
}
