# `glimpse.scene.json`

Glimpse edits web pages live, in an iframe. Terminal UIs and native desktop GUIs can't be edited from outside, so
the agent describes their layout in **`glimpse.scene.json`**, next to the code. Glimpse renders an editable mock of
it (a character-cell grid for a TUI, themed widgets for a native GUI), the human edits the mock, and the edits go back
to the agent, which applies them to the real code (Textual, Ink, Ratatui, Bubble Tea, Tkinter, Qt, …).

- JSON Schema: [`glimpse.scene.schema.json`](glimpse.scene.schema.json) (draft 2020-12). Point `$schema` at
  `https://raw.githubusercontent.com/musasacc/Glimpse/main/docs/glimpse.scene.schema.json` for completion in editors.
- Agents get the schema, an authoring guide and two examples from the MCP tool **`glimpse_scene_schema`**, and can
  check a file with **`glimpse_scene_validate`**.
- Complete examples: [`examples/tui-todo`](../examples/tui-todo) (Textual) and
  [`examples/native-settings`](../examples/native-settings) (Tkinter).

## A first example

A Textual app and the scene that describes it:

```python
class NotesApp(App):                                   # line 6
    CSS = "#notes { width: 30; border: round $accent; } #editor { width: 1fr; }"
    BINDINGS = [("q", "quit", "Quit")]

    def compose(self) -> ComposeResult:
        yield Header()                                 # line 11
        with Horizontal(id="body"):                    # line 12
            yield ListView(ListItem(Label("Groceries")), ListItem(Label("Ideas")), id="notes")
            yield Input(placeholder="Write a note…", id="editor")
        yield Footer()                                 # line 15
```

```json
{
  "target": "tui",
  "meta": { "framework": "textual", "command": "python app.py", "title": "NotesApp" },
  "root": {
    "type": "root",
    "tag": "NotesApp",
    "layout": { "x": 0, "y": 0, "w": 80, "h": 24 },
    "source": { "file": "app.py", "line": 6, "col": 7 },
    "children": [
      {
        "type": "statusbar",
        "tag": "Header",
        "layout": { "x": 0, "y": 0, "w": 80, "h": 1 },
        "props": { "text": "NotesApp" },
        "source": { "file": "app.py", "line": 11, "col": 15 }
      },
      {
        "id": "body",
        "type": "box",
        "tag": "Horizontal",
        "layout": { "x": 0, "y": 1, "w": 80, "h": 22 },
        "source": { "file": "app.py", "line": 12, "col": 14 },
        "children": [
          {
            "id": "notes",
            "type": "list",
            "tag": "ListView",
            "layout": { "x": 0, "y": 0, "w": 30, "h": 22 },
            "style": { "border": "round $accent" },
            "props": { "items": ["Groceries", "Ideas"], "selected": 0 },
            "source": { "file": "app.py", "line": 13, "col": 19 }
          },
          {
            "id": "editor",
            "type": "input",
            "tag": "Input",
            "layout": { "x": 30, "y": 0, "w": 50, "h": 3 },
            "props": { "placeholder": "Write a note…" },
            "source": { "file": "app.py", "line": 14, "col": 19 }
          }
        ]
      },
      {
        "type": "statusbar",
        "tag": "Footer",
        "layout": { "x": 0, "y": 23, "w": 80, "h": 1 },
        "props": { "items": ["q Quit", "^p palette"] },
        "source": { "file": "app.py", "line": 15, "col": 15 }
      }
    ]
  }
}
```

## The file

| Key | | Meaning |
|---|---|---|
| `$schema` | optional | URL of the JSON Schema, for editor completion. Kept as it is. |
| `target` | required | `"tui"` (terminal UI, laid out in cells) or `"native"` (desktop GUI, laid out in pixels). |
| `theme` | optional, native only | `"macos"`, `"windows"` or `"linux"`: the look of the mock. Omit it to use the human's OS. |
| `meta` | optional | `framework` (`"textual"`, `"ink"`, `"ratatui"`, `"bubbletea"`, `"tkinter"`, `"qt"`, …), `command` (how to run the real app, see below) and `title`. Other keys are kept as they are. |
| `root` | nested form | The root node, with its children inline. |
| `rootId` + `nodes` | flat form | The same tree keyed by id. |

### Nested form (recommended)

