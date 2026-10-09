# glimpse-ui

**See what your AI built. Change it with your hands. Hand it back.**

Glimpse is the visual editing layer between you and your AI coding agent (Claude Code, Codex, Cursor, Gemini CLI,
Antigravity, …). Your agent builds a UI and you watch it appear live; then you drag, delete, add, restyle and annotate
elements visually, and either let Glimpse write the edits into the source or send them to your agent with exact
`file:line:col` locations. Works with HTML pages, React/Vite apps, terminal UIs and native desktop GUIs.
macOS · Windows · Linux, Node.js 20+.

```bash
npx glimpse-ui open .            # or: npm i -g glimpse-ui && glimpse open .
```

The package is `glimpse-ui`; the command it installs is `glimpse`.

## Connect your agent (MCP)

```bash
claude mcp add glimpse -- npx -y glimpse-ui mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.glimpse]
command = "npx"
args = ["-y", "glimpse-ui", "mcp"]
```

Cursor, Gemini CLI, Antigravity (`mcpServers` JSON):

```json
{ "mcpServers": { "glimpse": { "command": "npx", "args": ["-y", "glimpse-ui", "mcp"] } } }
```

With a global install (`npm i -g glimpse-ui`) use `glimpse mcp` as the command instead.

## CLI

```text
glimpse open [dir]          Start Glimpse for a project (--port, --target, --entry, --run, --no-browser)
glimpse wait [dir]          Block until the human sends a request or edits, then print them (--json, --timeout)
glimpse changes [dir]       Print the most recent handoff again
glimpse status <message>    Show a status line in Glimpse's live activity feed
glimpse mcp                 Run the MCP server over stdio
```

## Library

```js
import { startGlimpse } from "glimpse-ui";

const srv = await startGlimpse({ dir: "./my-app" }); // port 4321, or a free one
console.log(srv.url);
const handoff = await srv.nextHandoff(undefined, 60_000); // the human's next request or edits
await srv.close();
```

Also exported: `startServer`, `openBrowser`, `createGlimpseMcp`, `runStdio`, `editorDir`, `VERSION`, and the scene
model (its types and helpers such as `changeListToPrompt`). TypeScript types are included.

## More

Documentation, the desktop app and the source: **[github.com/musasacc/Glimpse](https://github.com/musasacc/Glimpse)**
· [Connecting agents](https://github.com/musasacc/Glimpse/blob/main/docs/agents.md)
· [Issues](https://github.com/musasacc/Glimpse/issues)

MIT licensed.
