import { contextBridge, ipcRenderer } from "electron";

const ALLOWED_CHANNELS = new Set([
  "settings:get",
  "settings:save",
  "devices:list",
  "mobile:regenerate-token",
  "app-window:minimize",
  "app-window:toggle-maximize",
  "app-window:close",
  "app-window:state",
]);

contextBridge.exposeInMainWorld("promptfluxApi", {
  invoke(channel: string, payload?: unknown) {
    if (!ALLOWED_CHANNELS.has(channel)) {
      throw new Error(`Unsupported IPC channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, payload);
  },
});
