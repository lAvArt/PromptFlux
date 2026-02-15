import http, { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import { ensureMobileBridgeCertificate } from "./cert-utils";

export interface MobileBridgeConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface MobileConnectionInfo {
  enabled: boolean;
  port: number;
  token: string;
  urls: string[];
}

export interface MobileTextRequest {
  text: string;
  targetWindowId?: string | null;
  forcePaste?: boolean;
}

export interface MobileDesktopWindow {
  id: string;
  title: string;
  process: string;
}

export interface MobileBridgeHandlers {
  onText: (request: MobileTextRequest) => Promise<void>;
  onListWindows?: () => Promise<MobileDesktopWindow[]>;
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;
}

const MAX_BODY_BYTES = 64 * 1024;

function buildMobilePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PromptFlux Mobile Relay</title>
    <style>
      body {
        margin: 0;
        padding: 16px;
        background: #0f1520;
        color: #eaf1ff;
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      .card {
        max-width: 640px;
        margin: 0 auto;
        border: 1px solid #2e3f5b;
        border-radius: 12px;
        padding: 16px;
        background: #152033;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .hint {
        margin: 0 0 10px;
        color: #9eb2d3;
        font-size: 13px;
      }
      textarea, input {
        width: 100%;
        box-sizing: border-box;
        border-radius: 8px;
        border: 1px solid #3a4f72;
        background: #0f1726;
        color: #eaf1ff;
        padding: 10px;
        font-size: 14px;
      }
      textarea {
        min-height: 150px;
        resize: vertical;
      }
      select {
        width: 100%;
        box-sizing: border-box;
        border-radius: 8px;
        border: 1px solid #3a4f72;
        background: #0f1726;
        color: #eaf1ff;
        padding: 10px;
        font-size: 14px;
      }
      button {
        margin-top: 10px;
        border: 1px solid #4b79b8;
        background: #244976;
        color: #f2f7ff;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 14px;
      }
      .status {
        margin-top: 10px;
        color: #a9bcda;
        font-size: 13px;
        min-height: 18px;
      }
      .row {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .row button {
        margin-top: 0;
      }
      .check {
        margin-top: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #b8c9e1;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>PromptFlux Mobile Relay</h1>
      <p class="hint">Send text to desktop, optionally target a specific window.</p>
      <p class="hint">If browser shows a certificate warning, tap Advanced and continue.</p>
      <input id="token" type="text" placeholder="Access token" />
      <div class="row">
        <select id="window">
          <option value="">Active window (default)</option>
        </select>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <label class="check">
        <input id="forcePaste" type="checkbox" checked />
        Force paste into selected window
      </label>
      <textarea id="text" placeholder="Type or paste text..."></textarea>
      <button id="send">Send to desktop</button>
      <div id="status" class="status"></div>
    </div>
    <script>
      const tokenInput = document.getElementById("token");
      const textInput = document.getElementById("text");
      const windowSelect = document.getElementById("window");
      const refreshBtn = document.getElementById("refresh");
      const forcePasteInput = document.getElementById("forcePaste");
      const sendBtn = document.getElementById("send");
      const status = document.getElementById("status");
      const params = new URLSearchParams(window.location.search);
      tokenInput.value = params.get("token") || "";

      async function loadWindows() {
        const token = tokenInput.value.trim();
        if (!token) {
          return;
        }
        refreshBtn.disabled = true;
        try {
          const response = await fetch("/api/mobile/windows?token=" + encodeURIComponent(token));
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            status.textContent = payload.error || "Could not load windows.";
            return;
          }
          const windows = Array.isArray(payload.windows) ? payload.windows : [];
          windowSelect.innerHTML = "";
          const first = document.createElement("option");
          first.value = "";
          first.textContent = "Active window (default)";
          windowSelect.appendChild(first);
          for (const item of windows) {
            if (!item || !item.id || !item.title) continue;
            const opt = document.createElement("option");
            opt.value = String(item.id);
            opt.textContent = String(item.title) + " [" + String(item.process || "app") + "]";
            windowSelect.appendChild(opt);
          }
        } catch (error) {
          status.textContent = String(error);
        } finally {
          refreshBtn.disabled = false;
        }
      }

      async function sendText() {
        const token = tokenInput.value.trim();
        const text = textInput.value.trim();
        const targetWindowId = windowSelect.value ? String(windowSelect.value) : null;
        if (!token) {
          status.textContent = "Token required.";
          return;
        }
        if (!text) {
          status.textContent = "Text is empty.";
          return;
        }
        sendBtn.disabled = true;
        status.textContent = "Sending...";
        try {
          const response = await fetch("/api/mobile/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token,
              text,
              targetWindowId,
              forcePaste: Boolean(forcePasteInput.checked),
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            status.textContent = payload.error || "Send failed";
            return;
          }
          status.textContent = "Delivered.";
        } catch (error) {
          status.textContent = String(error);
        } finally {
          sendBtn.disabled = false;
        }
      }

      sendBtn.addEventListener("click", () => {
        void sendText();
      });
      refreshBtn.addEventListener("click", () => {
        void loadWindows();
      });
      tokenInput.addEventListener("change", () => {
        void loadWindows();
      });
      void loadWindows();
    </script>
  </body>
</html>`;
}

function collectLanHosts(): string[] {
  const output = new Set<string>();
  output.add("127.0.0.1");
  output.add("localhost");

  const interfaces = os.networkInterfaces();
  for (const group of Object.values(interfaces)) {
    for (const entry of group ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        output.add(entry.address);
      }
    }
  }
  return Array.from(output);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export class MobileBridge {
  private readonly handlers: MobileBridgeHandlers;
  private config: MobileBridgeConfig;
  private server: https.Server | null = null;

  constructor(config: MobileBridgeConfig, handlers: MobileBridgeHandlers) {
    this.config = { ...config };
    this.handlers = handlers;
  }

  getConnectionInfo(): MobileConnectionInfo {
    const urls = collectLanHosts().map(
      (host) =>
        `https://${host}:${this.config.port}/mobile?token=${encodeURIComponent(this.config.token)}`,
    );
    return {
      enabled: this.config.enabled,
      port: this.config.port,
      token: this.config.token,
      urls,
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.server) {
      return;
    }
    const hosts = collectLanHosts();
    const certificate = ensureMobileBridgeCertificate(hosts);
    await this.listen(this.config.port, {
      key: certificate.key,
      cert: certificate.cert,
    });
    this.handlers.onInfo?.(
      `Mobile bridge listening on https://<host>:${this.config.port} (cert ${
        certificate.generated ? "generated/rotated" : "reused"
      })`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  async updateConfig(next: MobileBridgeConfig): Promise<void> {
    const previous = this.config;
    this.config = { ...next };

    if (!next.enabled) {
      await this.stop();
      return;
    }

    if (!this.server) {
      await this.start();
      return;
    }

    if (previous.port !== next.port) {
      await this.stop();
      await this.start();
    }
  }

  private async listen(port: number, options: https.ServerOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = https.createServer(options, (req, res) => {
        void this.handleRequest(req, res);
      });

      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        this.handlers.onError?.(`Mobile bridge failed to start on port ${port}: ${error.message}`);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.server = server;
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "0.0.0.0");
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.enabled) {
      sendJson(res, 403, { error: "Mobile bridge disabled." });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");

    if (method === "GET" && (parsed.pathname === "/" || parsed.pathname === "/mobile")) {
      sendHtml(res, buildMobilePage());
      return;
    }

    if (method === "GET" && parsed.pathname === "/api/mobile/windows") {
      const token = normalizeToken(parsed.searchParams.get("token"));
      if (!token || token !== this.config.token) {
        sendJson(res, 401, { error: "Invalid token." });
        return;
      }
      const windows = await this.handlers.onListWindows?.();
      sendJson(res, 200, {
        windows: Array.isArray(windows) ? windows : [],
      });
      return;
    }

    if (method === "POST" && parsed.pathname === "/api/mobile/send") {
      try {
        const body = (await readJsonBody(req)) as {
          text?: unknown;
          token?: unknown;
          targetWindowId?: unknown;
          forcePaste?: unknown;
        };
        const token = normalizeToken(body.token);
        if (!token || token !== this.config.token) {
          sendJson(res, 401, { error: "Invalid token." });
          return;
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          sendJson(res, 400, { error: "Text is required." });
          return;
        }
        if (text.length > 5000) {
          sendJson(res, 400, { error: "Text is too long (max 5000 chars)." });
          return;
        }

        const targetWindowIdRaw =
          typeof body.targetWindowId === "string" ? body.targetWindowId.trim() : "";
        const targetWindowId = /^[0-9]+$/.test(targetWindowIdRaw) ? targetWindowIdRaw : null;
        const forcePaste = body.forcePaste === true;

        await this.handlers.onText({ text, targetWindowId, forcePaste });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: message || "Invalid request body." });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  }
}
