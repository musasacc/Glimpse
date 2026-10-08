# Connecting AI agents

Glimpse talks to agents in two ways: an **MCP server** (`glimpse mcp`) for agents that support MCP (most do), and a
**CLI** (`glimpse wait`) for everything else. Both deliver the same things:

- **Requests** the human types on Glimpse's home screen ("a dashboard with four KPI tiles").
- **Edits** the human made visually and sent with **Send to AI**, as numbered instructions with `file:line:col`.

Install first (see the README): `pnpm install && pnpm build && (cd packages/cli && npm link)`.

## MCP

| Tool | What it does |
|---|---|
| `glimpse_open({ dir, target?, entry? })` | Start Glimpse for a project (or reuse a running one) and open the browser |
| `glimpse_wait_for_done({ dir?, timeout_sec? })` | Wait for the human's next request or edits; returns "still editing" on timeout |
| `glimpse_get_changes({ dir? })` | The latest handoff, without waiting |
| `glimpse_status({ message })` | Show a status line in Glimpse's activity feed |
| `glimpse_update({ dir? })` | Force the preview to reload (normally not needed) |
| `glimpse_close({ dir? })` | Stop a Glimpse server this agent started |

| Agent | Setup |
|---|---|
| Claude Code | `claude mcp add glimpse -- glimpse mcp` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.glimpse]` with `command = "glimpse"`, `args = ["mcp"]` |
| Cursor | `.cursor/mcp.json`: `{"mcpServers": {"glimpse": {"command": "glimpse", "args": ["mcp"]}}}` |
| Gemini CLI | `~/.gemini/settings.json`: same `mcpServers` block |
| Antigravity | MCP servers → raw config: same `mcpServers` block |

On **Windows**, if the agent can't launch `glimpse` directly, use `"command": "cmd", "args": ["/c", "glimpse", "mcp"]`.
`glimpse mcp --no-browser` skips opening a browser window; `--port <n>` picks the port (default 4321).

## CLI loop

1. **Open**: `glimpse open <dir> --no-browser` (keep it running in the background). It prints the URL for the human.
2. **Wait**: `glimpse wait <dir>` blocks until the human sends something, then prints it as instructions.
   It returns "Still editing" after `--timeout` seconds (default 300); just run it again.
   Messages sent while no agent was listening are queued and delivered on the next `wait`.
3. **Apply**: make the changes in the real source. Glimpse shows every saved file live.
4. **Report** *(optional)*: `glimpse status "Applying your 4 changes…"`.
5. Repeat from step 2.

Suggested text for `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `.cursor/rules/glimpse.mdc`:

```text
When you build or change UI, use Glimpse so I can edit it visually:
  1. Run `glimpse open <project-dir> --no-browser` in the background (once) and tell me the URL.
  2. Run `glimpse wait <project-dir>`. It blocks until I send a request or my edits from Glimpse.
  3. Do exactly what it prints in the real source code. Prefer idiomatic layout changes
     (flex/grid order, gap, alignment) over hard-coded pixel offsets; use the intent hints.
  4. Go back to step 2.
```

## Handoff kinds

| Kind | Sent when | Wakes the agent? |
|---|---|---|
| `request` | The human describes a UI on the home screen | Yes |
| `ai` | The human presses **Send to AI** (or Edit source hands over what it couldn't write) | Yes |
| `source` | **Edit source** wrote changes into the files | No; it's kept in history for reference |

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

Every change carries `src: "file:line:col"` (where the element starts in the source) for HTML projects. `add` and
`reorder` changes also carry `anchor: { after, before }`, the source locations of the neighbours the element now sits
between. React source mapping arrives in phase 4.
