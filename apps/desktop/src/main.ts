// Glimpse desktop: a launcher with recent projects, and one window per project folder, each showing the
// Glimpse editor served by an in-process Glimpse server (the glimpse-ui library bundled in app/glimpse).
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { startGlimpse, VERSION as GLIMPSE_VERSION } from "../app/glimpse/lib.js";
import { IPC, type AppInfo, type RecentEntry } from "./api.js";
import { chromeScript, desktopPlatform, fullscreenScript, MAC_CHROME_CSS, MAC_TRAFFIC_LIGHTS, MCP_SETUP } from "./chrome.js";
import { canonicalDir, dirKey, folderName } from "./paths.js";
import { ProjectServers } from "./projects.js";
import { RecentProjects } from "./recent.js";

const here = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";
const platform = desktopPlatform();
const REPO = "https://github.com/musasacc/Glimpse";
const DOCS = {
  readme: `${REPO}#readme`,
  agents: `${REPO}/blob/main/docs/agents.md`,
  desktop: `${REPO}/blob/main/docs/desktop.md`,
  issues: `${REPO}/issues`,
};

// Tests and portable setups can point the app at another profile directory.
if (process.env.GLIMPSE_USER_DATA_DIR) app.setPath("userData", resolve(process.env.GLIMPSE_USER_DATA_DIR));
// Every window sets sandbox: true itself. (app.enableSandbox() would also stop `--no-sandbox` from working, which
// some Linux setups need for AppImages.)

const recent = new RecentProjects(join(app.getPath("userData"), "recent-projects.json"));
const servers = new ProjectServers({
  start: async (dir) => {
    const srv = await startGlimpse({ dir });
    return {
      url: srv.url,
      token: srv.token,
      async close() {
        const closing = srv.close();
        // Don't let a long-polling agent request hold the app open.
        const force = setTimeout(() => srv.server.closeAllConnections(), 1000);
        try {
          await closing;
        } finally {
          clearTimeout(force);
        }
      },
    };
  },
});
const projectWindows = new Map<string, BrowserWindow>();
const opening = new Map<string, Promise<void>>();
let launcher: BrowserWindow | null = null;
/** Folders asked for before the app was ready (argv, macOS open-file). */
const queued: string[] = [];
let ready = false;

// ── Single instance ──────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const dirs = foldersFromArgv(argv, cwd);
    if (dirs.length) for (const dir of dirs) void openProject(dir);
    else focusSomething();
  });
  // macOS: a folder dropped on the Dock icon, or `open -a Glimpse <folder>`.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (ready) void openProject(path);
    else queued.push(path);
  });
  app.whenReady().then(start, (err: unknown) => {
    dialog.showErrorBox("Glimpse couldn't start", String(err));
    app.exit(1);
  });
}

async function start(): Promise<void> {
  await recent.load();
  restrictPermissions();
  registerIpc();
  buildMenu();
  ready = true;
  queued.push(...foldersFromArgv(process.argv, process.cwd()));
  const initial = [...new Set(queued.splice(0))];
  if (initial.length) for (const dir of initial) void openProject(dir);
  else showLauncher();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showLauncher();
  });
}

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

let shutDown = false;
app.on("before-quit", (event) => {
  if (shutDown || servers.size === 0) return;
  event.preventDefault();
  shutDown = true;
  const timeout = new Promise((r) => setTimeout(r, 5000));
  void Promise.race([servers.closeAll(), timeout]).finally(() => app.quit());
});

// ── Launcher ─────────────────────────────────────────────────────────────────

function showLauncher(): void {
  if (launcher && !launcher.isDestroyed()) {
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 540,
    minWidth: 560,
    minHeight: 440,
    title: "Glimpse",
    backgroundColor: "#000000",
    show: false,
    autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  launcher = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (launcher === win) launcher = null;
  });
  lockDown(win.webContents, null);
  void win.loadFile(join(here, "launcher", "index.html"));
}

function notifyLauncher(): void {
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send(IPC.recentChanged);
}

