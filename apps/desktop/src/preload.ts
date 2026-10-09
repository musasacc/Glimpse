// Preload for the home window only (sandboxed, context-isolated): exposes exactly the home window's IPC calls.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type LauncherApi } from "./api.js";

const api: LauncherApi = {
  info: () => ipcRenderer.invoke(IPC.info),
  recent: () => ipcRenderer.invoke(IPC.recent),
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  openRecent: (path) => ipcRenderer.invoke(IPC.openRecent, String(path)),
  removeRecent: (path) => ipcRenderer.invoke(IPC.removeRecent, String(path)),
  onRecentChanged(listener) {
    const handler = () => listener();
    ipcRenderer.on(IPC.recentChanged, handler);
    return () => void ipcRenderer.removeListener(IPC.recentChanged, handler);
  },
  folder: () => ipcRenderer.invoke(IPC.folder),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  clearFolder: () => ipcRenderer.invoke(IPC.clearFolder),
  send: (request) => ipcRenderer.invoke(IPC.send, { text: String(request?.text ?? ""), target: String(request?.target ?? "") }),
  aiInfo: () => ipcRenderer.invoke(IPC.aiInfo),
  saveAi: (patch) =>
    ipcRenderer.invoke(IPC.saveAi, {
      ...(patch?.engine !== undefined && { engine: String(patch.engine) }),
      ...(patch?.anthropicApiKey !== undefined && { anthropicApiKey: patch.anthropicApiKey === null ? null : String(patch.anthropicApiKey) }),
      ...(patch?.provider !== undefined && { provider: String(patch.provider) }),
      ...(patch?.model !== undefined && { model: patch.model === null ? null : String(patch.model) }),
      ...(patch?.apiKey !== undefined && {
        apiKey: { provider: String(patch.apiKey?.provider), key: patch.apiKey?.key === null ? null : String(patch.apiKey?.key) },
      }),
    }),
};

contextBridge.exposeInMainWorld("glimpse", api);
