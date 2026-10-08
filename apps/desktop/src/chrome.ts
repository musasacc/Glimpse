/**
 * How a project window tells the editor it runs inside the desktop app.
 *
 * The editor is loaded as `<server>/?desktop=<mac|win|linux>`, and once the DOM is ready the app sets
 * `<html data-glimpse-desktop="mac|win|linux">` (plus `data-glimpse-fullscreen` while fullscreen). On macOS the
 * window uses titleBarStyle "hiddenInset", so the traffic lights sit on top of the page: until the editor styles
 * this itself, the app injects MAC_CHROME_CSS, which reserves a 30px draggable strip at the top for them.
 * The selectors only depend on the editor's top-level `.shell` element and are a no-op if it's renamed.
 */
export type DesktopPlatform = "mac" | "win" | "linux";

export function desktopPlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
  return platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
}

/** Height of the title strip that holds the traffic lights. */
export const MAC_TITLE_STRIP = 30;

/** Where the traffic lights go inside that strip. */
export const MAC_TRAFFIC_LIGHTS = { x: 14, y: 9 };

export const MAC_CHROME_CSS = `
html[data-glimpse-desktop="mac"]:not([data-glimpse-fullscreen]) .shell { padding-top: ${MAC_TITLE_STRIP}px; }
html[data-glimpse-desktop="mac"]:not([data-glimpse-fullscreen]) #glimpse-desktop-drag {
  position: fixed; top: 0; left: 0; right: 0; height: ${MAC_TITLE_STRIP}px; z-index: 2147483647;
  -webkit-app-region: drag;
}
html[data-glimpse-desktop="mac"][data-glimpse-fullscreen] #glimpse-desktop-drag { display: none; }
`;

/** Script run in the editor page after dom-ready (main world; it only touches attributes and one empty div). */
export function chromeScript(platform: DesktopPlatform, fullscreen: boolean): string {
  return `(() => {
  const root = document.documentElement;
  root.setAttribute("data-glimpse-desktop", ${JSON.stringify(platform)});
  root.toggleAttribute("data-glimpse-fullscreen", ${fullscreen ? "true" : "false"});
  if (${JSON.stringify(platform)} === "mac" && !document.getElementById("glimpse-desktop-drag")) {
    const strip = document.createElement("div");
    strip.id = "glimpse-desktop-drag";
    strip.setAttribute("aria-hidden", "true");
    document.body.appendChild(strip);
  }
})();`;
}

export function fullscreenScript(fullscreen: boolean): string {
  return `document.documentElement.toggleAttribute("data-glimpse-fullscreen", ${fullscreen ? "true" : "false"});`;
}

/** What Help › Copy MCP command puts on the clipboard. */
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
