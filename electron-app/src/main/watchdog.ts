import { ChildProcess, spawn } from "node:child_process";

export interface WatchdogConfig {
  pythonScriptPath: string;
  port: number;
  preBufferMs: number;
  modelPath: string | null;
  transcriptionLanguage: string;
  triggerMode: "hold-to-talk" | "wake-word";
  wakeWord: string;
  wakeSilenceMs: number;
  captureSource: "microphone" | "system-audio";
  microphoneDevice: string | null;
  systemAudioDevice: string | null;
}

export interface WatchdogHandlers {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onFatalExit?: (message: string) => void;
}

export class SttProcessWatchdog {
  private child: ChildProcess | null = null;
  private restartTimestamps: number[] = [];
  private stopping = false;
  private readonly config: WatchdogConfig;
  private readonly handlers: WatchdogHandlers;

  constructor(config: WatchdogConfig, handlers: WatchdogHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PROMPTFLUX_STT_PORT: String(this.config.port),
      PROMPTFLUX_PRE_BUFFER_MS: String(this.config.preBufferMs),
      PROMPTFLUX_TRANSCRIPTION_LANGUAGE: this.config.transcriptionLanguage,
      PROMPTFLUX_TRIGGER_MODE: this.config.triggerMode,
      PROMPTFLUX_WAKE_WORD: this.config.wakeWord,
      PROMPTFLUX_WAKE_SILENCE_MS: String(this.config.wakeSilenceMs),
      PROMPTFLUX_CAPTURE_SOURCE: this.config.captureSource,
      PROMPTFLUX_INPUT_DEVICE: this.config.microphoneDevice ?? "",
      PROMPTFLUX_SYSTEM_AUDIO_DEVICE: this.config.systemAudioDevice ?? "",
    };

    if (this.config.modelPath) {
      env.PROMPTFLUX_MODEL_DIR = this.config.modelPath;
    }

    const child = spawn("python", [this.config.pythonScriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on("data", (data) => {
      try {
        this.handlers.onStdout?.(String(data));
      } catch {
        // Never allow logging handlers to crash the main process.
      }
    });

    child.stderr?.on("data", (data) => {
      try {
        this.handlers.onStderr?.(String(data));
      } catch {
        // Never allow logging handlers to crash the main process.
      }
    });

    child.on("exit", (code) => {
      this.child = null;
      if (this.stopping || code === 0) {
        return;
      }
      const message = this.handleCrashAndRestart();
      if (message) {
        try {
          this.handlers.onFatalExit?.(message);
        } catch {
          // Never allow logging handlers to crash the main process.
        }
      }
    });
  }

  private handleCrashAndRestart(): string | null {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts <= 30_000);
    this.restartTimestamps.push(now);

    if (this.restartTimestamps.length > 3) {
      return "STT service crashed repeatedly and restart limit was reached.";
    }

    setTimeout(() => this.spawnChild(), 500);
    return null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid) {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        }
        resolve();
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