/** IPC is only answered for the launcher page; project windows have no preload and can't reach it anyway. */
function registerIpc(): void {
  const fromLauncher = (event: IpcMainInvokeEvent) => !!launcher && !launcher.isDestroyed() && event.sender === launcher.webContents;
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromLauncher(event)) throw new Error("Not allowed");
      return fn(event, ...args);
    });

  handle(IPC.info, (): AppInfo => ({ version: app.getVersion(), glimpseVersion: GLIMPSE_VERSION, platform: process.platform }));
  handle(IPC.recent, (): RecentEntry[] =>
    recent.withStatus().map((p) => ({ ...p, open: projectWindows.has(dirKey(p.path)) })),
  );
  handle(IPC.openFolder, () => openFolderDialog());
  handle(IPC.newProject, () => newProjectDialog());
  handle(IPC.openRecent, (_e, path) => {
    // Only folders the user picked before, never an arbitrary path from the page.
    if (typeof path !== "string" || !recent.has(path)) throw new Error("Not a recent project");
    return openProject(path);
  });
  handle(IPC.removeRecent, async (_e, path) => {
    if (typeof path !== "string") return;
    await recent.remove(path);
    buildMenu();
    notifyLauncher();
  });
}

// ── Projects ─────────────────────────────────────────────────────────────────

async function openFolderDialog(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = { title: "Open a project folder", buttonLabel: "Open", properties: ["openDirectory", "createDirectory"] };
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (!res.canceled && res.filePaths[0]) await openProject(res.filePaths[0]);
}

async function newProjectDialog(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: "New project: choose or create an empty folder",
    message: "Choose or create an empty folder for the new project.",
    buttonLabel: "Create Project",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  };
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const dir = res.canceled ? undefined : res.filePaths[0];
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const entries = (await readdir(dir)).filter((name) => !/^(\.DS_Store|Thumbs\.db|desktop\.ini|\.glimpse)$/i.test(name));
  if (entries.length) {
    const choice = await dialog.showMessageBox({
      type: "question",
      message: `“${folderName(dir)}” isn't empty`,
      detail: "Glimpse will open it as an existing project instead of starting from scratch.",
      buttons: ["Open Anyway", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return;
  }
  await openProject(dir);
}

/** Open (or focus) the window for a project folder, starting its Glimpse server if needed. */
function openProject(dirArg: string): Promise<void> {
  const dir = canonicalDir(dirArg);
  const key = dirKey(dir);
  const existing = projectWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return Promise.resolve();
  }
  const inFlight = opening.get(key);
  if (inFlight) return inFlight;
  const task = createProjectWindow(dir, key)
    .catch((err: unknown) => {
      dialog.showErrorBox(`Couldn't open “${folderName(dir)}”`, err instanceof Error ? err.message : String(err));
    })
    .finally(() => opening.delete(key));
  opening.set(key, task);
  return task;
}

async function createProjectWindow(dir: string, key: string): Promise<void> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`The folder ${dir} doesn't exist (anymore).`);
  const project = await servers.open(dir);

  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.max(1000, Math.min(1440, area.width)),
    height: Math.max(640, Math.min(900, area.height)),
    minWidth: 1000,
    minHeight: 640,
    title: folderName(dir),
    backgroundColor: "#000000",
    show: false,
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: MAC_TRAFFIC_LIGHTS } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  projectWindows.set(key, win);
  if (isMac) win.setRepresentedFilename(dir);
  win.once("ready-to-show", () => win.show());
  // Keep the folder name as the title whatever the page calls itself.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("closed", () => {
    projectWindows.delete(key);
    void servers.close(dir).catch(() => {});
    notifyLauncher();
  });

  const wc = win.webContents;
  lockDown(wc, new URL(project.url).origin);
  wc.on("dom-ready", () => {
    if (isMac) void wc.insertCSS(MAC_CHROME_CSS);
    void wc.executeJavaScript(chromeScript(platform, win.isFullScreen())).catch(() => {});
  });
  win.on("enter-full-screen", () => void wc.executeJavaScript(fullscreenScript(true)).catch(() => {}));
  win.on("leave-full-screen", () => void wc.executeJavaScript(fullscreenScript(false)).catch(() => {}));
  wc.on("render-process-gone", async (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const choice = await dialog.showMessageBox(win, {
      type: "warning",
      message: "The editor stopped unexpectedly",
      detail: `Reason: ${details.reason}. Your project files are untouched.`,
      buttons: ["Reload", "Close Window"],
      defaultId: 0,
    });
    if (win.isDestroyed()) return;
    if (choice.response === 0) wc.reload();
    else win.close();
  });

  const url = new URL(project.url);
  url.pathname = "/";
  url.searchParams.set("desktop", platform);
  try {
    await win.loadURL(url.toString());
  } catch (err) {
    if (!win.isDestroyed()) win.destroy();
    throw err;
  }

  await recent.add(dir);
  app.addRecentDocument(dir);
  buildMenu();
  notifyLauncher();
  // The launcher's job is done once a project is open.
  if (launcher && !launcher.isDestroyed()) launcher.close();
}

