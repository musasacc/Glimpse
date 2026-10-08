# Connecting AI agents

Glimpse works with any agent that can run shell commands. An MCP server (`glimpse mcp`) is planned for phase 2;
until then, the CLI is the bridge.

## The loop

1. **Open**: `glimpse open <dir> --no-browser` (keep it running in the background). It prints the URL for the human.
2. **Wait**: `glimpse wait <dir>` blocks until the human presses **Send to AI**, then prints numbered instructions.
   It returns "Still editing" after `--timeout` seconds (default 300); just run it again.
3. **Apply**: make the changes in the real source. Glimpse shows every saved file live.
4. **Report** *(optional)*: `glimpse status "Applying your 4 changes…"` shows up in Glimpse's activity feed.
5. Repeat from step 2.

## Per-agent setup

Add the loop to the agent's instruction file:

| Agent | File |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Gemini CLI | `GEMINI.md` |
| Cursor | `.cursor/rules/glimpse.mdc` |
| Antigravity | the workspace rules / `AGENTS.md` |

Suggested text:

```text
When you build or change UI, open it in Glimpse so I can edit it visually:
  1. Run `glimpse open <project-dir> --no-browser` in the background (once) and tell me the URL.
  2. Run `glimpse wait <project-dir>`. It blocks until I press "Send to AI" in Glimpse,
     then prints my changes as numbered instructions.
  3. Apply every instruction 1:1 to the real source code. Prefer idiomatic layout changes
     (flex/grid order, gap, alignment) over hard-coded pixel offsets; use the intent hints.
  4. Go back to step 2.
```

## The change list (`glimpse wait --json`)

```json
{
  "status": "ready",
  "handoff": {
    "seq": 1,
    "kind": "ai",
    "createdAt": "2026-10-08T18:56:45.000Z",
    "prompt": "The human edited the html UI in Glimpse. …",
    "changeList": {
      "version": 1,
      "target": "html",
      "note": "keep the pink brand color",
      "changes": [
        { "op": "delete", "label": "button \"Maple\"", "parent": "g9", "index": 3, "nodes": [] },
        { "op": "move", "node": "g2", "label": "text<h1> \"Donut Shop\"",
          "from": { "x": 0, "y": 0 }, "to": { "x": 100, "y": 20 },
          "intent": "moved 100px right and 20px down; now above text<p> \"Five buttons…\"" },
        { "op": "setText", "node": "g10", "from": "Glazed", "to": "Honey Glazed" },
        { "op": "setStyle", "node": "g14", "key": "background", "from": null, "to": "red" },
        { "op": "comment", "node": "g14", "text": "make this bounce when hovered" },
        { "op": "behavior", "node": "g14", "event": "click", "action": "open modal", "detail": "#order" }
      ]
    }
  }
}
```

| Op | Meaning |
|---|---|
| `move` | Element moved. `from`/`to` are offsets in its parent; `intent` describes it semantically |
| `resize` | New width/height |
| `setText` | Text content changed |
| `setStyle` / `setProp` | CSS property or attribute set (`to: null` means removed) |
| `swapType` | Element type changed (e.g. link becomes button) |
| `setHidden` | Element hidden or shown |
| `add` | New element(s), with their full final state and position intent |
| `delete` | Element removed (with its subtree) |
| `reorder` | Moved to another position in the tree |
| `comment` | Point & talk: a free-text instruction pinned to an element |
| `behavior` | Logic: on `event` do `action` (`detail`) |
| `region` | Draw a box + prompt (coming in phase 3) |

Source locations (`src: "file:line:col"`) are attached once source mapping lands (phase 2 for HTML, phase 4 for React).
