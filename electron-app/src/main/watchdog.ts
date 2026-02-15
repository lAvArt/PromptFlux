import { ChildProcess, spawn } from "node:child_process";

export interface WatchdogConfig {
  pythonScriptPath: string;
  port: number;
  preBufferMs: number;
  modelPath: string | null;
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
      this.handlers.onStdout?.(String(data));
    });

    child.stderr?.on("data", (data) => {
      this.handlers.onStderr?.(String(data));
    });

    child.on("exit", (code) => {
      this.child = null;
      if (this.stopping || code === 0) {
        return;
      }
      const message = this.handleCrashAndRestart();
      if (message) {
        this.handlers.onFatalExit?.(message);
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