function focusSomething(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return showLauncher();
  if (win.isMinimized()) win.restore();
  win.focus();
}

/** Folder paths among command-line arguments (skipping flags and, under `electron .`, the app path). */
function foldersFromArgv(argv: string[], cwd: string): string[] {
  const args = argv.slice(process.defaultApp ? 2 : 1);
  const appPath = dirKey(app.getAppPath());
  const out: string[] = [];
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    const dir = resolve(cwd, arg);
    try {
      if (statSync(dir).isDirectory() && dirKey(dir) !== appPath) out.push(dir);
    } catch {
      // not a folder
    }
  }
  return out;
}

// ── Security ─────────────────────────────────────────────────────────────────

/**
 * Pages may only navigate within their own origin (the project's Glimpse server; the launcher none at all).
 * Everything else, including window.open and target=_blank links, opens in the system browser.
 */
function lockDown(wc: WebContents, origin: string | null): void {
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (origin && sameOrigin(url, origin)) return;
    event.preventDefault();
    openExternal(url);
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    // not a URL
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Local Glimpse pages may use the microphone (talk to an element), the clipboard and fullscreen; nothing else. */
function restrictPermissions(): void {
  const allowed = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  const local = (url: string | undefined) => {
    try {
      const host = new URL(url ?? "").hostname;
      return host === "127.0.0.1" || host === "localhost";
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && local(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && local(requestingOrigin));
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function buildMenu(): void {
  const recentItems: MenuItemConstructorOptions[] = recent.list().map((p) => ({
    label: p.name,
    sublabel: p.path,
    toolTip: p.path,
    click: () => void openProject(p.path),
  }));
  const help: MenuItemConstructorOptions[] = [
    { label: "Documentation", click: () => openExternal(DOCS.readme) },
    { label: "Connect an Agent", click: () => openExternal(DOCS.agents) },
    { label: "Copy MCP Command", click: () => copyMcpCommand() },
    { type: "separator" },
    { label: "Desktop App Guide", click: () => openExternal(DOCS.desktop) },
    { label: "Report an Issue", click: () => openExternal(DOCS.issues) },
    ...(isMac ? [] : [{ type: "separator" as const }, { label: "About Glimpse", click: () => app.showAboutPanel() }]),
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolderDialog() },
        {
          label: "Open Recent",
          submenu: recentItems.length
            ? [
                ...recentItems,
                { type: "separator" },
                {
                  label: "Clear Recent",
                  click: async () => {
                    await recent.clear();
                    app.clearRecentDocuments();
                    buildMenu();
                    notifyLauncher();
                  },
                },
              ]
            : [{ label: "No Recent Projects", enabled: false }],
        },
        { label: "New Project…", accelerator: "CmdOrCtrl+Shift+N", click: () => void newProjectDialog() },
        { type: "separator" },
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => showLauncher() },
        { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: help },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({
    applicationName: "Glimpse",
    applicationVersion: app.getVersion(),
    version: `glimpse-ui ${GLIMPSE_VERSION}`,
    copyright: "MIT License · Glimpse contributors",
    website: REPO,
  });
}

function copyMcpCommand(): void {
  clipboard.writeText(MCP_SETUP);
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.MessageBoxOptions = {
    type: "info",
    message: "MCP setup copied",
    detail:
      "Paste it into your agent's MCP config, or run the Claude Code line in a terminal. While a project is open here, " +
      "`glimpse mcp` finds this window's Glimpse and the agent works with it.\n\nNeeds Node.js 20+ (npx).",
    buttons: ["OK", "Open Agent Guide"],
    defaultId: 0,
  };
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then((r) => {
    if (r.response === 1) openExternal(DOCS.agents);
  });
}
