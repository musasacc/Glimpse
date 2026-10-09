import { NODE_TYPES, type NodeType } from "./scene.js";
import { BOOLEAN_PROPS, DEFAULT_ROOT_SIZE, SCENE_SCHEMA_URL, SCENE_THEMES } from "./scene-file.js";

/** What each node type is, its props, and the real widgets it stands for. Used by the schema, the agent guide and the editor. */
export const NODE_TYPE_DOCS: Record<NodeType, string> = {
  root:
    "The screen (tui) or the window's client area (native); its layout is the terminal size in cells or the client area in pixels. A native root can also be a \"window\".",
  box: "A plain container without a visible frame (Textual Container/Horizontal/Vertical, Ink <Box>, a Ratatui layout area, Bubble Tea lipgloss block, tk.Frame, QWidget). props.title shows a title on its border if style.border is set.",
  panel:
    "A container with a border and an optional title in props.title (a bordered Textual container, Ratatui Block::bordered(), ttk.LabelFrame, QGroupBox).",
  text: "Static text, possibly several lines, in props.text (Textual Static, Ink <Text>, Ratatui Paragraph, tk.Message, QLabel with prose).",
  label: "A short one-line caption in props.text, usually next to a field (Textual Label, ttk.Label, QLabel).",
  button:
    "A push button: props.text, props.variant (\"default\" | \"primary\" | \"success\" | \"warning\" | \"error\"), props.disabled, props.default (the window's default button) (Textual Button, ttk.Button, QPushButton).",
  input:
    "A text field: props.text is the current value, props.placeholder, props.password, props.multiline, props.disabled (Textual Input/TextArea, ink-text-input, ttk.Entry, tk.Text, QLineEdit).",
  checkbox: "A checkbox: props.text (label), props.checked, props.disabled (Textual Checkbox, ttk.Checkbutton, QCheckBox).",
  radio:
    "One option of a radio group: props.text, props.checked, props.group (group name) (Textual RadioButton in a RadioSet, ttk.Radiobutton, QRadioButton).",
  switch: "An on/off toggle: props.text, props.checked (Textual Switch, Gtk.Switch, NSSwitch).",
  select:
    "A dropdown: props.items (options), props.selected (index of the chosen one), props.placeholder (Textual Select, ttk.Combobox, QComboBox).",
  list: "A list of rows: props.items, props.selected (index of the highlighted row) (Textual ListView/OptionList, Ratatui List, tk.Listbox, QListWidget). Use children instead of items when each row is a widget of its own.",
  table:
    "A data table: props.columns (header cells), props.items (rows, each an array of cells), props.selected (row index) (Textual DataTable, Ratatui Table, ttk.Treeview with columns, QTableWidget).",
  tree: "A tree: props.items (one line per node, indented two spaces per level), props.selected (Textual Tree/DirectoryTree, ttk.Treeview, QTreeView).",
  tabs: "Tabs: props.items (tab labels), props.selected (active tab index); children are the panes, one per tab in order (Textual TabbedContent, ttk.Notebook, QTabWidget).",
  progress: "A progress bar: props.value, props.max (default 100), props.text (Textual ProgressBar, Ratatui Gauge, ttk.Progressbar, QProgressBar).",
  slider: "A slider: props.value, props.min, props.max, props.step (tk.Scale, ttk.Scale, QSlider).",
  image: "An image or drawing area: props.src (path relative to the scene file), props.alt (tk.Canvas/PhotoImage, QLabel with a pixmap, terminal image widgets).",
  menu: "A menu bar: props.items (the top-level menu titles) (tk.Menu, QMenuBar, a TUI menu row).",
  statusbar:
    "A full-width one-line bar: a header/title bar or a footer/status line. props.text, props.items (key hints like \"q Quit\") (Textual Header/Footer, a status tk.Label, QStatusBar).",
  divider: "A horizontal or vertical rule; its orientation follows its shape (Textual Rule, ttk.Separator, QFrame line).",
  window: "A top-level window or dialog; props.title. Use it as the root of a native scene.",
  link: "A clickable link: props.text, props.href.",
  icon: "A glyph or icon: props.text (the character or icon name).",
  nav: "A navigation bar or sidebar made of links or buttons.",
  card: "A raised tile or card container.",
  custom: "Any other widget; set tag to its real class so the change list can name it.",
};

const primitive = { type: ["string", "number", "boolean"] };

