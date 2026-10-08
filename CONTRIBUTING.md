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
```

For editor work with hot reload, keep `glimpse open` running (port 4321) and run `pnpm dev` in another terminal.
Vite proxies the API, the preview and the live-mode websocket to the Glimpse server.

## Where things live

| Package | Responsibility |
|---|---|
| `packages/core` | Scene model, ops, op log (undo/redo), change-list diffing, prompt rendering. Pure TS with no DOM. |
| `packages/server` | HTTP + WebSocket server, preview injection, file watching, handoff API |
| `packages/editor` | React editor UI. `dom.ts` bridges the preview DOM and the scene |
| `packages/cli` | The `glimpse` command; bundles the built editor |

## Guidelines

- Every human edit must be a typed `Op` in `packages/core/src/ops.ts`, with an inverse for undo.
- New ops need a case in `applyOp`, `invertOp`, `diffScenes` (or the annotation pass) and `describeChange`, plus tests.
- Keep the editor black: use the CSS tokens in `packages/editor/src/styles.css`, not new hard-coded colors.
- Run `pnpm typecheck && pnpm test` before opening a PR.
