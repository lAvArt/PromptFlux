import path from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { listAudioDevices } from "./audio-devices";
import { handleOutput } from "./clipboard";
import { AppConfig, CaptureSource, loadConfig, saveConfig } from "./config";
import { HotkeyController } from "./hotkey";
import { SttProcessWatchdog } from "./watchdog";
import { SttWebSocketClient } from "./websocket-client";

type SettingsGetResponse = {
  config: AppConfig;
  devices: Awaited<ReturnType<typeof listAudioDevices>>;
  outputToggleHotkey: string;
};

type SettingsSaveRequest = {
  hotkey: string;
  outputMode: AppConfig["outputMode"];
  transcriptionLanguage: AppConfig["transcriptionLanguage"];
  triggerMode: AppConfig["triggerMode"];
  wakeWord: string;
  wakeSilenceMs: number;
  wakeRecordMs: number;
  soundCueEnabled: boolean;
  soundCueVolume: number;
  soundCueOnStart: boolean;
  soundCueOnStop: boolean;
  soundCueOnTranscribed: boolean;
  soundCueOnError: boolean;
  captureSource: CaptureSource;
  microphoneDevice: string | null;
  systemAudioDevice: string | null;
  preBufferMs: number;
};

let appConfig: AppConfig = loadConfig();
let mainWindow: BrowserWindow | null = null;
let sttClient: SttWebSocketClient | null = null;
let sttWatchdog: SttProcessWatchdog | null = null;
const hotkeyController = new HotkeyController();
let shutdownStarted = false;
let reconnectLoopRunning = false;
let ipcRegistered = false;
let pipeGuardsRegistered = false;
let recordingActive = false;
let wakeAutoStopTimer: NodeJS.Timeout | null = null;

let sttServerScriptPath = "";
let listDevicesScriptPath = "";

const OUTPUT_TOGGLE_HOTKEY = "CommandOrControl+Shift+Alt+V";

function safeLog(...args: unknown[]): void {
  try {
    console.log(...args);
  } catch {
    // Ignore logging pipe errors (e.g. EPIPE) in detached/no-console environments.
  }
}

function safeError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Ignore logging pipe errors (e.g. EPIPE) in detached/no-console environments.
  }
}

function isBrokenPipeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  return code === "EPIPE" || message.includes("EPIPE: broken pipe");
}