const listValue = {
  description:
    "One entry per line. As an array of strings (preferred) or a newline-separated string. Table rows (props.items of a table) are arrays of cells.",
  anyOf: [
    { type: "array", items: { anyOf: [primitive, { type: "array", items: primitive }] } },
    { type: "string" },
  ],
};

const nodeProperties = {
  id: {
    type: "string",
    minLength: 1,
    description:
      "Stable id of the node, unique in the file. Optional in the nested form (generated from type and position, e.g. \"button-0\" or \"sidebar.button-2\"). Use the code's own widget id when it has one, and keep ids stable when you rewrite the file.",
  },
  type: { $ref: "#/$defs/nodeType" },
  tag: {
    type: "string",
    description: "The real widget class in the code, e.g. \"Button\", \"ListView\", \"Static\", \"ttk.Entry\", \"QPushButton\", \"<Box>\".",
  },
  layout: { $ref: "#/$defs/layout" },
  style: { $ref: "#/$defs/style" },
  props: { $ref: "#/$defs/props" },
  hidden: { type: "boolean", description: "The widget exists in the code but isn't shown (display: none, not packed, …)." },
  locked: { type: "boolean", description: "Editor-only: the human can't select or move it in Glimpse." },
  source: { $ref: "#/$defs/source" },
};

/**
 * JSON Schema (draft 2020-12) of glimpse.scene.json. Descriptions are written
 * for agents: they say what each field means and how it maps to real code.
 */
