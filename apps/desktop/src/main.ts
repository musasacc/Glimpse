// Glimpse desktop: a home window (describe what to build, recent projects), and one window per project folder, each
// showing the Glimpse editor served by an in-process Glimpse server (the glimpse-ui library bundled in app/glimpse).
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
import {
  detectAgents,
  detectOllama,
  envApiKey,
  KEY_PROVIDERS,
  loadAgentSettings,
  ollamaUrl,
  PROVIDERS,
  saveAgentSettings,
  startGlimpse,
  VERSION as GLIMPSE_VERSION,
  withProjectLock,
} from "../app/glimpse/lib.js";
import { IPC, type AiInfo, type AppInfo, type FolderChoice, type HomeRequest, type RecentEntry, type SendResult } from "./api.js";
import { aiInfo, parseRequest, parseSaveAi, postRequest, projectSlug, toSettingsPatch, uniqueFolder } from "./home.js";
import { chromeScript, desktopPlatform, fullscreenScript, MAC_TRAFFIC_LIGHTS, MCP_SETUP } from "./chrome.js";
import { canonicalDir, dirKey, folderName } from "./paths.js";
import { ProjectServers } from "./projects.js";
import { RecentProjects } from "./recent.js";
import { adoptLoginShellEnv } from "./shell-env.js";

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

// Commands the projects run (meta.command, the agent's glimpse_open) need the PATH a terminal would have. They
// start later (Run, an agent), so a project doesn't wait long for a slow shell: the environment is read at spawn time.
const shellEnv = adoptLoginShellEnv();
const SHELL_ENV_WAIT_MS = 1500;

const recent = new RecentProjects(join(app.getPath("userData"), "recent-projects.json"));
const servers = new ProjectServers({
  lock: withProjectLock,
  start: async (dir) => {
    await Promise.race([shellEnv, new Promise((r) => setTimeout(r, SHELL_ENV_WAIT_MS))]);
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
/** The home composer's folder chip: where the next request is built (null: ask for a new folder on send). */
let chosenFolder: string | null = null;
/** Which kind of window closed last: when it was a project, the home window comes back instead of the app quitting. */
let lastClosed: "home" | "project" | null = null;
let quitting = false;
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
  if (!quitting && lastClosed === "project") {
    lastClosed = null;
    showLauncher();
    return;
  }
  if (!isMac) app.quit();
});

let shutDown = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (shutDown || !servers.active) return;
  event.preventDefault();
  shutDown = true;
  const timeout = new Promise((r) => setTimeout(r, 5000));
  void Promise.race([servers.closeAll(), timeout]).finally(() => app.quit());
});

// ── Home window ──────────────────────────────────────────────────────────────

/** The home window (the "launcher"): describe what to build, or open a recent project. */
function showLauncher(): void {
  if (launcher && !launcher.isDestroyed()) {
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const minWidth = Math.min(900, area.width);
  const minHeight = Math.min(600, area.height);
  const win = new BrowserWindow({
    width: Math.max(minWidth, Math.min(1100, area.width)),
    height: Math.max(minHeight, Math.min(720, area.height)),
    minWidth,
    minHeight,
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
    lastClosed = "home";
  });
  lockDown(win.webContents, null);
  void win.loadFile(join(here, "launcher", "index.html"));
}

function notifyLauncher(): void {
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send(IPC.recentChanged);
}

/** IPC is only answered for the home page; project windows have no preload and can't reach it anyway. */
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
  handle(IPC.openRecent, (_e, path) => {
    // Only folders the user picked before, never an arbitrary path from the page.
    if (typeof path !== "string" || !recent.has(path)) throw new Error("Not a recent project");
    return isDir(path) ? openProject(path) : missingRecent(path);
  });
  handle(IPC.removeRecent, async (_e, path) => {
    if (typeof path !== "string") return;
    await recent.remove(path);
    buildMenu();
    notifyLauncher();
  });
  handle(IPC.folder, (): FolderChoice | null => folderChoice());
  handle(IPC.pickFolder, (event) => pickFolder(event));
  handle(IPC.clearFolder, () => {
    chosenFolder = null;
  });
  handle(IPC.send, (event, request) => sendRequest(event, parseRequest(request)));
  handle(IPC.aiInfo, () => currentAiInfo());
  handle(IPC.saveAi, async (_e, patch) => {
    await saveAgentSettings(toSettingsPatch(parseSaveAi(patch)));
    return currentAiInfo();
  });
}

// ── Home: building something ─────────────────────────────────────────────────

