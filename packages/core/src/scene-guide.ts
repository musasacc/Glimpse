import { NODE_TYPES } from "./scene.js";
import { NODE_TYPE_DOCS } from "./scene-schema.js";
import { SCENE_SCHEMA_URL, type SceneFile } from "./scene-file.js";

/** How to write glimpse.scene.json, for AI agents (served by the MCP tool glimpse_scene_schema). */
export const SCENE_AUTHORING_GUIDE = `# Writing glimpse.scene.json

Glimpse can't edit a terminal UI or a desktop window live, so you describe its layout in glimpse.scene.json in the
project directory. Glimpse renders an editable mock of it (a cell grid for TUIs, themed widgets for native GUIs).
The human moves, resizes, retexts, restyles, adds and deletes widgets there; Glimpse writes the result back into
glimpse.scene.json and hands you the edits as numbered instructions with file:line:col. You apply them to the real
code (Textual, Ink, Ratatui, Bubble Tea, Tkinter, Qt, …). The scene file is already updated when you get them;
only touch it again if the code ends up different from it.

1. Form. Use the nested form:
   { "$schema": "${SCENE_SCHEMA_URL}",
     "target": "tui" | "native", "meta": { … }, "root": { "type": "root", "layout": { … }, "children": [ … ] } }
   (The flat form { "target", "rootId", "nodes": { "<id>": { …, "children": ["<id>", …] } } } is also accepted.)
2. Units. layout is { "x", "y", "w", "h" }, relative to the parent's top-left corner.
   - tui: whole character cells. The root is the terminal: w×h = columns×rows (80×24 unless the app needs more).
   - native: pixels. The root is the window's client area (no title bar). Make it type "window" with props.title.
   Give the size each widget really occupies on screen, borders included.
3. Mirror the real widget tree: one node per widget or container the code creates, with the same nesting and order.
   Set "tag" to the real class ("Header", "ListView", "ttk.Entry", "QPushButton", "<Box>").
4. "source": { "file": "app.py", "line": 42, "col": 15 }, the 1-based position where the widget is created
   (the constructor call or JSX tag; paths relative to the project, forward slashes). Set it for every widget you can:
   the human's edits come back pointing at it.
5. Ids are optional. Give readable ids that match the code's own ids or variable names (id="todos" → "todos"),
   and keep them stable when you rewrite the file so unsent edits survive. Missing ids are generated from type and
   position ("button-0", "sidebar.button-2").
6. "meta": { "framework": "textual", "command": "python app.py", "title": "…" }. "command" is how to run the real
   app from the project directory ("python app.py", "npm start", "cargo run", "go run ."), spelled the way it runs on
   this machine (macOS and many Linux systems only have "python3", Windows usually "python" or "py"); Glimpse runs a
   TUI in its built-in terminal next to the mock so the human can compare.
7. "theme" (native only): "macos" | "windows" | "linux", the look of the mock. Omit it to use the human's OS.
8. "props" hold content and state; text goes in props.text. List-like props ("items", "columns") are arrays,
   table rows are arrays of cells. Flags ("checked", "disabled", "password", …) are booleans and "selected",
   "value", "min", "max" are numbers.
9. "style" holds CSS-like strings. tui: color, background, text-style ("bold underline"), border ("round",
   "heavy", "double", "solid", …), text-align, padding. native: color, background, font-size, font-weight, border,
   border-radius, padding, opacity.
10. Keep the scene in sync: whenever you change the UI in code, update glimpse.scene.json in the same step so the
    mock stays faithful. Check it with the glimpse_scene_validate tool; Glimpse also shows problems it finds.

Node types (pick the closest, put the real class in "tag"):
${NODE_TYPES.map((t) => `- ${t}: ${NODE_TYPE_DOCS[t]}`).join("\n")}
`;

export interface SceneExample {
  name: string;
  title: string;
  /** The real code the scene describes, by project-relative path. */
  files: Record<string, string>;
  scene: SceneFile;
}

const TEXTUAL_APP = `from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import Footer, Header, Input, Label, ListItem, ListView


class NotesApp(App):
    CSS = "#notes { width: 30; border: round $accent; } #editor { width: 1fr; }"
    BINDINGS = [("q", "quit", "Quit")]

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="body"):
            yield ListView(ListItem(Label("Groceries")), ListItem(Label("Ideas")), id="notes")
            yield Input(placeholder="Write a note…", id="editor")
        yield Footer()


if __name__ == "__main__":
    NotesApp().run()
`;