export const SCENE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCENE_SCHEMA_URL,
  title: "Glimpse scene (glimpse.scene.json)",
  description:
    "Describes the layout of a terminal UI (target \"tui\") or a native desktop GUI (target \"native\") so Glimpse can render an editable mock of it. Put it next to the code. The human edits the mock; Glimpse writes the edits back into this file and hands them to the AI agent, which applies them to the real code. Prefer the nested form ({ target, root }); the flat form ({ target, rootId, nodes }) is the same data keyed by id.",
  type: "object",
  required: ["target"],
  properties: {
    $schema: { type: "string", description: `URL of this schema, for editor completion: ${SCENE_SCHEMA_URL}` },
    target: {
      enum: ["tui", "native"],
      description: `"tui": a terminal UI; layout in character cells, the root is the terminal (default ${DEFAULT_ROOT_SIZE.tui.w}×${DEFAULT_ROOT_SIZE.tui.h}). "native": a desktop GUI; layout in pixels, the root is the window's client area (default ${DEFAULT_ROOT_SIZE.native.w}×${DEFAULT_ROOT_SIZE.native.h}).`,
    },
    theme: {
      enum: [...SCENE_THEMES],
      description: "Native scenes only: which platform's look Glimpse draws the widgets in. Omit to use the human's OS.",
    },
    meta: {
      type: "object",
      description: "About the real app. Other keys are kept as they are.",
      properties: {
        framework: {
          type: "string",
          description: "The UI toolkit: \"textual\", \"rich\", \"ink\", \"ratatui\", \"bubbletea\", \"tkinter\", \"qt\", \"wxpython\", \"gtk\", \"swiftui\", \"winforms\", …",
        },
        command: {
          type: "string",
          description:
            "Shell command that runs the real app from the project directory, e.g. \"python app.py\", \"npm start\", \"cargo run\", \"go run .\". Glimpse runs terminal UIs in its built-in terminal next to the mock.",
        },
        title: { type: "string", description: "The app's or window's title." },
      },
      additionalProperties: true,
    },
    root: {
      $ref: "#/$defs/nestedNode",
      description: "Nested form: the root node, with child nodes inline in `children`. Its type is \"root\" (or \"window\" for a native window).",
    },
    rootId: { type: "string", description: "Flat form: id of the root node in `nodes`." },
    nodes: {
      type: "object",
      description: "Flat form: every node keyed by its id. Children are listed by id; `parent` is derived from them.",
      additionalProperties: { $ref: "#/$defs/flatNode" },
    },
  },
  additionalProperties: false,
  oneOf: [
    { title: "Nested form", required: ["root"], not: { anyOf: [{ required: ["rootId"] }, { required: ["nodes"] }] } },
    { title: "Flat form", required: ["rootId", "nodes"], not: { required: ["root"] } },
  ],
  $defs: {
    nodeType: {
      description: "What kind of widget the node is. Pick the closest one and put the real class in `tag`.",
      oneOf: NODE_TYPES.map((t) => ({ const: t, description: NODE_TYPE_DOCS[t] })),
    },
    layout: {
      type: "object",
      description:
        "Position and size relative to the parent's top-left corner. tui: whole character cells (x = column, y = row). native: pixels. Give the size the widget really has on screen, borders included.",
      required: ["x", "y", "w", "h"],
      properties: {
        x: { type: "number", description: "Left edge, from the parent's left edge." },
        y: { type: "number", description: "Top edge, from the parent's top edge." },
        w: { type: "number", minimum: 0, description: "Width (columns for tui, pixels for native)." },
        h: { type: "number", minimum: 0, description: "Height (rows for tui, pixels for native)." },
      },
      additionalProperties: false,
    },
    style: {
      type: "object",
      description:
        "Visual style as CSS-like string values. tui: color, background (ANSI names like \"cyan\" or \"bright-black\", #rrggbb, or theme variables like \"$accent\"), text-style (\"bold italic underline reverse dim strike\"), border (\"none\" | \"solid\" | \"round\" | \"double\" | \"heavy\" | \"dashed\" | \"ascii\", optionally followed by a color), text-align, padding (\"1 2\"). native: color, background, font-family, font-size, font-weight, border, border-radius, padding, text-align, opacity.",
      additionalProperties: { type: ["string", "number"] },
    },
    props: {
      type: "object",
      description:
        "Widget content and state. Scene values are strings; the file may use arrays for list props, booleans and numbers. Which props a type uses is described with each node type.",
      properties: {
        text: { type: "string", description: "The visible text: label, caption, button text, an input's value, a paragraph (\\n for line breaks)." },
        title: { type: "string", description: "Border title of a panel or box, or a window's title." },
        placeholder: { type: "string", description: "Hint text of an empty input or select." },
        items: { ...listValue, description: `Rows of a list, options of a select, tab labels, menu titles, footer key hints, tree lines, or table rows (arrays of cells). ${listValue.description}` },
        columns: { ...listValue, description: "Header cells of a table." },
        selected: { type: ["integer", "string"], description: "Index of the selected row, option or tab." },
        value: { type: ["number", "string"], description: "Value of a progress bar or slider." },
        min: { type: "number", description: "Minimum of a slider." },
        max: { type: "number", description: "Maximum of a progress bar or slider (default 100)." },
        step: { type: "number", description: "Step of a slider." },
        variant: { type: "string", description: "Button style: \"default\", \"primary\", \"success\", \"warning\" or \"error\"." },
        group: { type: "string", description: "Radio group name." },
        src: { type: "string", description: "Image path, relative to the scene file." },
        alt: { type: "string", description: "Image description." },
        href: { type: "string", description: "Link target." },
        tooltip: { type: "string", description: "Tooltip text." },
        ...Object.fromEntries(
          BOOLEAN_PROPS.map((k) => [
            k,
            {
              type: "boolean",
              description: {
                checked: "Checkbox, radio or switch is on.",
                disabled: "The widget is greyed out.",
                readonly: "An input that can't be edited.",
                password: "An input that masks its value.",
                multiline: "A multi-line text area.",
                default: "The window's default button (drawn emphasized on native themes).",
                expanded: "A tree node or collapsible is open.",
              }[k],
            },
          ]),
        ),
      },
      additionalProperties: { anyOf: [primitive, listValue] },
    },
    source: {
      description:
        "Where the widget is created in the real code: the 1-based line and column of the constructor call or JSX tag. Glimpse's change list points the agent at it. A \"file:line:col\" string works too.",
      anyOf: [
        {
          type: "object",
          required: ["file", "line"],
          properties: {
            file: { type: "string", description: "Path relative to the project directory, with forward slashes." },
            line: { type: "integer", minimum: 1 },
            col: { type: "integer", minimum: 1, description: "Defaults to 1." },
          },
          additionalProperties: false,
        },
        { type: "string", pattern: "^.+:[0-9]+:[0-9]+$" },
      ],
    },
    nestedNode: {
      type: "object",
      description: "A widget in the nested form; `children` holds its child widgets in on-screen order.",
      required: ["type", "layout"],
      properties: {
        ...nodeProperties,
        children: { type: "array", items: { $ref: "#/$defs/nestedNode" }, description: "Child widgets in order (the order of the code)." },
      },
      additionalProperties: false,
    },
    flatNode: {
      type: "object",
      description: "A widget in the flat form.",
      required: ["type", "layout"],
      properties: {
        ...nodeProperties,
        parent: { type: ["string", "null"], description: "Id of the parent node (null for the root). Derived from `children` when both are given." },
        children: { type: "array", items: { type: "string" }, description: "Ids of the child nodes, in order." },
      },
      additionalProperties: false,
    },
  },
} as const;