function folderChoice(): FolderChoice | null {
  return chosenFolder ? { path: chosenFolder, name: folderName(chosenFolder) } : null;
}

/** Where Glimpse suggests saving new projects: ~/Documents/Glimpse (created on first use). */
async function projectsHome(): Promise<string> {
  const dir = join(app.getPath("documents"), "Glimpse");
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return isDir(dir) ? dir : app.getPath("documents");
}

/** The composer's folder chip: the folder the next request is built in (an existing project, or any folder). */
async function pickFolder(event: IpcMainInvokeEvent): Promise<FolderChoice | null> {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: "Choose the project folder",
    buttonLabel: "Choose",
    defaultPath: chosenFolder ?? (await projectsHome()),
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  };
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const dir = res.canceled ? undefined : res.filePaths[0];
  if (!dir) return null;
  await mkdir(dir, { recursive: true }); // promptToCreate (Windows) may name a folder that doesn't exist yet
  chosenFolder = canonicalDir(dir);
  return folderChoice();
}

/**
 * A new project (no folder chosen): a save dialog names its folder, suggested from the request
 * (~/Documents/Glimpse/landing-page). Undefined when cancelled.
 */
async function askNewProjectFolder(parent: BrowserWindow | null, text: string): Promise<string | undefined> {
  const suggested = uniqueFolder(await projectsHome(), projectSlug(text), existsSync);
  const options: Electron.SaveDialogOptions = {
    title: "Choose where to save this project",
    message: "Glimpse creates a folder with this name for your project.",
    nameFieldLabel: "Project name:",
    buttonLabel: "Create Project",
    defaultPath: suggested,
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  const dir = res.canceled ? undefined : res.filePath;
  if (!dir) return undefined;
  if (existsSync(dir) && !isDir(dir)) {
    await message(parent, { type: "warning", message: `“${folderName(dir)}” is a file`, detail: "Choose another name for the project folder." });
    return undefined;
  }
  if (isDir(dir)) {
    const entries = (await readdir(dir)).filter((name) => !/^(\.DS_Store|Thumbs\.db|desktop\.ini|\.glimpse)$/i.test(name));
    if (entries.length) {
      const choice = await message(parent, {
        type: "question",
        message: `“${folderName(dir)}” already exists`,
        detail: "Glimpse will build in it, next to the files that are there.",
        buttons: ["Use This Folder", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response !== 0) return undefined;
    }
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

function message(parent: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

/**
 * The home composer's send: build in the chosen folder, or in a new one the user names. Opens the project's window
 * (starting its Glimpse server) and hands the request to that server, which runs the AI; the editor shows it live.
 */
async function sendRequest(event: IpcMainInvokeEvent, request: HomeRequest): Promise<SendResult> {
  const parent = BrowserWindow.fromWebContents(event.sender);
  let dir: string | undefined;
  if (chosenFolder) {
    if (!isDir(chosenFolder)) {
      const gone = chosenFolder;
      chosenFolder = null;
      return { status: "failed", message: `${gone} can't be found anymore. Choose another folder, or send again to start a new project.` };
    }
    dir = chosenFolder;
  } else {
    try {
      dir = await askNewProjectFolder(parent, request.text);
    } catch (err) {
      return { status: "failed", message: `Couldn't create the folder: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!dir) return { status: "canceled" };
  }
  // Home stays open until the request is handed over, so nothing typed is lost if that fails.
  await openProject(dir, { closeHome: false });
  const project = servers.get(dir);
  if (!project || !projectWindows.has(dirKey(dir))) return { status: "failed", message: `Couldn't open “${folderName(dir)}”.` };
  try {
    await postRequest(project.url, request);
  } catch (err) {
    return { status: "failed", message: `“${folderName(dir)}” is open, but the request didn't go through: ${err instanceof Error ? err.message : String(err)}` };
  }
  chosenFolder = null;
  if (launcher && !launcher.isDestroyed()) launcher.close();
  return { status: "sent", folder: dir };
}

/** What builds requests, without any API key. Detection needs the login shell's PATH (claude, codex) and environment (keys). */
async function currentAiInfo(): Promise<AiInfo> {
  await Promise.race([shellEnv, new Promise((r) => setTimeout(r, 3000))]);
  const settings = await loadAgentSettings();
  const [available, ollama] = await Promise.all([detectAgents(settings), detectOllama(ollamaUrl(settings))]);
  const envKeys = Object.fromEntries(KEY_PROVIDERS.map((p) => [p, !!envApiKey(p)])) as Record<(typeof KEY_PROVIDERS)[number], boolean>;
  return aiInfo(settings, available, { providers: PROVIDERS, envKeys, ollama });
}

// ── Projects ─────────────────────────────────────────────────────────────────

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** A recent project whose folder was moved or deleted: find it again, or drop it from the list. */
async function missingRecent(path: string): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: `“${folderName(path)}” can't be found`,
    detail: `${path} was moved, renamed or deleted.`,
    buttons: ["Locate…", "Remove from Recent", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  };
  const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (choice.response === 2) return;
  if (choice.response === 0) {
    const where = [dirname(path), dirname(dirname(path))].find(isDir);
    const pick: Electron.OpenDialogOptions = {
      title: `Locate “${folderName(path)}”`,
      buttonLabel: "Open",
      properties: ["openDirectory"],
      ...(where ? { defaultPath: where } : {}),
    };
    const res = parent ? await dialog.showOpenDialog(parent, pick) : await dialog.showOpenDialog(pick);
    if (res.canceled || !res.filePaths[0]) return;
    await recent.remove(path);
    await openProject(res.filePaths[0]);
  } else {
    await recent.remove(path);
  }
  buildMenu();
  notifyLauncher();
}

async function openFolderDialog(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = { title: "Open a project folder", buttonLabel: "Open", properties: ["openDirectory", "createDirectory"] };
  const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (!res.canceled && res.filePaths[0]) await openProject(res.filePaths[0]);
}

/** Open (or focus) the window for a project folder, starting its Glimpse server if needed. */
function openProject(dirArg: string, { closeHome = true }: { closeHome?: boolean } = {}): Promise<void> {
  const dir = canonicalDir(dirArg);
  const key = dirKey(dir);
  const existing = projectWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (servers.get(dir)?.owned === false && !opening.has(key)) {
      const task = reopenIfStopped(dir, existing).finally(() => opening.delete(key));
      opening.set(key, task);
      return task;
    }
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return Promise.resolve();
  }
  const inFlight = opening.get(key);
  if (inFlight) return inFlight;
  const task = createProjectWindow(dir, key, closeHome)
    .catch((err: unknown) => {
      dialog.showErrorBox(`Couldn't open “${folderName(dir)}”`, err instanceof Error ? err.message : String(err));
    })
    .finally(() => opening.delete(key));
  opening.set(key, task);
  return task;
}

/**
 * A window on a Glimpse started elsewhere (`glimpse open`): focus it while that Glimpse runs, or, once it has
 * stopped, replace the window with one on a server of our own.
 */
async function reopenIfStopped(dir: string, win: BrowserWindow): Promise<void> {
  if (await servers.answers(dir)) {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  if (!win.isDestroyed()) {
    await new Promise<void>((resolve) => {
      win.once("closed", () => resolve());
      win.destroy();
    });
  }
  await servers.close(dir); // forgets the stopped server (the window's own close may still be under way)
  await createProjectWindow(dir, dirKey(dir)).catch((err: unknown) => {
    dialog.showErrorBox(`Couldn't open “${folderName(dir)}”`, err instanceof Error ? err.message : String(err));
  });
}

async function createProjectWindow(dir: string, key: string, closeHome = true): Promise<void> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`The folder ${dir} doesn't exist (anymore).`);
  const project = await servers.open(dir);

  // Never larger than the screen's work area (a 1366×768 laptop at 125% has about 1093×580).
  const area = screen.getPrimaryDisplay().workAreaSize;
  const minWidth = Math.min(1000, area.width);
  const minHeight = Math.min(640, area.height);
  const win = new BrowserWindow({
    width: Math.max(minWidth, Math.min(1440, area.width)),
    height: Math.max(minHeight, Math.min(900, area.height)),
    minWidth,
    minHeight,
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
    lastClosed = "project";
    void servers.close(dir).catch(() => {});
    notifyLauncher();
  });

  const wc = win.webContents;
  lockDown(wc, new URL(project.url).origin);
  wc.on("dom-ready", () => void wc.executeJavaScript(chromeScript(platform, win.isFullScreen())).catch(() => {}));
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
  // Home's job is done once a project is open (it comes back when the last project window closes).
  if (closeHome && launcher && !launcher.isDestroyed()) launcher.close();
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
    { label: "Use with an External Agent…", click: () => copyMcpCommand() },
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
        { type: "separator" },
        { label: "New Project…", accelerator: "CmdOrCtrl+N", click: () => showLauncher() },
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