Children are node objects inside `children`, in on-screen (and code) order. Ids are optional: a node without one gets
an id from its type and its index among siblings of the same type, under its parent's id: `button-0`, `statusbar-1`,
`details.button-0`. Adding a widget of another type doesn't change them. When Glimpse writes the file back, it only
writes ids that differ from the generated ones (for example after the human reordered two buttons).

### Flat form

The shape of Glimpse's internal `Scene`: every node keyed by id, children listed by id, `parent` derived from them.

```json
{
  "target": "native",
  "rootId": "win",
  "nodes": {
    "win": {
      "id": "win",
      "type": "window",
      "tag": "QMainWindow",
      "parent": null,
      "children": ["ok"],
      "layout": { "x": 0, "y": 0, "w": 400, "h": 200 },
      "style": {},
      "props": { "title": "Rename" }
    },
    "ok": {
      "id": "ok",
      "type": "button",
      "tag": "QPushButton",
      "parent": "win",
      "children": [],
      "layout": { "x": 296, "y": 152, "w": 88, "h": 32 },
      "style": {},
      "props": { "text": "OK", "default": true },
      "source": { "file": "main.py", "line": 24, "col": 14 }
    }
  }
}
```

`children` lists win over `parent`; a node that no list mentions is attached to the node its `parent` names (or to
the root). Glimpse always writes a file back in the form it was written in.

## Nodes

| Key | | Meaning |
|---|---|---|
| `id` | optional in the nested form | Stable, unique id. Use the code's own widget id or variable name (`id="todos"` → `"todos"`), and keep ids stable when you rewrite the file, so the human's unsent edits survive. |
| `type` | required | One of the node types below. Pick the closest and put the real class in `tag`. |
| `tag` | recommended | The real widget class: `"Button"`, `"ListView"`, `"ttk.Entry"`, `"QPushButton"`, `"<Box>"`. The change list names elements by it. |
| `layout` | required | `{ "x", "y", "w", "h" }` relative to the parent's top-left corner (see Units). |
| `style` | optional | CSS-like strings (see Style). |
| `props` | optional | Content and state: `text`, `items`, `checked`, … (see Props). |
| `hidden` | optional | `true` when the widget exists in the code but isn't shown. |
| `locked` | optional | Editor-only: the human can't select or move it. Never changes code. |
| `source` | recommended | `{ "file", "line", "col" }`: where the widget is created (1-based; the constructor call or JSX tag), with a project-relative path and forward slashes. `"app.py:12:5"` works too. The human's edits come back pointing at it. |
| `children` | optional | Child nodes (objects in the nested form, ids in the flat form). |

### Units

- **`tui`**: whole character cells. `x` is a column, `y` a row. The root is the terminal: `w`×`h` = columns×rows
  (80×24 by default). Fractions are rounded.
- **`native`**: pixels. The root is the window's client area, without the title bar (800×600 by default). Make it a
  `"window"` with `props.title`; the theme draws the frame around it.

Give each widget the size it really has on screen, borders included. Children of a bordered panel are positioned
from the panel's outer corner (so the first row inside a one-cell border is `y: 1`).

### Node types

