// Preload for the launcher window only (sandboxed, context-isolated): exposes exactly the launcher's IPC calls.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type LauncherApi } from "./api.js";

const api: LauncherApi = {
  info: () => ipcRenderer.invoke(IPC.info),
  recent: () => ipcRenderer.invoke(IPC.recent),
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  newProject: () => ipcRenderer.invoke(IPC.newProject),
  openRecent: (path) => ipcRenderer.invoke(IPC.openRecent, String(path)),
  removeRecent: (path) => ipcRenderer.invoke(IPC.removeRecent, String(path)),
  onRecentChanged(listener) {
    const handler = () => listener();
    ipcRenderer.on(IPC.recentChanged, handler);
    return () => void ipcRenderer.removeListener(IPC.recentChanged, handler);
  },
};

contextBridge.exposeInMainWorld("glimpse", api);
