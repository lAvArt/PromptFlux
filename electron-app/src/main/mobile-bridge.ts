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

function buildMobileIconSvg(size: number): string {
  const clamped = Number.isFinite(size) ? Math.max(128, Math.min(1024, Math.round(size))) : 512;
  const radius = Math.round(clamped * 0.22);
  const pad = Math.round(clamped * 0.1);
  const center = Math.round(clamped / 2);
  const titleY = Math.round(clamped * 0.57);
  const badgeY = Math.round(clamped * 0.72);
  const badgeH = Math.round(clamped * 0.15);
  const badgeW = Math.round(clamped * 0.58);
  const badgeX = Math.round((clamped - badgeW) / 2);
  const badgeR = Math.round(badgeH / 2);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${clamped}" height="${clamped}" viewBox="0 0 ${clamped} ${clamped}">
  <defs>
    <linearGradient id="pf-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#173056"/>
      <stop offset="100%" stop-color="#0d1625"/>
    </linearGradient>
    <linearGradient id="pf-pill" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#4ccf8f"/>
      <stop offset="100%" stop-color="#6aa9ff"/>
    </linearGradient>
  </defs>
  <rect x="${pad}" y="${pad}" width="${clamped - pad * 2}" height="${clamped - pad * 2}" rx="${radius}" fill="url(#pf-bg)"/>
  <text x="${center}" y="${titleY}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${Math.round(clamped * 0.21)}" fill="#eaf1ff">PF</text>
  <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeR}" fill="url(#pf-pill)" opacity="0.95"/>
  <text x="${center}" y="${Math.round(badgeY + badgeH * 0.67)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${Math.round(clamped * 0.075)}" fill="#0d1a2d">Mobile</text>
</svg>`;
}

function buildManifest(token: string): string {
  const cleanToken = typeof token === "string" ? token.trim() : "";
  const startUrl = cleanToken
    ? `/mobile?token=${encodeURIComponent(cleanToken)}`
    : "/mobile";
  const payload = {
    id: "/mobile",
    name: "PromptFlux Mobile Relay",
    short_name: "PromptFlux",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f1520",
    theme_color: "#152033",
    icons: [
      {
        src: "/mobile-icon.svg?size=192",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
      {
        src: "/mobile-icon.svg?size=512",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  };
  return JSON.stringify(payload);
}

function buildMobileServiceWorker(): string {
  return `const CACHE_NAME = "promptflux-mobile-v1";
const SHELL_URLS = ["/mobile"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== "GET") {
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/mobile").then((cached) => cached || Response.error())),
    );
    return;
  }

  if (url.pathname === "/manifest.webmanifest" || url.pathname === "/mobile-icon.svg") {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((response) => {
              if (response && response.ok) {
                cache.put(req, response.clone());
              }
              return response;
            })
            .catch(() => cached || Response.error());
          return cached || network;
        }),
      ),
    );
  }
});`;
}

function buildMobilePage(initialToken = ""): string {
  const cleanToken = typeof initialToken === "string" ? initialToken.trim() : "";
  const manifestHref = cleanToken
    ? `/manifest.webmanifest?token=${encodeURIComponent(cleanToken)}`
    : "/manifest.webmanifest";
  const tokenLiteral = JSON.stringify(cleanToken);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#152033" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="PromptFlux" />
    <link rel="manifest" id="manifestLink" href="${manifestHref}" />
    <link rel="icon" href="/mobile-icon.svg?size=192" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/mobile-icon.svg?size=192" />
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
      .hint.warning {
        color: #ffd589;
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
      .link-btn {
        margin-top: 10px;
        border: 1px solid #4b79b8;
        background: #1d3659;
        color: #f2f7ff;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 14px;
        text-decoration: none;
        display: inline-block;
      }
      .link-btn[aria-disabled="true"] {
        opacity: 0.6;
        pointer-events: none;
      }
      .install-box {
        margin-top: 10px;
        border: 1px solid #345078;
        border-radius: 10px;
        background: #102036;
        padding: 10px;
      }
      .install-title {
        margin: 0 0 6px;
        font-size: 13px;
        color: #d7e7ff;
      }
      .install-hint {
        margin: 0;
        color: #9eb6d9;
        font-size: 12px;
      }
      .install-box button {
        margin-top: 8px;
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
      .row.wrap {
        flex-wrap: wrap;
      }
      .row button {
        margin-top: 0;
      }
      .target-summary {
        width: 100%;
        margin-top: 8px;
        text-align: left;
        background: #13253e;
        border-color: #3f628f;
      }
      .window-picker {
        margin-top: 8px;
        border: 1px solid #2e4769;
        border-radius: 10px;
        background: #101b2c;
        padding: 10px;
      }
      .window-picker[hidden] {
        display: none;
      }
      .window-list {
        margin-top: 8px;
        display: grid;
        gap: 6px;
        max-height: 220px;
        overflow: auto;
      }
      .window-item {
        border: 1px solid #355178;
        border-radius: 8px;
        background: #13233a;
        color: #e6efff;
        padding: 8px 10px;
        text-align: left;
        font-size: 13px;
        line-height: 1.25;
      }
      .window-item.active {
        border-color: #61a1ff;
        background: #18335a;
      }
      .window-item .meta {
        display: block;
        margin-top: 2px;
        color: #99b2d6;
        font-size: 11px;
      }
      .window-empty {
        color: #9eb2d3;
        font-size: 12px;
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
      <p class="hint warning">If this page shows as Not Secure, voice dictation may be blocked.</p>
      <p class="hint">Install and trust the PromptFlux certificate, then reopen this page.</p>
      <input id="token" type="text" placeholder="Access token" />
      <a id="downloadCert" class="link-btn" href="#" aria-disabled="true">Download certificate</a>
      <div class="install-box">
        <p class="install-title">Install as app</p>
        <p id="installHint" class="install-hint">Install from your browser menu if the button is unavailable.</p>
        <button id="installApp" type="button">Install PromptFlux</button>
      </div>
      <button id="targetSummary" class="target-summary" type="button">
        Target: Active window (default)
      </button>
      <div id="windowPicker" class="window-picker" hidden>
        <div class="row">
          <input id="windowSearch" type="text" placeholder="Search windows..." />
          <button id="refresh" type="button">Refresh</button>
        </div>
        <div id="windowList" class="window-list"></div>
      </div>
      <label class="check">
        <input id="forcePaste" type="checkbox" checked />
        Force paste into selected window
      </label>
      <textarea id="text" placeholder="Type or paste text..."></textarea>
      <div class="row wrap">
        <button id="voice" type="button">Voice dictate</button>
        <button id="send" type="button">Send to desktop</button>
      </div>
      <div id="status" class="status"></div>
    </div>
    <script>
      const tokenInput = document.getElementById("token");
      const textInput = document.getElementById("text");
      const targetSummaryBtn = document.getElementById("targetSummary");
      const windowPicker = document.getElementById("windowPicker");
      const windowSearch = document.getElementById("windowSearch");
      const windowList = document.getElementById("windowList");
      const refreshBtn = document.getElementById("refresh");
      const voiceBtn = document.getElementById("voice");
      const installBtn = document.getElementById("installApp");
      const installHint = document.getElementById("installHint");
      const certLink = document.getElementById("downloadCert");
      const manifestLink = document.getElementById("manifestLink");
      const forcePasteInput = document.getElementById("forcePaste");
      const sendBtn = document.getElementById("send");
      const status = document.getElementById("status");
      const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
      let recognition = null;
      let voiceListening = false;
      let deferredInstallPrompt = null;
      let windowsCache = [];
      let selectedWindowId = null;
      let selectedWindowLabel = "Active window (default)";
      const params = new URLSearchParams(window.location.search);
      const initialToken = ${tokenLiteral};
      tokenInput.value = params.get("token") || initialToken || "";

      function refreshCertLink() {
        const token = tokenInput.value.trim();
        if (!token) {
          certLink.href = "#";
          certLink.setAttribute("aria-disabled", "true");
          return;
        }
        certLink.href = "/api/mobile/certificate?token=" + encodeURIComponent(token);
        certLink.removeAttribute("aria-disabled");
      }

      function refreshManifestLink() {
        const token = tokenInput.value.trim();
        if (!token) {
          manifestLink.setAttribute("href", "/manifest.webmanifest");
          return;
        }
        manifestLink.setAttribute(
          "href",
          "/manifest.webmanifest?token=" + encodeURIComponent(token),
        );
      }

      function isStandaloneMode() {
        if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
          return true;
        }
        return Boolean(window.navigator.standalone);
      }

      function refreshInstallUi() {
        if (isStandaloneMode()) {
          installBtn.disabled = true;
          installHint.textContent = "Installed. Launch PromptFlux from your home screen.";
          return;
        }
        if (deferredInstallPrompt) {
          installBtn.disabled = false;
          installHint.textContent = "Tap Install to add PromptFlux to your home screen.";
          return;
        }
        installBtn.disabled = false;
        installHint.textContent =
          "If Install does not pop up, use browser menu > Add to Home screen.";
      }

      async function installPwa() {
        if (isStandaloneMode()) {
          refreshInstallUi();
          return;
        }
        if (!deferredInstallPrompt) {
          status.textContent = "Use browser menu and choose Add to Home screen.";
          refreshInstallUi();
          return;
        }
        deferredInstallPrompt.prompt();
        const result = await deferredInstallPrompt.userChoice.catch(() => null);
        deferredInstallPrompt = null;
        if (result && result.outcome === "accepted") {
          status.textContent = "PromptFlux app installed.";
        }
        refreshInstallUi();
      }

      function registerServiceWorker() {
        if (!("serviceWorker" in navigator)) {
          return;
        }
        window.addEventListener("load", () => {
          navigator.serviceWorker.register("/mobile-sw.js").catch(() => {});
        });
      }

      function shortenLabel(value, max = 54) {
        const text = String(value || "").trim();
        if (text.length <= max) {
          return text;
        }
        return text.slice(0, max - 3) + "...";
      }

      function updateTargetSummary() {
        const base = selectedWindowId
          ? "Target: " + shortenLabel(selectedWindowLabel)
          : "Target: Active window (default)";
        targetSummaryBtn.textContent = base;
      }

      function normalizeSearch(value) {
        return String(value || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      }

      function windowDisplayLabel(item) {
        if (!item || !item.title) {
          return "Untitled window";
        }
        const process = item.process ? " [" + item.process + "]" : "";
        return item.title + process;
      }

      function setSelectedWindow(id, label) {
        selectedWindowId = id ? String(id) : null;
        selectedWindowLabel = label || "Active window (default)";
        updateTargetSummary();
        renderWindowList();
      }

      function renderWindowList() {
        const query = normalizeSearch(windowSearch.value);
        windowList.innerHTML = "";

        const addItem = (id, title, process) => {
          if (query) {
            const blob = normalizeSearch(title + " " + process);
            if (!blob.includes(query)) {
              return;
            }
          }
          const button = document.createElement("button");
          button.type = "button";
          button.className = "window-item";
          if ((id || null) === selectedWindowId) {
            button.classList.add("active");
          }
          button.textContent = title;
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = process || "Current active application";
          button.appendChild(meta);
          button.addEventListener("click", () => {
            setSelectedWindow(id, title);
            windowPicker.hidden = true;
            windowSearch.value = "";
          });
          windowList.appendChild(button);
        };

        addItem(null, "Active window (default)", "");
        for (const item of windowsCache) {
          addItem(String(item.id || ""), windowDisplayLabel(item), item.process || "");
        }

        if (!windowList.children.length) {
          const empty = document.createElement("div");
          empty.className = "window-empty";
          empty.textContent = "No windows match your search.";
          windowList.appendChild(empty);
        }
      }

      function setVoiceListening(next) {
        voiceListening = Boolean(next);
        voiceBtn.textContent = voiceListening ? "Stop dictation" : "Voice dictate";
        if (!SpeechRecognitionCtor) {
          voiceBtn.textContent = "Voice unavailable";
          voiceBtn.disabled = true;
        }
      }

      function initVoiceRecognition() {
        if (!SpeechRecognitionCtor) {
          setVoiceListening(false);
          return;
        }
        recognition = new SpeechRecognitionCtor();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
          const transcript = event?.results?.[0]?.[0]?.transcript || "";
          if (transcript) {
            const spacer = textInput.value.trim() ? " " : "";
            textInput.value = textInput.value + spacer + transcript.trim();
            status.textContent = "Voice text captured.";
          }
        };
        recognition.onerror = (event) => {
          const err = event && event.error ? String(event.error) : "unknown";
          if (err === "not-allowed" || err === "service-not-allowed") {
            status.textContent = "Voice input blocked. Trust the HTTPS certificate and allow microphone access.";
          } else {
            status.textContent = "Voice input error: " + err;
          }
          setVoiceListening(false);
        };
        recognition.onend = () => {
          setVoiceListening(false);
        };
      }

      function toggleVoiceRecognition() {
        if (!recognition) {
          status.textContent = "Voice input is not supported by this browser.";
          return;
        }
        if (!window.isSecureContext) {
          status.textContent = "Voice input requires a trusted HTTPS connection.";
          return;
        }
        if (voiceListening) {
          recognition.stop();
          return;
        }
        recognition.lang = navigator.language || "en-US";
        try {
          recognition.start();
          setVoiceListening(true);
          status.textContent = "Listening for voice input...";
        } catch (error) {
          status.textContent = "Voice input could not start: " + String(error);
          setVoiceListening(false);
        }
      }

      async function loadWindows() {
        const token = tokenInput.value.trim();
        if (!token) {
          windowsCache = [];
          setSelectedWindow(null, "Active window (default)");
          renderWindowList();
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
          windowsCache = windows
            .map((item) => ({
              id: String(item && item.id ? item.id : ""),
              title: String(item && item.title ? item.title : ""),
              process: String(item && item.process ? item.process : ""),
            }))
            .filter((item) => item.id && item.title);
          if (
            selectedWindowId &&
            !windowsCache.some((item) => String(item.id) === String(selectedWindowId))
          ) {
            setSelectedWindow(null, "Active window (default)");
          } else {
            renderWindowList();
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
        const targetWindowId = selectedWindowId ? String(selectedWindowId) : null;
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
      installBtn.addEventListener("click", () => {
        void installPwa();
      });
      voiceBtn.addEventListener("click", () => {
        toggleVoiceRecognition();
      });
      targetSummaryBtn.addEventListener("click", () => {
        const willOpen = windowPicker.hidden;
        windowPicker.hidden = !windowPicker.hidden;
        if (willOpen) {
          windowSearch.value = "";
          renderWindowList();
          if (tokenInput.value.trim() && !windowsCache.length) {
            void loadWindows();
          }
        }
      });
      windowSearch.addEventListener("input", () => {
        renderWindowList();
      });
      refreshBtn.addEventListener("click", () => {
        void loadWindows();
      });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          return;
        }
        if (windowPicker.hidden) {
          return;
        }
        if (windowPicker.contains(target) || targetSummaryBtn.contains(target)) {
          return;
        }
        windowPicker.hidden = true;
      });
      tokenInput.addEventListener("input", () => {
        refreshCertLink();
        refreshManifestLink();
      });
      tokenInput.addEventListener("change", () => {
        refreshCertLink();
        refreshManifestLink();
        void loadWindows();
      });
      window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        refreshInstallUi();
      });
      window.addEventListener("appinstalled", () => {
        deferredInstallPrompt = null;
        status.textContent = "PromptFlux app installed.";
        refreshInstallUi();
      });
      registerServiceWorker();
      initVoiceRecognition();
      refreshCertLink();
      refreshManifestLink();
      refreshInstallUi();
      updateTargetSummary();
      renderWindowList();
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

function sendContent(
  res: ServerResponse,
  contentType: string,
  body: string,
  cacheControl = "no-store",
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  });
  res.end(body);
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
  private certificatePem: string | null = null;

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
    this.certificatePem = certificate.cert;
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
      const tokenFromQuery = normalizeToken(parsed.searchParams.get("token"));
      const initialToken =
        tokenFromQuery && tokenFromQuery === this.config.token ? tokenFromQuery : "";
      sendHtml(res, buildMobilePage(initialToken));
      return;
    }

    if (method === "GET" && parsed.pathname === "/manifest.webmanifest") {
      const tokenFromQuery = normalizeToken(parsed.searchParams.get("token"));
      const tokenForStartUrl =
        tokenFromQuery && tokenFromQuery === this.config.token ? tokenFromQuery : "";
      sendContent(
        res,
        "application/manifest+json; charset=utf-8",
        buildManifest(tokenForStartUrl),
      );
      return;
    }

    if (method === "GET" && parsed.pathname === "/mobile-sw.js") {
      sendContent(
        res,
        "application/javascript; charset=utf-8",
        buildMobileServiceWorker(),
        "no-cache",
      );
      return;
    }

    if (method === "GET" && parsed.pathname === "/mobile-icon.svg") {
      const rawSize = Number(parsed.searchParams.get("size"));
      const size = Number.isFinite(rawSize) ? rawSize : 512;
      sendContent(
        res,
        "image/svg+xml; charset=utf-8",
        buildMobileIconSvg(size),
        "public, max-age=86400",
      );
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

    if (method === "GET" && parsed.pathname === "/api/mobile/certificate") {
      const token = normalizeToken(parsed.searchParams.get("token"));
      if (!token || token !== this.config.token) {
        sendJson(res, 401, { error: "Invalid token." });
        return;
      }
      const certPem = this.certificatePem?.trim() ?? "";
      if (!certPem) {
        sendJson(res, 503, { error: "Certificate is not ready yet." });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/x-pem-file; charset=utf-8",
        "Content-Disposition": 'attachment; filename="promptflux-mobile-bridge-cert.pem"',
        "Cache-Control": "no-store",
      });
      res.end(`${certPem}\n`);
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