| Type | Props | Real widgets |
|---|---|---|
| `root` | | The screen (tui) or window client area (native). |
| `window` | `title` | A top-level window or dialog; use it as the root of a native scene. |
| `box` | `title` (with a border style) | Containers without a frame: Textual `Container`/`Horizontal`/`Vertical`, Ink `<Box>`, a Ratatui layout area, `tk.Frame`, `QWidget`. |
| `panel` | `title` | Containers with a border: a bordered Textual container, Ratatui `Block::bordered()`, `ttk.LabelFrame`, `QGroupBox`. |
| `text` | `text` | Static or multi-line text: Textual `Static`, Ink `<Text>`, Ratatui `Paragraph`, `tk.Message`. |
| `label` | `text` | A short caption next to a field: Textual `Label`, `ttk.Label`, `QLabel`. |
| `button` | `text`, `variant` (`default`, `primary`, `success`, `warning`, `error`), `disabled`, `default` | Textual `Button`, `ttk.Button`, `QPushButton`. |
| `input` | `text` (the value), `placeholder`, `password`, `multiline`, `readonly`, `disabled` | Textual `Input`/`TextArea`, `ink-text-input`, `ttk.Entry`, `tk.Text`, `QLineEdit`. |
| `checkbox` | `text`, `checked`, `disabled` | Textual `Checkbox`, `ttk.Checkbutton`, `QCheckBox`. |
| `radio` | `text`, `checked`, `group` | Textual `RadioButton`, `ttk.Radiobutton`, `QRadioButton`. |
| `switch` | `text`, `checked` | Textual `Switch`, `Gtk.Switch`, `NSSwitch`. |
| `select` | `items`, `selected` (index), `placeholder` | Textual `Select`, `ttk.Combobox`, `QComboBox`. |
| `list` | `items`, `selected` (index) | Textual `ListView`/`OptionList`, Ratatui `List`, `tk.Listbox`, `QListWidget`. Use children instead of `items` when each row is a widget of its own. |
| `table` | `columns`, `items` (rows, each an array of cells), `selected` (row) | Textual `DataTable`, Ratatui `Table`, `ttk.Treeview` with columns, `QTableWidget`. |
| `tree` | `items` (one line per node, two spaces of indent per level), `selected`, `expanded` | Textual `Tree`, `ttk.Treeview`, `QTreeView`. |
| `tabs` | `items` (tab labels), `selected`; children are the panes, one per tab | Textual `TabbedContent`, `ttk.Notebook`, `QTabWidget`. |
| `progress` | `value`, `max` (default 100), `text` | Textual `ProgressBar`, Ratatui `Gauge`, `ttk.Progressbar`, `QProgressBar`. |
| `slider` | `value`, `min`, `max`, `step` | `tk.Scale`, `QSlider`. |
| `image` | `src` (relative to the scene file), `alt` | `tk.Canvas`/`PhotoImage`, a `QLabel` with a pixmap. |
| `menu` | `items` (top-level menu titles) | `tk.Menu`, `QMenuBar`, a TUI menu row. |
| `statusbar` | `text`, `items` (key hints such as `"q Quit"`) | A full-width one-line bar: Textual `Header`/`Footer`, a status `tk.Label`, `QStatusBar`. |
| `divider` | | Textual `Rule`, `ttk.Separator`; horizontal or vertical by its shape. |
| `link`, `icon`, `nav`, `card` | `text`, `href` | As for web pages. |
| `custom` | anything | Any other widget; `tag` names it. Unknown types are shown as `custom` (with the type kept as the tag). |

### Props

Props are strings in Glimpse's scene. The file may use friendlier JSON:

- **Lists** (`items`, `columns`) are arrays of strings, one entry per row or option. Table rows are arrays of cells:
  `"items": [["Due", "Friday"], ["Owner", "Sam"]]`.
- **Flags** (`checked`, `disabled`, `readonly`, `password`, `multiline`, `default`, `expanded`) are booleans.
- **Numbers** (`selected`, `value`, `min`, `max`, `step`) are numbers.

Everything else is a string. Text goes in `props.text`; it's what the human retypes inline.

### Style

CSS-like string values. Unknown keys are kept and handed to the agent as they are.

- **tui**: `color` and `background` (ANSI names like `cyan` or `bright-black`, `#rrggbb`, or theme variables such as
  Textual's `$accent`), `text-style` (`bold italic underline reverse dim strike`), `border` (`none`, `solid`,
  `round`, `double`, `heavy`, `dashed`, `ascii`, optionally followed by a color), `text-align`, `padding` (`"1 2"`).
- **native**: `color`, `background`, `font-family`, `font-size`, `font-weight`, `border`, `border-radius`,
  `padding`, `text-align`, `opacity`.

## Running the real app: `meta.command`

`meta.command` is the shell command that runs the real app from the project directory: `python app.py`, `npm start`,
`cargo run`, `go run .`. It runs with `/bin/sh -c` on macOS and Linux and `cmd.exe /c` on Windows.

For a TUI, Glimpse runs it in a terminal panel next to the mock (in a real pseudo-terminal when `node-pty` is
available, otherwise with piped output), so the human can compare the mock with the real thing and see the agent's
changes land. `glimpse open --run "<command>"` overrides it. For a native GUI, the app opens in its own window and its
output shows in Glimpse's log.

## How edits flow back to the AI

1. The agent writes the code and `glimpse.scene.json`, then waits (`glimpse_wait_for_done` / `glimpse wait`).
2. Glimpse shows the mock. Every save of the scene file updates it live; an invalid file (say, half written) keeps the
   last good mock on screen and shows the error.
3. The human moves, resizes, retypes, restyles, adds, deletes, reorders, hides, comments or draws a box with a prompt.
4. When they send the edits, Glimpse writes the edited scene back into `glimpse.scene.json`, in the same form, with
   `$schema`, `theme` and `meta` kept, and only the edited parts changed (the human can review the diff first with
   **Edit source**). Comments, behaviors, boxes with prompts and locks are not part of the file.
