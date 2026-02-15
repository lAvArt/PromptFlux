import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type OutputMode = "clipboard-only" | "auto-paste";

export interface AppConfig {
  hotkey: string;
  outputMode: OutputMode;
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

export function configPath(): string {
  return path.join(appDataDir(), "promptflux", "config.json");
}

export function loadConfig(): AppConfig {
  const targetPath = configPath();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    fs.writeFileSync(targetPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    return { ...DEFAULT_CONFIG };
  }
}
