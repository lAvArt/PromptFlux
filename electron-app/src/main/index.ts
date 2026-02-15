import path from "node:path";
import { app, BrowserWindow } from "electron";
import { loadConfig } from "./config";
import { handleOutput } from "./clipboard";
import { HotkeyController } from "./hotkey";
import { SttProcessWatchdog } from "./watchdog";
import { SttWebSocketClient } from "./websocket-client";

let mainWindow: BrowserWindow | null = null;
let sttClient: SttWebSocketClient | null = null;
let sttWatchdog: SttProcessWatchdog | null = null;
const hotkeyController = new HotkeyController();
let shutdownStarted = false;
let reconnectLoopRunning = false;

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

function setRendererStatus(status: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setTitle(`PromptFlux - ${status}`);
  const safe = JSON.stringify(status);
  void mainWindow.webContents
    .executeJavaScript(`window.__promptfluxSetStatus(${safe});`, true)
    .catch(() => {});
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

  setRendererStatus("starting");

  const appPath = app.getAppPath();
  const pythonScriptPath = path.resolve(appPath, "../stt-service/server.py");

  sttWatchdog = new SttProcessWatchdog(
    {
      pythonScriptPath,
      port: config.sttPort,
      preBufferMs: config.preBufferMs,
      modelPath: config.modelPath,
    },
    {
      onStdout: (line) => console.log("[stt]", line.trim()),
      onStderr: (line) => console.error("[stt]", line.trim()),
      onFatalExit: (message) => {
        console.error("[stt]", message);
        setRendererStatus("error");
      },
    },
  );
  sttWatchdog.start();

  sttClient = new SttWebSocketClient(config.sttPort, {
    onReady: () => {
      setRendererStatus("idle");
    },
    onResult: async ({ text, meta }) => {
      await handleOutput(text, config.outputMode);
      console.log("[promptflux] transcription", {
        length: text.length,
        durationMs: meta?.duration_ms ?? 0,
      });
      setRendererStatus("success");
      setTimeout(() => setRendererStatus("idle"), 1500);
      hotkeyController.resetState();
    },
    onError: ({ code, message }) => {
      console.error("[stt:error]", code, message);
      setRendererStatus("error");
      setTimeout(() => setRendererStatus("idle"), 3000);
      hotkeyController.resetState();
    },
    onClose: () => {
      if (shutdownStarted) {
        return;
      }
      setRendererStatus("error");
      void ensureSocketConnected();
    },
  });

  const ensureSocketConnected = async (): Promise<void> => {
    if (!sttClient || reconnectLoopRunning || shutdownStarted) {
      return;
    }
    reconnectLoopRunning = true;
    try {
      while (!shutdownStarted && !sttClient.isConnected()) {
        try {
          await sttClient.connect(1, 0);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } finally {
      reconnectLoopRunning = false;
    }
  };

  setRendererStatus("connecting");
  await ensureSocketConnected();

  hotkeyController.registerHoldToTalkHotkey(config.hotkey, {
    onStart: () => {
      if (!sttClient?.isConnected()) {
        setRendererStatus("error");
        return;
      }
      sttClient.send("START");
      setRendererStatus("recording");
    },
    onStop: () => {
      if (!sttClient?.isConnected()) {
        setRendererStatus("error");
        return;
      }
      setRendererStatus("transcribing");
      sttClient.send("STOP");
    },
    onError: (message) => {
      console.error("[hotkey]", message);
      setRendererStatus("error");
    },
  });
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on("before-quit", async (event) => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  event.preventDefault();
  try {
    sttClient?.send("QUIT");
    sttClient?.close();
    hotkeyController.unregisterAll();
    if (sttWatchdog) {
      await sttWatchdog.stop();
    }
  } finally {
    app.exit(0);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    mainWindow = createWindow();
  }
});
