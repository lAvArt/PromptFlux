import path from "node:path";
import { app, BrowserWindow, globalShortcut } from "electron";
import { loadConfig, saveConfig } from "./config";
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
const OUTPUT_TOGGLE_HOTKEY = "CommandOrControl+Shift+Alt+V";

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 430,
    minWidth: 520,
    minHeight: 340,
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

function invokeRenderer(functionName: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const safePayload = JSON.stringify(payload);
  void mainWindow.webContents
    .executeJavaScript(`window.${functionName}(${safePayload});`, true)
    .catch(() => {});
}

function setRendererStatus(status: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setTitle(`PromptFlux - ${status}`);
  invokeRenderer("__promptfluxSetStatus", status);
}

function setRendererTranscript(
  text: string,
  kind: "neutral" | "recording" | "transcribing" | "success" | "error" = "neutral",
): void {
  invokeRenderer("__promptfluxSetTranscript", { text, kind });
}

function setRendererOutputMode(mode: "clipboard-only" | "auto-paste"): void {
  invokeRenderer("__promptfluxSetOutputMode", mode);
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

  if (mainWindow.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolve) => {
      mainWindow?.webContents.once("did-finish-load", () => resolve());
    });
  }

  setRendererStatus("starting");
  setRendererOutputMode(config.outputMode);

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
      setRendererTranscript("Hold Ctrl+Shift+Space and start speaking.", "neutral");
    },
    onResult: async ({ text, meta }) => {
      await handleOutput(text, config.outputMode);
      console.log("[promptflux] transcription", {
        length: text.length,
        durationMs: meta?.duration_ms ?? 0,
      });
      const finalText = text.trim() ? text : "(No speech detected)";
      setRendererTranscript(finalText, "success");
      setRendererStatus("success");
      setTimeout(() => setRendererStatus("idle"), 1500);
      hotkeyController.resetState();
    },
    onError: ({ code, message }) => {
      console.error("[stt:error]", code, message);
      setRendererTranscript(`${code}: ${message}`, "error");
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
        setRendererTranscript("STT service is not connected.", "error");
        return;
      }
      sttClient.send("START");
      setRendererStatus("recording");
      setRendererTranscript("Listening...", "recording");
    },
    onStop: () => {
      if (!sttClient?.isConnected()) {
        setRendererStatus("error");
        setRendererTranscript("STT service is not connected.", "error");
        return;
      }
      setRendererStatus("transcribing");
      setRendererTranscript("Transcribing...", "transcribing");
      sttClient.send("STOP");
    },
    onError: (message) => {
      console.error("[hotkey]", message);
      setRendererStatus("error");
      setRendererTranscript(message, "error");
    },
  });

  const toggleRegistered = globalShortcut.register(OUTPUT_TOGGLE_HOTKEY, () => {
    config.outputMode = config.outputMode === "clipboard-only" ? "auto-paste" : "clipboard-only";
    saveConfig(config);
    setRendererOutputMode(config.outputMode);
    setRendererTranscript(
      config.outputMode === "auto-paste"
        ? "Auto-paste enabled. Results will be pasted into your active app."
        : "Clipboard-only mode enabled. Results will not auto-paste.",
      "neutral",
    );
  });

  if (!toggleRegistered) {
    console.error("[promptflux] failed to register output toggle hotkey", OUTPUT_TOGGLE_HOTKEY);
  }
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
    globalShortcut.unregisterAll();
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