function registerProcessPipeGuards(): void {
  if (pipeGuardsRegistered) {
    return;
  }
  pipeGuardsRegistered = true;

  const streamErrorHandler = (error: unknown) => {
    if (isBrokenPipeError(error)) {
      return;
    }
    safeError("[promptflux] process stream error", error);
  };

  process.stdout?.on?.("error", streamErrorHandler);
  process.stderr?.on?.("error", streamErrorHandler);

  process.on("uncaughtException", (error) => {
    if (isBrokenPipeError(error)) {
      return;
    }
    throw error;
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 700,
    height: 520,
    minWidth: 620,
    minHeight: 420,
    title: "PromptFlux",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
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

function setRendererOutputMode(mode: AppConfig["outputMode"]): void {
  invokeRenderer("__promptfluxSetOutputMode", mode);
}

function setRendererCueSettings(config: AppConfig): void {
  invokeRenderer("__promptfluxSetCueSettings", {
    enabled: config.soundCueEnabled,
    volume: config.soundCueVolume,
    onStart: config.soundCueOnStart,
    onStop: config.soundCueOnStop,
    onTranscribed: config.soundCueOnTranscribed,
    onError: config.soundCueOnError,
  });
}

function playRendererCue(type: "start" | "stop" | "transcribed" | "error"): void {
  invokeRenderer("__promptfluxPlayCue", { type });
}

function clearWakeAutoStopTimer(): void {
  if (wakeAutoStopTimer) {
    clearTimeout(wakeAutoStopTimer);
    wakeAutoStopTimer = null;
  }
}

function beginRecording(reason: "hotkey" | "wake"): void {
  if (recordingActive) {
    return;
  }
  if (!sttClient?.isConnected()) {
    setRendererStatus("error");
    setRendererTranscript("STT service is not connected.", "error");
    playRendererCue("error");
    return;
  }

  recordingActive = true;
  sttClient.send("START", reason === "wake" ? { reason: "wake" } : undefined);
  setRendererStatus("recording");
  playRendererCue("start");
  if (reason === "wake") {
    clearWakeAutoStopTimer();
    setRendererTranscript(
      `Wake word detected: "${appConfig.wakeWord}". Listening until silence...`,
      "recording",
    );
  } else {
    setRendererTranscript("Listening...", "recording");
  }
}

function stopRecording(reason: "hotkey" | "wake-timeout" | "wake-silence"): void {
  if (!recordingActive) {
    return;
  }
  clearWakeAutoStopTimer();
  recordingActive = false;

  if (!sttClient?.isConnected()) {
    setRendererStatus("error");
    setRendererTranscript("STT service is not connected.", "error");
    playRendererCue("error");
    return;
  }

  setRendererStatus("transcribing");
  playRendererCue("stop");
  setRendererTranscript(
    reason === "wake-timeout"
      ? "Wake max duration reached. Transcribing..."
      : reason === "wake-silence"
        ? "Silence detected. Transcribing..."
        : "Transcribing...",
    "transcribing",
  );
  sttClient.send("STOP", { language: appConfig.transcriptionLanguage });
}

function createWatchdog(): SttProcessWatchdog {
  return new SttProcessWatchdog(
    {
      pythonScriptPath: sttServerScriptPath,
      port: appConfig.sttPort,
      preBufferMs: appConfig.preBufferMs,
      modelPath: appConfig.modelPath,
      transcriptionLanguage: appConfig.transcriptionLanguage,
      triggerMode: appConfig.triggerMode,
      wakeWord: appConfig.wakeWord,
      wakeSilenceMs: appConfig.wakeSilenceMs,
      captureSource: appConfig.captureSource,
      microphoneDevice: appConfig.microphoneDevice,
      systemAudioDevice: appConfig.systemAudioDevice,
    },
    {
      onStdout: (line) => safeLog("[stt]", line.trim()),
      onStderr: (line) => safeError("[stt]", line.trim()),
      onFatalExit: (message) => {
        safeError("[stt]", message);
        setRendererStatus("error");
      },
    },
  );
}

function createWsClient(): SttWebSocketClient {
  return new SttWebSocketClient(appConfig.sttPort, {
    onReady: () => {
      setRendererStatus("idle");
      setRendererTranscript(
        appConfig.triggerMode === "wake-word"
          ? `Wake-word mode active. Say "${appConfig.wakeWord}" to start recording.`
          : "Hold Ctrl+Shift+Space and start speaking.",
        "neutral",
      );
    },
    onWake: ({ wake_word }) => {
      if (appConfig.triggerMode !== "wake-word") {
        return;
      }
      if (wake_word && wake_word !== appConfig.wakeWord) {
        appConfig.wakeWord = wake_word;
      }
      beginRecording("wake");
    },
    onAutoStop: ({ reason }) => {
      if (!recordingActive) {
        return;
      }
      stopRecording(reason === "silence" ? "wake-silence" : "wake-timeout");
    },
    onResult: async ({ text, meta }) => {
      recordingActive = false;
      clearWakeAutoStopTimer();
      await handleOutput(text, appConfig.outputMode);
      safeLog("[promptflux] transcription", {
        length: text.length,
        durationMs: meta?.duration_ms ?? 0,
      });
      const finalText = text.trim() ? text : "(No speech detected)";
      setRendererTranscript(finalText, "success");
      setRendererStatus("success");
      playRendererCue("transcribed");
      setTimeout(() => setRendererStatus("idle"), 1500);
      hotkeyController.resetState();
    },
    onError: ({ code, message }) => {
      recordingActive = false;
      clearWakeAutoStopTimer();
      safeError("[stt:error]", code, message);
      setRendererTranscript(`${code}: ${message}`, "error");
      setRendererStatus("error");
      playRendererCue("error");
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
}

async function ensureSocketConnected(): Promise<void> {
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
}

function registerRecordHotkey(): void {
  hotkeyController.registerHoldToTalkHotkey(appConfig.hotkey, {
    onStart: () => {
      beginRecording("hotkey");
    },
    onStop: () => {
      stopRecording("hotkey");
    },
    onError: (message) => {
      safeError("[hotkey]", message);
      setRendererStatus("error");
      setRendererTranscript(message, "error");
      playRendererCue("error");
    },
  });
}

async function queryDevices() {
  if (!listDevicesScriptPath) {
    return { microphones: [], systemAudio: [] };
  }
  return listAudioDevices(listDevicesScriptPath);
}

function sanitizeSaveRequest(payload: unknown): SettingsSaveRequest {
  const source = (payload ?? {}) as Partial<SettingsSaveRequest>;
  const hotkey = typeof source.hotkey === "string" ? source.hotkey.trim() : "";
  if (!hotkey) {
    throw new Error("Hotkey is required.");
  }

  const outputMode =
    source.outputMode === "auto-paste" ? "auto-paste" : ("clipboard-only" as const);
  const transcriptionLanguageRaw =
    typeof source.transcriptionLanguage === "string" && source.transcriptionLanguage.trim()
      ? source.transcriptionLanguage.trim().toLowerCase()
      : "auto";
  const transcriptionLanguage =
    transcriptionLanguageRaw === "auto" || /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(transcriptionLanguageRaw)
      ? transcriptionLanguageRaw
      : "auto";
  const triggerMode =
    source.triggerMode === "wake-word" ? ("wake-word" as const) : ("hold-to-talk" as const);
  const wakeWord =
    typeof source.wakeWord === "string" && source.wakeWord.trim()
      ? source.wakeWord.trim().toLowerCase()
      : appConfig.wakeWord;
  const wakeRecordMsRaw = Number(source.wakeRecordMs);
  const wakeRecordMs = Number.isFinite(wakeRecordMsRaw)
    ? Math.max(1200, Math.min(30_000, Math.round(wakeRecordMsRaw)))
    : appConfig.wakeRecordMs;
  const wakeSilenceMsRaw = Number(source.wakeSilenceMs);
  const wakeSilenceMs = Number.isFinite(wakeSilenceMsRaw)
    ? Math.max(400, Math.min(6000, Math.round(wakeSilenceMsRaw)))
    : appConfig.wakeSilenceMs;
  const asBoolean = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  const soundCueEnabled = asBoolean(source.soundCueEnabled, appConfig.soundCueEnabled);
  const soundCueOnStart = asBoolean(source.soundCueOnStart, appConfig.soundCueOnStart);
  const soundCueOnStop = asBoolean(source.soundCueOnStop, appConfig.soundCueOnStop);
  const soundCueOnTranscribed = asBoolean(
    source.soundCueOnTranscribed,
    appConfig.soundCueOnTranscribed,
  );
  const soundCueOnError = asBoolean(source.soundCueOnError, appConfig.soundCueOnError);
  const soundCueVolumeRaw = Number(source.soundCueVolume);
  const soundCueVolume = Number.isFinite(soundCueVolumeRaw)
    ? Math.max(0, Math.min(100, Math.round(soundCueVolumeRaw)))
    : appConfig.soundCueVolume;
  const captureSource =
    source.captureSource === "system-audio" ? "system-audio" : ("microphone" as const);

  const preBufferMsRaw = Number(source.preBufferMs);
  const preBufferMs = Number.isFinite(preBufferMsRaw)
    ? Math.max(0, Math.min(5000, Math.round(preBufferMsRaw)))
    : appConfig.preBufferMs;

  const sanitizeDevice = (value: unknown): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  if (triggerMode === "wake-word" && captureSource !== "microphone") {
    throw new Error("Wake-word mode requires capture source = microphone.");
  }
  if (triggerMode === "wake-word" && !wakeWord.trim()) {
    throw new Error("Wake word is required for wake-word mode.");
  }

  return {
    hotkey,
    outputMode,
    transcriptionLanguage,
    triggerMode,
    wakeWord,
    wakeSilenceMs,
    wakeRecordMs,
    soundCueEnabled,
    soundCueVolume,
    soundCueOnStart,
    soundCueOnStop,
    soundCueOnTranscribed,
    soundCueOnError,
    captureSource,
    microphoneDevice: sanitizeDevice(source.microphoneDevice),
    systemAudioDevice: sanitizeDevice(source.systemAudioDevice),
    preBufferMs,
  };
}

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle("settings:get", async (): Promise<SettingsGetResponse> => {
    const devices = await queryDevices();
    return {
      config: appConfig,
      devices,
      outputToggleHotkey: OUTPUT_TOGGLE_HOTKEY,
    };
  });

  ipcMain.handle("devices:list", async () => {
    return queryDevices();
  });

  ipcMain.handle("settings:save", async (_event, payload: unknown) => {
    const previous = { ...appConfig };
    const next = sanitizeSaveRequest(payload);

    appConfig = {
      ...appConfig,
      hotkey: next.hotkey,
      outputMode: next.outputMode,
      transcriptionLanguage: next.transcriptionLanguage,
      triggerMode: next.triggerMode,
      wakeWord: next.wakeWord,
      wakeSilenceMs: next.wakeSilenceMs,
      wakeRecordMs: next.wakeRecordMs,
      soundCueEnabled: next.soundCueEnabled,
      soundCueVolume: next.soundCueVolume,
      soundCueOnStart: next.soundCueOnStart,
      soundCueOnStop: next.soundCueOnStop,
      soundCueOnTranscribed: next.soundCueOnTranscribed,
      soundCueOnError: next.soundCueOnError,
      captureSource: next.captureSource,
      microphoneDevice: next.microphoneDevice,
      systemAudioDevice: next.systemAudioDevice,
      preBufferMs: next.preBufferMs,
    };

    try {
      if (previous.hotkey !== appConfig.hotkey) {
        registerRecordHotkey();
      }
    } catch (error) {
      appConfig.hotkey = previous.hotkey;
      registerRecordHotkey();
      throw error;
    }

    const restartRequired =
      previous.triggerMode !== appConfig.triggerMode ||
      previous.wakeWord !== appConfig.wakeWord ||
      previous.wakeSilenceMs !== appConfig.wakeSilenceMs ||
      previous.transcriptionLanguage !== appConfig.transcriptionLanguage ||
      previous.captureSource !== appConfig.captureSource ||
      previous.microphoneDevice !== appConfig.microphoneDevice ||
      previous.systemAudioDevice !== appConfig.systemAudioDevice ||
      previous.preBufferMs !== appConfig.preBufferMs;

    saveConfig(appConfig);
    setRendererOutputMode(appConfig.outputMode);
    setRendererCueSettings(appConfig);
    if (restartRequired) {
      setRendererTranscript(
        "Listener settings saved. Restart PromptFlux to apply trigger/capture changes.",
        "neutral",
      );
    }

    return { config: appConfig, restartRequired };
  });
}

async function bootstrap(): Promise<void> {
  registerProcessPipeGuards();
  appConfig = loadConfig();
  safeLog("[promptflux] config loaded", {
    hotkey: appConfig.hotkey,
    outputMode: appConfig.outputMode,
    transcriptionLanguage: appConfig.transcriptionLanguage,
    triggerMode: appConfig.triggerMode,
    wakeWord: appConfig.wakeWord,
    wakeSilenceMs: appConfig.wakeSilenceMs,
    wakeRecordMs: appConfig.wakeRecordMs,
    soundCueEnabled: appConfig.soundCueEnabled,
    soundCueVolume: appConfig.soundCueVolume,
    soundCueOnStart: appConfig.soundCueOnStart,
    soundCueOnStop: appConfig.soundCueOnStop,
    soundCueOnTranscribed: appConfig.soundCueOnTranscribed,
    soundCueOnError: appConfig.soundCueOnError,
    captureSource: appConfig.captureSource,
    sttPort: appConfig.sttPort,
    preBufferMs: appConfig.preBufferMs,
  });

  const appPath = app.getAppPath();
  sttServerScriptPath = path.resolve(appPath, "../stt-service/server.py");
  listDevicesScriptPath = path.resolve(appPath, "../stt-service/list_devices.py");

  registerIpcHandlers();

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
  setRendererOutputMode(appConfig.outputMode);
  setRendererCueSettings(appConfig);

  sttWatchdog = createWatchdog();
  sttWatchdog.start();

  sttClient = createWsClient();
  setRendererStatus("connecting");
  await ensureSocketConnected();

  registerRecordHotkey();

  const toggleRegistered = globalShortcut.register(OUTPUT_TOGGLE_HOTKEY, () => {
    appConfig.outputMode = appConfig.outputMode === "clipboard-only" ? "auto-paste" : "clipboard-only";
    saveConfig(appConfig);
    setRendererOutputMode(appConfig.outputMode);
    setRendererTranscript(
      appConfig.outputMode === "auto-paste"
        ? "Auto-paste enabled. Results will be pasted into your active app."
        : "Clipboard-only mode enabled. Results will not auto-paste.",
      "neutral",
    );
  });

  if (!toggleRegistered) {
    safeError("[promptflux] failed to register output toggle hotkey", OUTPUT_TOGGLE_HOTKEY);
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
