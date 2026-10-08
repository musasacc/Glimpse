/** What the launcher window may ask the main process for (exposed by preload.ts as `window.glimpse`). */
export interface LauncherApi {
  info(): Promise<AppInfo>;
  recent(): Promise<RecentEntry[]>;
  /** Pick an existing folder and open it. */
  openFolder(): Promise<void>;
  /** Pick or create an empty folder and open it as a new project. */
  newProject(): Promise<void>;
  /** Open a folder from the recent list. */
  openRecent(path: string): Promise<void>;
  removeRecent(path: string): Promise<void>;
  /** Called whenever the recent list changes; returns an unsubscribe function. */
  onRecentChanged(listener: () => void): () => void;
}

export interface AppInfo {
  version: string;
  glimpseVersion: string;
  platform: NodeJS.Platform;
}

export interface RecentEntry {
  path: string;
  name: string;
  /** ISO timestamp of the last time it was opened. */
  openedAt: string;
  /** False when the folder was moved or deleted. */
  exists: boolean;
  /** True while a window for it is open. */
  open: boolean;
}

/** IPC channel names (ipcMain.handle / ipcRenderer.invoke). */
export const IPC = {
  info: "glimpse:info",
  recent: "glimpse:recent",
  openFolder: "glimpse:open-folder",
  newProject: "glimpse:new-project",
  openRecent: "glimpse:open-recent",
  removeRecent: "glimpse:remove-recent",
  recentChanged: "glimpse:recent-changed",
} as const;
