# Glimpse — Plan

## Context
Glimpse is a visual "middle step" between an AI coding agent (Claude Code, Codex, Antigravity, Cursor, Gemini CLI…) and the UI it builds. Instead of artifacts, the agent pushes whatever it made (website, React app, TUI, native GUI) into Glimpse. The human then edits it visually (move, resize, add, delete, restyle, retext and more), presses **Done**, and the agent applies those exact changes 1:1 to the real source code.

The repo (`musasacc/Glimpse`) is empty apart from a README, so this is a greenfield build.

**Decisions so far**
- Shell: a **local web app**, `npx glimpse` (one command, any OS, no native toolchain, fast). It can later be packaged as a small Tauri desktop app with the same code.
- AI bridge: an **MCP server and a CLI**. Every major agent speaks MCP, and the CLI is the fallback.
- Targets: **all four** (HTML/CSS/JS, React/Vite, TUI, native GUI), and every element is movable in all of them.
- Handoff: a **hybrid**. Glimpse patches source itself wherever it can map an edit deterministically, and always sends the agent a structured change list plus before/after screenshots. The agent verifies the result and finishes anything Glimpse couldn't patch.

## Core idea: one universal "Glimpse Scene"
Each target is turned into the same editable model, so the editor, the change ops and the handoff are written once.

```
Scene { target: "html"|"react"|"tui"|"native", nodes: Node[] }
Node  { id, type (button|text|box|input|image|list|custom…), parent, children,
        layout {x,y,w,h | flex/grid props | cell coords for TUI},
        style {color, bg, font, size, radius, padding, border…},
        props {text, placeholder, src, onClick-label…},
        source? {file, line, col}   // where it lives in real code
      }
```

How each target gets into a Scene:

| Target | Live preview | How nodes and source locations are found | Glimpse can auto-patch? |
|---|---|---|---|
| HTML/CSS/JS | Real page in an iframe | Server injects `data-glimpse-id` and records each element's file/line using parse5 | Yes (most ops) |
| React/Vite | Real dev server in an iframe | Vite plugin + Babel transform adds `data-glimpse-src="file:line:col"` to each JSX element | Yes for text, style and delete; partially for move and add |
| TUI | Character-cell grid canvas (xterm.js shows the real app beside it) | The agent writes `glimpse.scene.json` describing widgets in cell coordinates | No: the agent applies the change list |
| Native GUI | Widget mock canvas (window, button, label, input, list, tabs…) styled per toolkit | The agent writes `glimpse.scene.json` | No: the agent applies the change list |

TUI and native GUI apps can't be manipulated live from outside, so the agent describes their layout as a scene and Glimpse renders an editable, faithful mock. This is how "everything is movable" works for every target.

## Editing features (beyond add/delete)
- Select, multi-select and marquee select. **Move** (drag with snapping and guides), **resize**, nudge with the arrow keys
- **Add** from a component palette (button, text, input, image, card, list, nav, icon…) or **duplicate** an element
- **Delete**, **reorder** (layer panel tree with drag and drop), **group/ungroup**, **align/distribute**
- **Inline text edit**, and a **style inspector** for colors, font, size, weight, spacing, radius, border, shadow and opacity
- **Swap type** (e.g. a link becomes a button), **show/hide**, **lock**
- **Sticky notes / comments** on any element, such as "make this pulse" or "connect to API": free-text instructions for the agent
- **Draw a box + prompt**, which marks a region with "AI, put X here"
- **Responsive preview** (mobile, tablet and desktop widths), **undo/redo** with full history, light and dark themes
- Two handoff buttons in place of a single "Done" (see below), plus **Discard**

## Extra features (chosen)
- **Point and talk** (v1): select an element and press `T` (or the 🎤 button for voice through the browser Web Speech API), then type or say "make this bounce". The instruction is pinned to that element (node id + source location + crop screenshot) and becomes a `comment` op in the change list. Pins show as small numbered badges on the canvas.
- **Variants** (v1): right-click an element and choose "Variants…", then enter a count (default 3) and an optional hint. Glimpse queues a `variants` request. The agent (via MCP `glimpse_wait_for_done` → `{type:"variants"}`) writes N candidate versions into `.glimpse/variants/<id>/{1..N}`. Glimpse renders them side by side in a grid, the human clicks one, and Glimpse swaps it into the source (or asks the AI to). The other candidates are deleted.
- **Edit behavior** (v1.x): a "Behavior" tab in the inspector for buttons, links and inputs. It offers *On click / On submit / On hover* → *open modal [pick element] / go to page [url] / call API [method + url] / toggle element / custom text*. This produces a `behavior` op that is always sent to the AI as a logic instruction (never auto-patched).
- **Timeline of versions** (v1): every AI round (a file-change burst once the files go quiet) and every human handoff is stored as a snapshot in `.glimpse/history/` (a file snapshot, scene, screenshot and op log). A bottom timeline strip has thumbnails you can scrub through. **Restore** rewrites the files to that snapshot, after confirming and making an automatic backup snapshot first.
- **Before/after slider** (v1): after each AI round, a "Compare" toggle shows the previous and current versions overlaid with a draggable vertical divider. Two iframes are clipped with CSS `clip-path`, and you can compare against any two timeline snapshots.

