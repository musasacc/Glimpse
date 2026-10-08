<p align="center">
  <img src="assets/logo.svg" alt="Glimpse" width="312" />
</p>

<p align="center">
  <b>See what your AI built. Change it with your hands. Hand it back.</b><br />
  The visual editing layer between you and your AI coding agent. macOS · Windows · Linux.
</p>

<p align="center">
  <img src="docs/screenshot-home.png" alt="Glimpse home: describe a UI for your agent" width="900" />
</p>

---

Tell Glimpse what you want, for example *"a website with 5 buttons and a moving donut"*. Your agent (Claude Code, Codex,
Antigravity, Cursor, Gemini CLI, …) builds it, and you **watch it appear live**. Then, instead of describing changes
in words, you **make** them: drag things around, delete buttons, add new ones, change text and colors, or point at an
element and say what you want. Finally, either let **Glimpse write the changes into the code** itself, or
**send them to your AI**, which applies them 1:1.

<p align="center">
  <img src="docs/screenshot.png" alt="Glimpse editor" width="900" />
</p>

## Features

- **Ask from Glimpse.** Describe a UI on the home screen; your connected agent receives it and builds it.
- **Live mode.** Every file the AI saves shows up instantly. CSS is hot-swapped, HTML is morphed in place without a reload, and whatever the AI touched briefly glows. A live activity feed shows what's happening.
- **Edit anything visually.** Select, drag to move, resize, nudge with the arrow keys, double-click to edit text, delete, duplicate, hide, lock, change the element type, and restyle (colors, font, spacing, radius, border, shadow, opacity).
- **Add elements** (button, heading, text, link, input, image, card). New elements pick up the look of their neighbors.
- **Point & talk.** Select an element, press <kbd>T</kbd>, and type or **say** "make this bounce". The instruction is pinned to that exact element.
- **Edit behavior.** "On click → open modal / go to page / call API / toggle element". Logic instructions go straight to the AI.
- **Two ways to finish:**
  - **Edit source**: Glimpse writes text, style, attribute, delete, add and reorder edits straight into your files, with a diff preview and an automatic backup. Formatting is preserved.
  - **Send to AI**: your agent gets numbered instructions with exact `file:line:col` locations and intent hints such as "now right of the logo", and applies them. Anything Edit source can't do safely (layout moves, logic, notes) is handed to the AI in the same click.
- **History** of every request and handoff, plus **undo/redo**, **desktop / tablet / mobile** widths, and **Edit / Interact** modes.
- **Works with any agent**: a built-in **MCP server**, plus a CLI for agents without MCP.

## Install

Requires [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io). Works on macOS, Windows and Linux.

```bash
git clone https://github.com/musasacc/Glimpse.git
cd Glimpse
pnpm install
pnpm build
cd packages/cli && npm link     # puts the `glimpse` command on your PATH
```

> Once published to npm, this becomes `npx glimpse-ui …` (the name `glimpse` is taken on npm, so the package is `glimpse-ui` and the command stays `glimpse`).

Try it:

```bash
glimpse open examples/donut
```

## Connect your agent (MCP)

Glimpse ships an MCP server. Add it once and your agent gets the tools `glimpse_open`, `glimpse_wait_for_done`,
`glimpse_get_changes`, `glimpse_status`, `glimpse_update` and `glimpse_close`.

**Claude Code**

```bash
claude mcp add glimpse -- glimpse mcp
```

**Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.glimpse]
command = "glimpse"
args = ["mcp"]
```

**Cursor** (`.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`), **Antigravity** (MCP servers → raw config):

```json
{
  "mcpServers": {
    "glimpse": { "command": "glimpse", "args": ["mcp"] }
  }
}
```

> **Windows:** if your agent can't start `glimpse` directly, use `"command": "cmd", "args": ["/c", "glimpse", "mcp"]`.

Then just ask: *"Build me a landing page and open it in Glimpse."* The agent calls `glimpse_open`, builds the page while
you watch, and waits with `glimpse_wait_for_done` for your edits or your next request.

### Without MCP: the CLI

```text
glimpse open [dir]          Start Glimpse for a project (--port, --target, --entry, --no-browser)
glimpse wait [dir]          Block until the human sends a request or edits, then print them (--json, --timeout)
glimpse changes [dir]       Print the most recent handoff again
glimpse status <message>    Show a status line in Glimpse's live activity feed
glimpse mcp                 Run the MCP server over stdio
```

Put this in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`:

