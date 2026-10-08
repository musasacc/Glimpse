# Contributing to Glimpse

Thanks for helping! Glimpse is a pnpm monorepo written in TypeScript.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Run the example:

```bash
node packages/cli/dist/index.js open examples/donut
# or, after `cd packages/cli && npm link`:
glimpse open examples/donut
```

For editor work with hot reload, keep `glimpse open` running (port 4321) and run `pnpm dev` in another terminal.
Vite proxies the API, the preview and the live-mode websocket to the Glimpse server. The server refuses requests and
websockets from other origins, so tell it about the dev server's:

```bash
GLIMPSE_DEV_ORIGIN=http://localhost:5173 glimpse open examples/donut      # PowerShell: $env:GLIMPSE_DEV_ORIGIN="http://localhost:5173"
```

## Where things live

| Package | Responsibility |
|---|---|
| `packages/core` | Scene model, ops, op log (undo/redo), change-list diffing, prompt rendering. Pure TS with no DOM. |
| `packages/server` | HTTP + WebSocket server (`server.ts`), preview instrumentation (`instrument.ts`), live-mode client (`inject.ts`), file watching, handoffs, Edit source patcher (`patch-html.ts`), version history, variants, scene files (`scene.ts`), the terminal for TUI apps (`terminal.ts`) |
| `packages/react` | React/Vite engine: JSX source locations (`instrument-jsx.ts`), the Vite plugin and preview client, the preview dev server on the project's own Vite (`dev-server.ts`), Edit source for JSX (`patch-jsx.ts`). Example: `examples/react-donut` |
| `packages/editor` | React editor UI: home, editor, history. `dom.ts` bridges the preview DOM and the scene |
| `packages/mcp` | MCP server (`glimpse mcp`) |
| `packages/cli` | The `glimpse` command (npm: `glimpse-ui`); bundles the built editor |
| `apps/desktop` | Electron app (its own npm lockfile); ships the `glimpse-ui` bundle. See [docs/desktop.md](docs/desktop.md) |

## Guidelines

- Every human edit must be a typed `Op` in `packages/core/src/ops.ts`, with an inverse for undo.
- New ops need a case in `applyOp`, `invertOp`, `diffScenes` (or the annotation pass) and `describeChange`, plus tests.
- Keep the editor black: use the CSS tokens in `packages/editor/src/styles.css`, not new hard-coded colors.
- Glimpse must work on macOS, Windows and Linux: use `node:path`, report paths with forward slashes, and never shell out to OS-specific tools without a fallback. CI runs on all three.
- Run `pnpm typecheck && pnpm test` before opening a PR.
