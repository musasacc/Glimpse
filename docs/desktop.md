# The Glimpse desktop app

The desktop app (`apps/desktop`) is Glimpse in its own window: no terminal, no browser tab. It is an Electron app
that runs the same Glimpse server and editor as `glimpse open`, with a launcher for your recent projects.

## How it works

```
Glimpse.app
├─ main process (dist/main.mjs)
│   ├─ launcher window ── recent projects, Open folder…, New project…
│   └─ one Glimpse server per project folder (in-process, port 4321 or a free one)
│        └─ project window ── loads the editor from that server, like a browser would
└─ app/glimpse/  the glimpse-ui bundle: library, CLI and built editor (copied from packages/cli/dist)
```

- **Launcher.** On start (and from **File › New Window**) the app shows a black launcher with **Open folder…**,
  **New project…** (pick or create an empty folder) and your recent projects. The recent list is a JSON file in the
  app's user-data folder (`~/Library/Application Support/Glimpse/recent-projects.json` on macOS,
  `%APPDATA%\Glimpse\recent-projects.json` on Windows, `~/.config/Glimpse/recent-projects.json` on Linux).
- **Projects.** Opening a folder starts a Glimpse server for it inside the app (`startGlimpse` from `glimpse-ui`) and
  loads the editor in a 1440×900 window titled with the folder name. Each folder gets one window and one server;
  opening it again focuses the window. Closing the window, or quitting, stops its server.
- **Agents find it.** Like `glimpse open`, the app writes `<project>/.glimpse/server.json` (URL, pid and the token
  that lets local tools run the app in Glimpse's terminal), so `glimpse wait` and the MCP server (`glimpse_open` with
  that folder) talk to the window you have open. **Help › Copy MCP Command** copies
  the setup lines for Claude Code, Codex, Cursor and the rest (they use `npx -y glimpse-ui mcp`, so the agent's
  machine needs Node.js 20+).
- **Already running elsewhere?** If `glimpse open` already serves the folder, the app shows that server instead of
  starting a second one (two servers on one project would hand out conflicting handoff numbers).
- **Command line.** `Glimpse /path/to/project` (or dropping a folder on the Dock icon on macOS) opens that folder.
  A second launch hands its folder to the running app (single instance).
- **Menus.** File (Open Folder…, Open Recent, New Project…, New Window, Close Window), Edit, View (reload, DevTools,
  zoom, full screen), Window, Help (documentation, connecting an agent, Copy MCP Command).

### Security

Project windows load only the local Glimpse server, with `contextIsolation`, `sandbox` and no Node integration; they
have no preload, so the page (and the preview of your project inside it) can't reach the app. The launcher is a local
page with a strict Content-Security-Policy and a sandboxed preload that exposes six IPC calls; the main process
answers them only for the launcher and only opens folders the user picked or that are in the recent list.
Navigation away from the server's origin, `window.open` and `target=_blank` links open in the system browser.
Permission requests are denied except the microphone (talk to an element), the clipboard and full screen, for the
local server only.

### macOS title bar and the editor

On macOS, project windows use `titleBarStyle: "hiddenInset"`: no title bar, the traffic lights float over the page.
The app tells the editor where it runs in two ways:

- the editor URL gets `?desktop=mac` (`win` / `linux` on the other systems), readable at first paint, and
- after the DOM is ready, `<html data-glimpse-desktop="mac">` (plus `data-glimpse-fullscreen` while in full screen).

Until the editor styles this itself, the app injects a small stylesheet (`apps/desktop/src/chrome.ts`) that adds a
30px draggable strip for the traffic lights above the editor's `.shell`. When the editor takes it over, it can key
the same rules off `html[data-glimpse-desktop="mac"]` and the app's injected CSS can go.

### Why Electron, and why outside the workspace

Glimpse's server is Node.js, and Electron ships Node, so the server runs in the app's own process with no sidecar
binary to build per platform, and the editor renders in the same Chromium on every OS. The app has its own
`package.json` and npm lockfile instead of being a pnpm workspace package, so the regular CI (`pnpm install` on three
OSes, twice) never downloads Electron; only the desktop workflow does.