```text
When you build or change UI, use Glimpse so I can edit it visually:
  1. Run `glimpse open <project-dir> --no-browser` in the background (once) and tell me the URL.
  2. Run `glimpse wait <project-dir>`. It blocks until I send a request or my edits from Glimpse.
  3. Do exactly what it prints in the real source code (it includes file:line:col locations).
  4. Go back to step 2.
```

Every handoff is also saved in `<project>/.glimpse/handoffs/<n>.json`. See [`docs/agents.md`](docs/agents.md) for the
change list format.

### What the agent receives

```text
The human edited the html UI in Glimpse. Apply these changes 1:1 to the real source code.
Prefer idiomatic layout changes (flex/grid order, spacing, alignment) over hard-coded pixel positions; use the intent hints.

1. Reposition text<h1> "Donut Shop" (index.html:11:7) — moved 60px right; now above text<p> "Five buttons…".
2. Instruction for button "Order now" (index.html:24:7): "make this bounce"
```

## Targets

| Target | Status | How it works |
|---|---|---|
| HTML / CSS / JS | ✅ Live mode, visual editing, Edit source | The page runs in Glimpse and is edited directly |
| React / Vite | 🔜 | The real dev server runs in Glimpse, and a Vite plugin maps each element to its JSX source |
| TUI (terminal UIs) | 🔜 | The agent describes the layout in `glimpse.scene.json`; Glimpse renders an editable cell grid next to the live terminal |
| Native GUI (Qt, Tk, …) | 🔜 | Same scene file, rendered as an editable widget mock |

Under the hood, every target becomes the same **Glimpse Scene** (a tree of elements with layout, style and source
locations). The editor, the edit operations and the AI handoff are written once for all of them.

## How it's built

```
packages/
  core/     Scene model, edit operations, undo/redo, change-list diffing, prompt rendering
  server/   Local server: live preview (instrumented with source locations), file watching, handoffs, Edit source patcher
  editor/   The black React editor: home, editor, history
  mcp/      MCP server (stdio)
  cli/      The `glimpse` command (npm: glimpse-ui)
examples/
  donut/    Five buttons and a moving donut
```

- Edits are typed **ops** (`move`, `resize`, `setText`, `setStyle`, `add`, `delete`, `reorder`, `comment`, `behavior`, …) in an op log with undo/redo.
- On handoff, the base and final scenes are **diffed**, so edits that cancel out never reach the AI, and moves come with semantic intent hints.
- The preview is served with `data-glimpse-src="file:line:col"` on every element (parse5). **Edit source** uses those locations to make surgical edits with magic-string, so your formatting stays intact.

## Roadmap

- [x] **Phase 1: foundation.** Core model, server, editor, CLI, live mode, Send to AI, point & talk, behavior.
- [x] **Phase 2: HTML end to end.** Home screen with requests to the agent, source locations, **Edit source** with diff preview, MCP server, element palette, history, cross-platform CI.
- [ ] **Phase 3: loop features.** **Timeline of versions** (scrub and restore), **before/after slider**, **variants** ("show me 3 versions of this header"), draw-a-box prompts, group/align, screenshots in handoffs.
- [ ] **Phase 4: React/Vite.** Vite plugin, JSX source mapping, JSX patcher.
- [ ] **Phase 5: TUI + native GUI.** Scene schema, cell-grid renderer with a live terminal view, widget-mock renderer.
- [ ] **Phase 6: polish.** Publish `glimpse-ui` on npm, desktop app (Tauri: `.dmg`, `.msi`, `.AppImage`), per-agent guides.

## Development

```bash
pnpm install
pnpm build        # builds core, server, editor, mcp, cli
pnpm test         # unit tests
pnpm typecheck
pnpm dev          # editor with hot reload (run `glimpse open` alongside it on :4321)
```

CI runs on macOS, Windows and Linux. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
