import path from "node:path";
import { app, BrowserWindow } from "electron";
import { loadConfig } from "./config";

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 380,
    height: 180,
    title: "PromptFlux",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  const htmlPath = path.resolve(__dirname, "../../src/renderer/index.html");
  void window.loadFile(htmlPath);
  return window;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  console.log("[promptflux] config loaded", {
    hotkey: config.hotkey,
    outputMode: config.outputMode,
    sttPort: config.sttPort,
    preBufferMs: config.preBufferMs,
  });

  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    mainWindow = createWindow();
  }
});