## Building it locally

Prerequisites: Node.js 22 (20 works too), pnpm, and a built monorepo.

```bash
pnpm install && pnpm build          # at the repo root: builds packages/cli/dist (library + editor)
cd apps/desktop
npm ci                              # Electron, electron-builder, esbuild, and glimpse-ui's runtime dependencies
npm start                           # build and run the app
```

| Command | What it does |
|---|---|
| `npm run build` | Copies `packages/cli/dist` to `app/glimpse` (`scripts/prepare.mjs`), bundles `src/` with esbuild into `dist/` |
| `npm start` | Build, then `electron .` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | Unit tests without Electron: recent-projects store, server lifecycle against the real bundled library |
| `npm run smoke` | Launches the app for real: launcher, a project window, server start/stop (Linux: `xvfb-run -a npm run smoke`) |
| `npm run dist -- --dir` | Unpacked app in `release/` (fast; what the Desktop workflow builds) |
| `npm run smoke -- --packaged` | The smoke test against that unpacked app |
| `npm run dist` | Installers for the current OS in `release/` |
| `npm run icon` | Re-renders `assets/icon.png` from `assets/mark.svg` with Playwright's Chromium (commit the PNG) |

`apps/desktop/package.json` "dependencies" must equal glimpse-ui's (`packages/cli/package.json`): the bundled library
imports them at runtime from the app's `node_modules`. `prepare.mjs` fails with the exact lines to add when they
drift; after changing them, run `npm install` in `apps/desktop` and commit the lockfile.

Installers per OS: macOS builds `.dmg` and `.zip` (arm64 and x64) and must run on a Mac; Windows builds NSIS `.exe`
installers (x64 and arm64) on Windows; Linux builds `.AppImage` and `.deb` (x64) on Linux. The
[Release workflow](releasing.md) does all three on GitHub's runners.

`npm ci` doesn't download Electron's binary (Electron 44 fetches it on first use: `npm start`, the smoke test, or
`npx install-electron`), so typechecking, unit tests and bundling work offline after install; packaging downloads
its own copy into electron-builder's cache.

## Unsigned builds

Until signing secrets are set up (below), the installers are unsigned, so each OS asks once:

- **macOS:** the first time, right-click Glimpse in Applications and choose **Open** (or **System Settings › Privacy &
  Security › Open Anyway**). If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/Glimpse.app`.
- **Windows:** SmartScreen shows "Windows protected your PC": click **More info › Run anyway**.
- **Linux:** `chmod +x Glimpse-*.AppImage` and run it. On distributions that restrict unprivileged user namespaces
  (Ubuntu 24.04 and later), the AppImage may exit with a sandbox error: install the `.deb` instead, or start the
  AppImage with `--no-sandbox`.

## Signing and notarization

electron-builder signs automatically when it finds credentials in the environment; the Release workflow passes them
through from repository secrets (see [releasing.md](releasing.md#optional-signing-secrets)).

- **macOS:** a *Developer ID Application* certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12 | pbcopy`)
  → `MAC_CSC_LINK`, its password → `MAC_CSC_KEY_PASSWORD`. To notarize (recommended, so Gatekeeper opens the app
  without the right-click step), add an App Store Connect API key: the `.p8` file's contents → `APPLE_API_KEY_P8`,
  plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The hardened runtime and Electron's default entitlements are on.
- **Windows:** an Authenticode certificate as base64 `.pfx` → `WIN_CSC_LINK`, password → `WIN_CSC_KEY_PASSWORD`.
  EV certificates on hardware tokens and cloud signing (Azure Trusted Signing: `win.azureSignOptions` in
  `electron-builder.yml`) need a different setup; see electron-builder's Windows signing docs.
- **Linux:** AppImage and `.deb` aren't signed.

Locally, export the same variables electron-builder reads (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` as a path
to the `.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`) before `npm run dist`.
Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to force an unsigned macOS build on a Mac that has certificates installed.
