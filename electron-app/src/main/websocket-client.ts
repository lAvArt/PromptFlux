import WebSocket from "ws";

export interface ResultMessage {
  text: string;
  meta?: {
    avg_logprob?: number;
    duration_ms?: number;
  };
}

export interface ErrorMessage {
  code: string;
  message: string;
}

type MessageHandler = {
  onReady: () => void;
  onWake: (payload: { wake_word?: string; heard?: string }) => void;
  onAutoStop: (payload: { reason?: string }) => void;
  onResult: (message: ResultMessage) => void;
  onError: (message: ErrorMessage) => void;
  onClose: () => void;
};

function parseType(raw: WebSocket.RawData): string {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text) as { type?: string };
      return (parsed.type ?? "").toUpperCase();
    } catch {
      return "";
    }
  }
  return text.trim().toUpperCase();
}

function parseObject(raw: WebSocket.RawData): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (!(text.startsWith("{") && text.endsWith("}"))) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class SttWebSocketClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers: MessageHandler;

  constructor(port: number, handlers: MessageHandler) {
    this.url = `ws://127.0.0.1:${port}`;
    this.handlers = handlers;
  }

  async connect(maxAttempts = 30, delayMs = 200): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch {
        if (attempt === maxAttempts) {
          throw new Error(`Unable to connect STT WebSocket at ${this.url}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;
      let opened = false;

      ws.on("open", () => {
        this.ws = ws;
        opened = true;
        settled = true;
        resolve();
      });

      ws.on("message", (raw) => {
        const kind = parseType(raw);
        const payload = parseObject(raw);
        if (kind === "READY") {
          this.handlers.onReady();
          return;
        }
        if (kind === "WAKE") {
          this.handlers.onWake({
            wake_word: typeof payload.wake_word === "string" ? payload.wake_word : undefined,
            heard: typeof payload.heard === "string" ? payload.heard : undefined,
          });
          return;
        }
        if (kind === "AUTO_STOP") {
          this.handlers.onAutoStop({
            reason: typeof payload.reason === "string" ? payload.reason : undefined,
          });
          return;
        }
        if (kind === "RESULT") {
          this.handlers.onResult({
            text: String(payload.text ?? ""),
            meta: (payload.meta as ResultMessage["meta"]) ?? {},
          });
          return;
        }
        if (kind === "ERROR") {
          this.handlers.onError({
            code: String(payload.code ?? "UNKNOWN"),
            message: String(payload.message ?? "Unknown error"),
          });
        }
      });

      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("close", () => {
        if (!opened) {
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        this.handlers.onClose();
      });
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(type: "START" | "STOP" | "QUIT", payload?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!payload || Object.keys(payload).length === 0) {
      this.ws.send(type);
      return;
    }
    this.ws.send(JSON.stringify({ type, ...payload }));
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