const TKINTER_APP = `import tkinter as tk
from tkinter import ttk

root = tk.Tk()
root.title("Sign in")
root.geometry("320x168")

form = ttk.Frame(root, padding=16)
form.pack(fill="both", expand=True)
ttk.Label(form, text="Email").grid(row=0, column=0, sticky="w", padx=(0, 8))
email = ttk.Entry(form, width=28)
email.grid(row=0, column=1, sticky="ew")
remember = ttk.Checkbutton(form, text="Remember me")
remember.grid(row=1, column=1, sticky="w", pady=12)
ttk.Button(form, text="Sign in", default="active").grid(row=2, column=1, sticky="e")

root.mainloop()
`;

/** Two small, complete examples: a Textual TUI and a Tkinter window, each with the code it describes. */
export const SCENE_EXAMPLES: SceneExample[] = [
  {
    name: "textual",
    title: "A Textual terminal UI (80×24 cells)",
    files: { "app.py": TEXTUAL_APP },
    scene: {
      target: "tui",
      meta: { framework: "textual", command: "python app.py", title: "NotesApp" },
      root: {
        type: "root",
        tag: "NotesApp",
        layout: { x: 0, y: 0, w: 80, h: 24 },
        source: { file: "app.py", line: 6, col: 7 },
        children: [
          {
            type: "statusbar",
            tag: "Header",
            layout: { x: 0, y: 0, w: 80, h: 1 },
            props: { text: "NotesApp" },
            source: { file: "app.py", line: 11, col: 15 },
          },
          {
            id: "body",
            type: "box",
            tag: "Horizontal",
            layout: { x: 0, y: 1, w: 80, h: 22 },
            source: { file: "app.py", line: 12, col: 14 },
            children: [
              {
                id: "notes",
                type: "list",
                tag: "ListView",
                layout: { x: 0, y: 0, w: 30, h: 22 },
                style: { border: "round $accent" },
                props: { items: ["Groceries", "Ideas"], selected: 0 },
                source: { file: "app.py", line: 13, col: 19 },
              },
              {
                id: "editor",
                type: "input",
                tag: "Input",
                layout: { x: 30, y: 0, w: 50, h: 3 },
                props: { placeholder: "Write a note…" },
                source: { file: "app.py", line: 14, col: 19 },
              },
            ],
          },
          {
            type: "statusbar",
            tag: "Footer",
            layout: { x: 0, y: 23, w: 80, h: 1 },
            props: { items: ["q Quit", "^p palette"] },
            source: { file: "app.py", line: 15, col: 15 },
          },
        ],
      },
    },
  },
  {
    name: "tkinter",
    title: "A Tkinter window (pixels)",
    files: { "app.py": TKINTER_APP },
    scene: {
      target: "native",
      theme: "linux",
      meta: { framework: "tkinter", command: "python app.py", title: "Sign in" },
      root: {
        type: "window",
        tag: "Tk",
        layout: { x: 0, y: 0, w: 320, h: 168 },
        props: { title: "Sign in" },
        source: { file: "app.py", line: 4, col: 8 },
        children: [
          {
            id: "form",
            type: "box",
            tag: "ttk.Frame",
            layout: { x: 0, y: 0, w: 320, h: 168 },
            style: { padding: "16px" },
            source: { file: "app.py", line: 8, col: 8 },
            children: [
              {
                type: "label",
                tag: "ttk.Label",
                layout: { x: 16, y: 20, w: 40, h: 20 },
                props: { text: "Email" },
                source: { file: "app.py", line: 10, col: 1 },
              },
              {
                id: "email",
                type: "input",
                tag: "ttk.Entry",
                layout: { x: 64, y: 16, w: 240, h: 28 },
                source: { file: "app.py", line: 11, col: 9 },
              },
              {
                id: "remember",
                type: "checkbox",
                tag: "ttk.Checkbutton",
                layout: { x: 64, y: 56, w: 124, h: 22 },
                props: { text: "Remember me", checked: false },
                source: { file: "app.py", line: 13, col: 12 },
              },
              {
                type: "button",
                tag: "ttk.Button",
                layout: { x: 216, y: 112, w: 88, h: 32 },
                props: { text: "Sign in", default: true },
                source: { file: "app.py", line: 15, col: 1 },
              },
            ],
          },
        ],
      },
    },
  },
];
