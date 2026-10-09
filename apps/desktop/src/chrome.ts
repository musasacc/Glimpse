/**
 * How a project window tells the editor it runs inside the desktop app.
 *
 * The editor is loaded as `<server>/?desktop=<mac|win|linux>` (it marks itself before the first paint), and once the
 * DOM is ready the app sets `<html data-glimpse-desktop="mac|win|linux">` too, plus `data-glimpse-fullscreen` while
 * in full screen. On macOS the window uses titleBarStyle "hiddenInset", so the traffic lights sit on top of the page
 * at MAC_TRAFFIC_LIGHTS: the editor's styles.css leaves a strip for them and makes its top bars drag the window.
 */
export type DesktopPlatform = "mac" | "win" | "linux";

export function desktopPlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
  return platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
}

/** Where the traffic lights go: inside the 30px strip the editor leaves at the top (packages/editor/src/styles.css). */
export const MAC_TRAFFIC_LIGHTS = { x: 14, y: 9 };

/** Script run in the editor page after dom-ready (main world; it only touches attributes). */
export function chromeScript(platform: DesktopPlatform, fullscreen: boolean): string {
  return `(() => {
  const root = document.documentElement;
  root.setAttribute("data-glimpse-desktop", ${JSON.stringify(platform)});
  root.toggleAttribute("data-glimpse-fullscreen", ${fullscreen ? "true" : "false"});
})();`;
}

export function fullscreenScript(fullscreen: boolean): string {
  return `document.documentElement.toggleAttribute("data-glimpse-fullscreen", ${fullscreen ? "true" : "false"});`;
}

/** What Help › Use with an External Agent… puts on the clipboard. */
export const MCP_SETUP = `# Connect your AI agent to Glimpse (MCP). The agent finds the project you have open in the desktop app.

# Claude Code
claude mcp add glimpse -- npx -y glimpse-ui mcp

# Codex: ~/.codex/config.toml
[mcp_servers.glimpse]
command = "npx"
args = ["-y", "glimpse-ui", "mcp"]

# Cursor (.cursor/mcp.json), Gemini CLI (~/.gemini/settings.json), Antigravity (raw MCP config)
{ "mcpServers": { "glimpse": { "command": "npx", "args": ["-y", "glimpse-ui", "mcp"] } } }

# With \`npm i -g glimpse-ui\`, use \`glimpse mcp\` instead of \`npx -y glimpse-ui mcp\`.
# More: https://github.com/musasacc/Glimpse/blob/main/docs/agents.md
`;