## Look & brand
- **All-black UI**: background `#000`, panels `#0a0a0a`, borders `#1f1f1f`, text `#fafafa` / muted `#8a8a8a`, a single accent (electric white glow, with selection outlines in a cool cyan `#5ce1ff`). The font is Inter for the UI and JetBrains Mono for code and the TUI. There is no light theme in v1, but the colors are defined as CSS tokens so one can be added later.
- **Logo**: an SVG mark, a minimal **eye/aperture**. A rounded almond outline with a solid dot pupil slightly off-center (a "glimpse"), white on black, plus the wordmark "glimpse" in lowercase Inter SemiBold. Files: `assets/logo.svg` (mark + wordmark), `assets/mark.svg` (icon only, also used as the favicon), `assets/logo-dark.png` for the README.
- **README.md**: the logo header, a one-line pitch, a GIF/screenshot placeholder, a feature list, a quick start (`npx glimpse`), MCP setup snippets for each agent (Claude Code, Codex, Antigravity, Cursor, Gemini CLI), how the two handoff buttons work, live mode, the supported targets table, the scene JSON format summary, a roadmap, contributing notes and the license (MIT, to be confirmed).
- Other repo files: `LICENSE`, `CONTRIBUTING.md`, `.gitignore`, `docs/scene-schema.md`, `docs/agents.md`.

## Two handoff buttons
1. **Send instructions to AI**: packages the change list, comments and screenshots and hands them to the waiting agent (`glimpse_wait_for_done` returns). The AI implements everything in the real code. The human can add a free-text note in a small box before sending.
2. **Edit source**: Glimpse writes the changes straight into the source files itself, with no AI round-trip. It first shows a diff preview with Apply/Cancel. Any op that can't be safely patched (complex moves, TUI/native scenes) is listed as "needs AI", with a one-click "send these to AI" button.
   - HTML: patches attributes, text, styles and deletes, reorders sibling nodes, and inserts new elements.
   - React: same for JSX via recast. Moves are done as JSX reorders or style edits.
   - TUI/native: updates `glimpse.scene.json` only, then marks the code changes as "needs AI".

## Live mode: watch the AI work in real time
While an agent is connected, Glimpse mirrors every change the AI makes, live. If you tell Claude Code "make the button red", you watch it turn red in Glimpse.
- **File watching** (chokidar) on the project. On every save:
  - HTML: the server re-instruments the file and pushes it over the WebSocket. The editor **morphs** the DOM (idiomorph) rather than doing a full reload, so the scroll position, selection and app state stay put. CSS-only changes are hot-swapped.
  - React/Vite: native Vite HMR inside the iframe. Glimpse's overlay re-reads `data-glimpse-src` and keeps the selection.
  - TUI: the live xterm.js pane restarts or re-renders, and the scene canvas reloads `glimpse.scene.json`.
  - Native: the mock canvas reloads `glimpse.scene.json`. Optionally the real app is relaunched and its screenshot is streamed beside the mock.
- **Change highlighting**: elements the AI just changed **flash/glow** briefly, and a side **activity feed** shows "AI edited `App.tsx:41` → button color red" with a mini diff.
- **Agent status bar**: through the MCP tool `glimpse_status({sessionId, message})`, the agent can post what it's doing ("Applying your 4 changes…", "Done ✓"), shown live in Glimpse.
- **Human/AI conflicts**: if the AI changes a file while the human has unsent edits, pending ops are **rebased** onto the new source (matched by node id and source location). Ops that no longer match are flagged in yellow, not silently dropped. Optionally editing is paused while the AI writes ("AI is editing…" overlay with a "let me keep editing" toggle).
- Live mode also works without MCP: watching the files is enough, so even an agent that doesn't know about Glimpse shows up live.

## Change list (sent back on Done)
Every edit is stored as a typed op in an append-only log. On Done, the log is compacted into a minimal list:
```json
{ "session":"…", "target":"react",
  "applied":   [ {op:"setText", node:"n12", src:"src/App.tsx:41:9", from:"Buy", to:"Buy now"} ],
  "pending":   [ {op:"move", node:"n7", src:"src/App.tsx:30:5", from:{x:20,y:80}, to:{x:220,y:80}, intent:"place right of logo"},
                 {op:"add", parent:"n3", index:2, node:{type:"button", props:{text:"Save"}, style:{…}}},
                 {op:"comment", node:"n9", text:"make this donut spin faster"} ],
  "screenshots": { "before":"…/before.png", "after":"…/after.png" } }
```
- `applied` lists edits Glimpse already patched into source, which the agent only verifies.
- `pending` lists edits the agent must implement, with source locations and human intent hints.
- Move ops are given semantic **intent hints** (for example "now 2nd child of nav" or "aligned right") in addition to pixel values, so the agent changes layout code idiomatically instead of hard-coding pixel positions.

