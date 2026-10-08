# `glimpse.scene.json` (draft)

> Status: draft for phase 5 (TUI and native GUI targets). The shape matches `Scene` in `packages/core/src/scene.ts`.

TUI and native GUI apps can't be edited live from outside, so the agent describes their layout in a scene file
next to the code. Glimpse renders it as an editable mock, either a terminal cell grid or toolkit-styled widgets. When
the human sends changes, the agent maps them back onto the real code (Textual, Ink, Ratatui, Qt, Tkinter, …).

```json
{
  "target": "tui",
  "rootId": "root",
  "nodes": {
    "root":   { "id": "root", "type": "root", "parent": null, "children": ["header", "save"],
                "layout": { "x": 0, "y": 0, "w": 80, "h": 24 }, "style": {}, "props": {} },
    "header": { "id": "header", "type": "text", "tag": "Static", "parent": "root", "children": [],
                "layout": { "x": 0, "y": 0, "w": 80, "h": 1 }, "style": { "color": "cyan" },
                "props": { "text": "My App" }, "source": { "file": "app.py", "line": 12, "col": 9 } },
    "save":   { "id": "save", "type": "button", "tag": "Button", "parent": "root", "children": [],
                "layout": { "x": 2, "y": 20, "w": 10, "h": 3 }, "style": {},
                "props": { "text": "Save" }, "source": { "file": "app.py", "line": 18, "col": 9 } }
  }
}
```

- `layout` units are **cells** for `tui` and **pixels** for `native`; `x`/`y` are relative to the parent.
- `tag` is the real widget class (`Button`, `QPushButton`, `ttk.Button`, …), so the agent knows what to edit.
- `source` lets Glimpse and the agent jump straight to the code.
