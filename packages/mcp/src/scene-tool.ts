import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  parseSceneFile,
  SCENE_AUTHORING_GUIDE,
  SCENE_EXAMPLES,
  SCENE_FILE_NAME,
  SCENE_JSON_SCHEMA,
  SceneFileSyntaxError,
  serializeSceneFile,
} from "@glimpse/core";

export interface SceneToolOptions {
  /** Directory to look in when glimpse_scene_validate gets no path (e.g. the last opened project). */
  defaultDir?: () => string | undefined;
}

/** The two built-in examples as markdown: the real code, then the scene file that describes it. */
export function sceneExamplesText(): string {
  return SCENE_EXAMPLES.map((ex) => {
    const parsed = parseSceneFile(JSON.stringify(ex.scene));
    const scene = serializeSceneFile(parsed.scene, parsed.format, parsed.extras);
    const code = Object.entries(ex.files)
      .map(([file, text]) => `${file}:\n\`\`\`${file.endsWith(".py") ? "python" : ""}\n${text}\`\`\``)
      .join("\n\n");
    return `## Example: ${ex.title}\n\n${code}\n\n${SCENE_FILE_NAME}:\n\`\`\`json\n${scene}\`\`\``;
  }).join("\n\n");
}

/**
 * Register the scene-file tools: glimpse_scene_schema (format, guide, examples)
 * and glimpse_scene_validate (check a file the agent wrote).
 */
export function registerSceneTools(mcp: McpServer, opts: SceneToolOptions = {}): void {
  const text = (t: string) => ({ type: "text" as const, text: t });

  mcp.registerTool(
    "glimpse_scene_schema",
    {
      title: "Scene file format",
      description:
        "How to describe a terminal UI (Textual, Ink, Ratatui, Bubble Tea, …) or a native desktop GUI (Tkinter, Qt, …) for Glimpse in glimpse.scene.json, so the human can edit it visually: an authoring guide (units, node types, meta.command, source locations), two small examples (Textual, Tkinter) and the JSON Schema. Read it before writing a glimpse.scene.json.",
    },
    async () => ({
      content: [
        text(SCENE_AUTHORING_GUIDE),
        text(sceneExamplesText()),
        text(`JSON Schema of ${SCENE_FILE_NAME} (draft 2020-12):\n\`\`\`json\n${JSON.stringify(SCENE_JSON_SCHEMA, null, 2)}\n\`\`\``),
      ],
    }),
  );

  mcp.registerTool(
    "glimpse_scene_validate",
    {
      title: "Check a scene file",
      description:
        "Check a glimpse.scene.json for problems (invalid JSON with line and column, unknown types or keys, missing layout, broken parent/child links, …). Pass the file, its project directory, or the JSON text.",
      inputSchema: {
        path: z.string().optional().describe(`Scene file, or the project directory that contains ${SCENE_FILE_NAME} (default: the current project)`),
        text: z.string().optional().describe("Scene JSON to check instead of a file"),
      },
    },
    async ({ path, text: json }) => {
      let source = "the given text";
      if (json === undefined) {
        let file = resolve(path ?? opts.defaultDir?.() ?? process.cwd());
        if (await isDir(file)) file = join(file, SCENE_FILE_NAME);
        try {
          json = await readFile(file, "utf8");
        } catch {
          return { content: [text(`No scene file at ${file}. Write one first (see glimpse_scene_schema).`)], isError: true };
        }
        source = file;
      }

      let parsed;
      try {
        parsed = parseSceneFile(json);
      } catch (err) {
        if (!(err instanceof SceneFileSyntaxError)) throw err;
        return { content: [text(`${source}: ${err.message}`)], isError: true };
      }

      const nodes = Object.values(parsed.scene.nodes);
      const summary = `${parsed.scene.target} scene with ${nodes.length} node${nodes.length === 1 ? "" : "s"} (${parsed.format} form)`;
      const tips: string[] = [];
      if (!parsed.extras.meta?.command) tips.push('Set meta.command (e.g. "python app.py") so Glimpse can run the real app next to the mock.');
      const unlocated = nodes.filter((n) => !n.source && n.id !== parsed.scene.rootId).length;
      if (unlocated) tips.push(`${unlocated} widget${unlocated === 1 ? " has" : "s have"} no "source"; add { file, line, col } so the human's edits point at the code.`);
      const tipText = tips.length ? `\n\nTips:\n${tips.map((t) => `- ${t}`).join("\n")}` : "";

      if (parsed.errors.length === 0) return { content: [text(`${source}: no problems found. ${summary}.${tipText}`)] };
      const list = parsed.errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
      return {
        content: [text(`${source}: ${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"} in a ${summary}. Glimpse works around them, but please fix them:\n${list}${tipText}`)],
        isError: true,
      };
    },
  );
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