## Architecture (TypeScript monorepo, pnpm workspaces)
```
packages/
  core/        Scene + Node types, op definitions, op log, compaction, undo/redo (pure TS, unit-tested)
  server/      Node (Hono + ws): serves the editor, proxies/injects into previews, watches files (chokidar),
               session store (.glimpse/ in the project), screenshot capture (Playwright, optional)
  editor/      React + Vite SPA: canvas overlay, layers panel, inspector, palette, Done/Discard
  adapters/
    html/      parse5 instrumentation + source patcher (magic-string)
    react/     Vite plugin + Babel transform + JSX patcher (recast)
    tui/       cell-grid renderer + optional xterm.js/node-pty live view
    native/    widget-mock renderer (themes: Qt, Tk, macOS, Windows)
  mcp/         MCP server (@modelcontextprotocol/sdk, stdio)
  cli/         `glimpse` binary: start, open, status, changes, mcp
```
Performance: overlay edits are rendered as CSS transforms on the overlay (not a re-render of the app), the op log is in memory and flushed to disk, and the server talks to the editor over WebSockets.

## MCP tools (what the agent sees)
- `glimpse_open({ dir, target?, entry?, scene? })` starts or reuses the server, loads the project and returns `{sessionId, url}`. The URL opens in the browser automatically.
- `glimpse_wait_for_done({ sessionId, timeoutSec=300 })` returns `{status:"editing"}` on timeout, so the agent can call again. On Done it returns the change list.
- `glimpse_get_changes({ sessionId })` returns the latest change list without blocking.
- `glimpse_update({ sessionId })` forces a reload, as a fallback if the live file watch misses something. The human then sees the result and can go another round.
- `glimpse_status({ sessionId, message })` posts a live status line to the Glimpse activity feed.
- `glimpse_scene_schema()` returns the JSON schema for `glimpse.scene.json` so agents can produce TUI/native scenes.
- `glimpse_close({ sessionId })`

The CLI mirrors these commands (`glimpse open .`, `glimpse wait`, `glimpse changes --json`), so agents without MCP can shell out. Setup is one line, for example `claude mcp add glimpse -- npx glimpse mcp`, documented for each agent in the README.

## Build order (each phase is shippable)
1. **Foundation**: monorepo, logo + README + LICENSE + docs, `core` (scene, ops, log, undo) with tests, a `server` skeleton, an all-black `editor` shell, the CLI `glimpse open`.
2. **HTML end-to-end**: instrumentation, overlay select/move/resize/delete/add/text/style, **live mode** (file watch, DOM morph, change flash, activity feed), both handoff buttons (**Send to AI** + **Edit source** with diff preview), the change list, then the MCP server. *Milestone: Claude Code builds "5 buttons + moving donut" and it appears live in Glimpse. The human edits it and clicks Send to AI, then watches the AI apply the changes live.*
3. **Rich editing + loop features**: layers panel, group, align, duplicate, swap type, **point and talk** (text + voice), draw-box prompt, responsive widths, screenshots, **timeline of versions**, **before/after slider**, **variants**, then **edit behavior**.
4. **React/Vite adapter**: Vite plugin, JSX source mapping, JSX patcher.
5. **Scene targets**: the scene JSON schema, then the TUI grid renderer (plus xterm live view) and the native widget mock renderer.
6. **Polish**: per-agent setup docs, `npx` publish, optional Tauri wrapper.

## Verification
- `pnpm test`: unit tests for op compaction, undo/redo and the source patchers (golden files: input source + ops gives the expected output source).
- Playwright e2e: open the fixture HTML and React apps, drag, delete and add elements, click Done, then assert the change-list JSON and the patched files.
- MCP check: run `npx @modelcontextprotocol/inspector npx glimpse mcp`, call `glimpse_open`, edit in the browser, and confirm `glimpse_wait_for_done` returns the change list.
- Live mode e2e: while Glimpse is open, write to the fixture file from the test. Assert that the iframe updates without a full reload, the selection is kept, and the changed element gets the flash class.
- Edit source e2e: make edits, click Edit source, and assert the diff preview and the patched files.
- Manual dogfood: Claude Code with the Glimpse MCP builds a page, the human moves and deletes elements, and the agent applies the changes; then repeat with a Textual TUI scene and a Tkinter scene.
- Work happens on branch `claude/charming-faraday-sukumk`; commit and push after each phase.
