import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

export type OutputMode = "clipboard-only" | "auto-paste";
export type CaptureSource = "microphone" | "system-audio";
export type TranscriptionLanguage = "auto" | string;
export type TriggerMode = "hold-to-talk" | "press-to-talk" | "wake-word";

export interface AppConfig {
  hotkey: string;
  outputMode: OutputMode;
  transcriptionLanguage: TranscriptionLanguage;
  triggerMode: TriggerMode;
  wakeWord: string;
  wakeSilenceMs: number;
  wakeRecordMs: number;
  soundCueEnabled: boolean;
  soundCueVolume: number;
  soundCueOnStart: boolean;
  soundCueOnStop: boolean;
  soundCueOnTranscribed: boolean;
  soundCueOnError: boolean;
  mobileBridgeEnabled: boolean;
  mobileBridgePort: number;
  mobileBridgeToken: string;
  captureSource: CaptureSource;
  microphoneDevice: string | null;
  systemAudioDevice: string | null;
  modelPath: string | null;
  modelUrl: string;
  modelChecksum: string;
  sttPort: number;
  preBufferMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const DEFAULT_CONFIG: AppConfig = {
  hotkey: "Ctrl+Shift+Space",
  outputMode: "clipboard-only",
  transcriptionLanguage: "auto",
  triggerMode: "hold-to-talk",
  wakeWord: "hey promptflux",
  wakeSilenceMs: 1200,
  wakeRecordMs: 5000,
  soundCueEnabled: true,
  soundCueVolume: 45,
  soundCueOnStart: true,
  soundCueOnStop: true,
  soundCueOnTranscribed: true,
  soundCueOnError: true,
  mobileBridgeEnabled: false,
  mobileBridgePort: 32123,
  mobileBridgeToken: "",
  captureSource: "microphone",
  microphoneDevice: null,
  systemAudioDevice: null,
  modelPath: null,
  modelUrl: "https://huggingface.co/Systran/faster-whisper-small/resolve/main/",
  modelChecksum: "",
  sttPort: 9876,
  preBufferMs: 500,
  logLevel: "info",
};

function appDataDir(): string {
  return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
}

export function createMobileBridgeToken(): string {
  return randomBytes(16).toString("hex");
}

function sanitizeConfig(raw: Partial<AppConfig>): AppConfig {
  const merged = { ...DEFAULT_CONFIG, ...raw };
  const normalizedPort = Number(merged.mobileBridgePort);
  merged.mobileBridgePort = Number.isFinite(normalizedPort)
    ? Math.max(1024, Math.min(65535, Math.round(normalizedPort)))
    : DEFAULT_CONFIG.mobileBridgePort;
  merged.mobileBridgeEnabled = Boolean(merged.mobileBridgeEnabled);
  if (!merged.mobileBridgeToken || merged.mobileBridgeToken.trim().length < 12) {
    merged.mobileBridgeToken = createMobileBridgeToken();
  }
  return merged;
}

export function configPath(): string {
  return path.join(appDataDir(), "promptflux", "config.json");
}

export function loadConfig(): AppConfig {
  const targetPath = configPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  if (!fs.existsSync(targetPath)) {
    const initial = sanitizeConfig(DEFAULT_CONFIG);
    fs.writeFileSync(targetPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const normalized = sanitizeConfig(parsed);
    const serialized = JSON.stringify(normalized, null, 2);
    if (raw.trim() !== serialized) {
      fs.writeFileSync(targetPath, serialized, "utf8");
    }
    return normalized;
  } catch {
    const fallback = sanitizeConfig(DEFAULT_CONFIG);
    fs.writeFileSync(targetPath, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

export function saveConfig(config: AppConfig): void {
  const targetPath = configPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), "utf8");
}