5. The agent receives every change as a numbered instruction with the `source` location, for example:

   ```text
   In Glimpse, the human edited the mock of a Textual (Python) terminal UI, run with `python app.py`. Apply these
   changes 1:1 to the real source code.
   glimpse.scene.json already matches the edited mock; only update it again if your code ends up different.
   Positions and sizes are in terminal cells (columns and rows), relative to the parent widget. Express moves and
   resizes with the toolkit's own layout (containers, docking, CSS, grid/pack options, constraints) rather than
   absolute positions; use the intent hints.

   1. Delete button<Button> "Delete" (app.py:62:27).
   2. Resize list<ListView> todos (app.py:55:19): size 32×19 → 36×19 (+4w, 0h).
   3. Set `items` of list<ListView> todos (app.py:55:19) to ["○ Buy groceries", …, "Water the plants"] (was [ … ]).
   4. Resize panel<Vertical> details (app.py:56:18): size 48×19 → 44×19 (-4w, 0h); also moved 4 cells right.
   5. Change the text of button<Button> "Add todo" (app.py:65:19) from "Add" to "Add todo".
   6. Instruction for list<ListView> todos (app.py:55:19): "Show a count of open todos"
   ```

6. The agent changes the code idiomatically (here: `#todos { width: 36; }` in the Textual CSS rather than absolute
   offsets) and keeps the scene file in sync if its result differs from the mock.

## Problems and validation

Glimpse reads scene files tolerantly: it reports problems and works around them, so the human always sees something.
Only a file that isn't JSON at all is rejected, with the line and column (and a hint for trailing commas, comments or
single quotes). Examples of what is reported:

- an unknown `type` (shown as `custom`), unknown keys, a missing or non-numeric `layout` value (a default is used),
  fractional cells in a TUI (rounded), negative sizes;
- in the flat form: children that name unknown ids, a node listed under two parents, `parent` disagreeing with
  `children`, nodes no parent lists (attached to the root) and cycles (broken up);
- a `theme` on a terminal UI, a missing `target`.

Agents can check a file with the MCP tool `glimpse_scene_validate` (by path, project directory or text); it also points
out a missing `meta.command` and widgets without a `source`.

## Another example: a Tkinter window

```python
import tkinter as tk
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
```

```json
{
  "target": "native",
  "theme": "linux",
  "meta": { "framework": "tkinter", "command": "python app.py", "title": "Sign in" },
  "root": {
    "type": "window",
    "tag": "Tk",
    "layout": { "x": 0, "y": 0, "w": 320, "h": 168 },
    "props": { "title": "Sign in" },
    "source": { "file": "app.py", "line": 4, "col": 8 },
    "children": [
      {
        "id": "form",
        "type": "box",
        "tag": "ttk.Frame",
        "layout": { "x": 0, "y": 0, "w": 320, "h": 168 },
        "style": { "padding": "16px" },
        "source": { "file": "app.py", "line": 8, "col": 8 },
        "children": [
          {
            "type": "label",
            "tag": "ttk.Label",
            "layout": { "x": 16, "y": 20, "w": 40, "h": 20 },
            "props": { "text": "Email" },
            "source": { "file": "app.py", "line": 10, "col": 1 }
          },
          {
            "id": "email",
            "type": "input",
            "tag": "ttk.Entry",
            "layout": { "x": 64, "y": 16, "w": 240, "h": 28 },
            "source": { "file": "app.py", "line": 11, "col": 9 }
          },
          {
            "id": "remember",
            "type": "checkbox",
            "tag": "ttk.Checkbutton",
            "layout": { "x": 64, "y": 56, "w": 124, "h": 22 },
            "props": { "text": "Remember me", "checked": false },
            "source": { "file": "app.py", "line": 13, "col": 12 }
          },
          {
            "type": "button",
            "tag": "ttk.Button",
            "layout": { "x": 216, "y": 112, "w": 88, "h": 32 },
            "props": { "text": "Sign in", "default": true },
            "source": { "file": "app.py", "line": 15, "col": 1 }
          }
        ]
      }
    ]
  }
}
```

The full versions, [`examples/tui-todo`](../examples/tui-todo) and
[`examples/native-settings`](../examples/native-settings), are checked in CI: their scene files must parse without
problems, match the schema, and point every widget at the line of code that creates it.
