# PromptFlux — v0.1 Implementation Plan

> Brutally simple local AI voice bridge.
> Local-only. Low latency. Privacy-first.

**Version:** 0.1
**License:** Apache 2.0
**Date:** 2026-02-15
**Status:** Locked

---

## 1. Overview

PromptFlux is a hold-to-talk voice-to-text tool that runs entirely on the user's machine. Press a hotkey, speak, release — transcribed text lands in your clipboard (and optionally auto-pastes). No cloud. No accounts. No telemetry.

### Stack

| Layer | Tech |
|---|---|
| UI / OS Integration | Electron |
| Speech-to-Text | Python — `faster-whisper` (CTranslate2 backend) |
| IPC | WebSocket (localhost) |
| Audio Capture | Python — `sounddevice` (PortAudio) |
| Packaging (Windows) | Electron Builder + PyInstaller (Nuitka fallback) |

---

## 2. Project Structure

```
promptflux/
├── electron-app/           # Electron — UI, hotkeys, clipboard, watchdog
│   ├── src/
│   │   ├── main/           # Main process
│   │   │   ├── index.ts            # Entry point
│   │   │   ├── websocket-client.ts # WS connection to Python
│   │   │   ├── hotkey.ts           # Global shortcut registration
│   │   │   ├── watchdog.ts         # Python process monitor
│   │   │   ├── model-manager.ts    # Model download + integrity
│   │   │   ├── config.ts           # Config loader
│   │   │   └── clipboard.ts        # Copy + optional paste simulation
│   │   └── renderer/       # Renderer process
│   │       ├── index.html          # Orb window
│   │       ├── orb.ts              # Orb state machine + animation
│   │       └── styles.css          # Orb styles
│   ├── package.json
│   ├── tsconfig.json
│   └── electron-builder.yml
├── stt-service/            # Python — STT server
│   ├── server.py                   # WebSocket server entry
│   ├── audio.py                    # Mic capture + ring buffer
│   ├── transcriber.py              # Whisper inference wrapper
│   ├── config.py                   # Config loader
│   ├── requirements.txt            # Pinned dependencies
│   └── build.spec                  # PyInstaller / Nuitka config
├── docs/
│   ├── PLAN.md                     # This file
│   ├── DECISIONS.md                # Key decisions + rationale
│   └── ARCHITECTURE.md             # System diagram + data flow
├── LICENSE                         # Apache 2.0
├── SECURITY.md                     # Privacy policy
└── README.md
```

---

## 3. Python STT Service (`stt-service/`)

### 3.1 Responsibility

Standalone local WebSocket server. Captures audio, transcribes, returns text. No knowledge of UI or clipboard.

### 3.2 Audio Capture Strategy

- The mic stream is **always open** while the service is running.
- A **ring buffer** holds the last **500ms** of audio at all times.
- On `START`: the ring buffer contents are frozen and prepended to live capture.
- On `STOP`: capture stops, frozen buffer + live audio are concatenated and sent to Whisper.

This eliminates first-syllable clipping without adding IPC complexity.

**Privacy note:** The ring buffer is overwritten continuously and never persisted. Audio only leaves the buffer when a `START` command is received.

### 3.3 WebSocket Protocol

Server listens on `ws://127.0.0.1:9876`.

#### Messages: Electron → Python

| Message | Payload | Description |
|---|---|---|
| `START` | `{}` | Begin recording (freeze pre-buffer + capture) |
| `STOP` | `{}` | Stop recording, begin transcription |
| `QUIT` | `{}` | Graceful shutdown |

#### Messages: Python → Electron

| Message | Payload | Description |
|---|---|---|
| `READY` | `{}` | Service is loaded, model warm, mic open |
| `RESULT` | `{ "text": "...", "meta": { "avg_logprob": -0.2, "duration_ms": 1340 } }` | Transcription result |
| `ERROR` | `{ "code": "...", "message": "..." }` | Error report |

#### Error Codes

| Code | Meaning |
|---|---|
| `MIC_UNAVAILABLE` | No microphone detected or permission denied |
| `MODEL_NOT_FOUND` | Whisper model file missing at expected path |
| `TRANSCRIPTION_FAILED` | Whisper inference error |
| `UNKNOWN` | Catch-all |

### 3.4 Transcriber

- Model: `faster-whisper` `small` (int8 quantized).
- Source: `Systran/faster-whisper-small` from Hugging Face.
- Loaded once at startup, kept in memory.
- VAD is **not used in v0.1** — stop boundary is entirely key-controlled.

### 3.5 Dependencies (pinned)

```
faster-whisper==1.1.0
websockets==13.1
sounddevice==0.5.1
numpy==1.26.4
```

> Exact versions to be validated against PyInstaller/Nuitka compatibility at freeze time.

---

## 4. Electron App (`electron-app/`)

### 4.1 Responsibility

Orchestrator. Manages lifecycle, UI, hotkeys, clipboard, and user config.

### 4.2 Startup Sequence

```
1. Load config from %APPDATA%/promptflux/config.json
2. Check for model file at %APPDATA%/promptflux/models/small-int8/
   ├── Model missing?
   │   ├── Show Blue Orb (Downloading)
   │   ├── Download from pinned URL
   │   ├── Verify SHA256
   │   ├── On failure → Show Error Orb + allow manual file drop
   │   └── On success → Continue
   └── Model present? → Continue
3. Spawn Python STT service (stt-service.exe or python server.py)
4. Connect WebSocket to ws://127.0.0.1:9876
5. Wait for READY message
6. Register global hotkey
7. Show Idle Orb (dimmed)
```

### 4.3 Model Download

| Property | Value |
|---|---|
| Source | Hugging Face — `Systran/faster-whisper-small` (int8) |
| Pinned URL | Stored in config, overridable |
| Integrity | SHA256 checksum verification |
| Timeout | 120s per file, 5 min total |
| Resume | HTTP Range requests for interrupted downloads |
| Fallback | User can manually place model files in the expected directory |
| Error UX | Orb switches to Error state with tray tooltip explaining the issue |

### 4.4 Hotkey

| Property | Value |
|---|---|
| Default | `Ctrl+Shift+Space` |
| Behavior | Hold-to-talk (key down = start, key up = stop) |
| Configurable | Yes, via `config.json` |

> `Alt+Space` was rejected — conflicts with Windows system window menu.

### 4.5 Hold-to-Talk Flow

```
Key Down:
  1. Send START to Python via WebSocket
  2. Set Orb → Red Pulse (Recording)

Key Up:
  3. Set Orb → Yellow Spinner (Transcribing)  ← INSTANT, before Python responds
  4. Send STOP to Python via WebSocket

On RESULT received:
  5. Write text to system clipboard
  6. If auto-paste enabled:
       Simulate Ctrl+V (Windows only, opt-in)
  7. Set Orb → Green Flash (Success, 1.5s)
  8. Set Orb → Idle (Hidden/Dimmed)

On ERROR received:
  5. Set Orb → Error state
  6. Log error
  7. Set Orb → Idle after 3s
```

**Key UX rule:** The Red→Yellow transition happens **on key release, instantly**, regardless of whether Python has acknowledged the `STOP`. This minimizes perceived latency.

### 4.6 Watchdog

- Monitors the spawned Python child process.
- If the process exits with a non-zero code:
  - Log the crash.
  - Wait 500ms.
  - Restart the process.
  - Reconnect WebSocket.
  - Max 3 consecutive restarts within 30s, then show error and stop.
- If the process exits with code 0 (clean shutdown from `QUIT`): do nothing.

### 4.7 Graceful Shutdown

When Electron app quits:

```
1. Send QUIT over WebSocket
2. Wait up to 2 seconds for process exit
3. If still alive → SIGTERM (taskkill on Windows)
4. Wait 1 second
5. If still alive → SIGKILL (taskkill /F on Windows)
6. Clean up temp files
```

### 4.8 Output Modes

| Mode | Behavior | Default |
|---|---|---|
| `clipboard-only` | Copy text to clipboard, show toast | **Yes (default)** |
| `auto-paste` | Copy to clipboard + simulate `Ctrl+V` | Opt-in |

Auto-paste limitations (documented):
- Windows only in v0.1.
- Some apps intercept paste differently (terminals, Slack, etc.).
- Clipboard can be overwritten by other apps between copy and simulated paste.

---

## 5. Orb UI States

| State | Visual | Trigger |
|---|---|---|
| **Downloading** | Blue spinner | First-run model download |
| **Idle** | Hidden / dimmed | No activity |
| **Recording** | Red pulse | Key down |
| **Transcribing** | Yellow spinner | Key up (instant) |
| **Success** | Green flash (1.5s) | Result received |
| **Error** | Red static / icon change | Error from Python or system failure |

The Orb is a small, always-on-top, frameless, click-through window. It should feel like a system indicator, not an application.

---

## 6. Configuration

File: `%APPDATA%/promptflux/config.json`

```json
{
  "hotkey": "Ctrl+Shift+Space",
  "outputMode": "clipboard-only",
  "modelPath": null,
  "modelUrl": "https://huggingface.co/Systran/faster-whisper-small/resolve/main/",
  "modelChecksum": "<sha256>",
  "sttPort": 9876,
  "preBufferMs": 500,
  "logLevel": "info"
}
```

- `modelPath`: Override for custom model location. `null` = default app data path.
- Created with defaults on first run if missing.
- Electron reads it. Python reads its own subset (port, pre-buffer, model path) from environment variables set by Electron at spawn time.

---

## 7. Packaging (Windows — v0.1)

| Component | Tool | Output |
|---|---|---|
| Electron | Electron Builder | `.exe` installer (NSIS) |
| Python STT | PyInstaller (primary) / Nuitka (fallback) | `stt-service.exe` |
| Bundled together | Electron Builder `extraResources` | Single installer containing both |

### Freeze-early rule

Python packaging (`stt-service.exe`) must be validated in **week 1** on a clean Windows VM. Known risks:
- CTranslate2 native DLLs missing from bundle.
- OpenMP runtime (`vcomp140.dll` / `libgomp`) not included.
- Antivirus false positives on PyInstaller output.

If PyInstaller fails:
1. Try `--collect-all ctranslate2` and `--collect-all faster_whisper` hooks.
2. If still broken, switch to Nuitka with `--standalone`.

---

## 8. Acceptance Criteria

| # | Criterion | Target |
|---|---|---|
| 1 | **Latency**: Key release → text in clipboard | < 1.5 seconds |
| 2 | **Resilience**: Kill `stt-service.exe` → app recovers | Auto-restart within 2s |
| 3 | **Privacy**: Zero outbound network calls post-model-download | Verified under firewall block |
| 4 | **UX**: Orb turns yellow instantly on key release | No visible delay |
| 5 | **Integrity**: Model download verifies SHA256 | Corrupted file rejected |
| 6 | **Shutdown**: Quit app → no zombie Python processes | Verified in task manager |
| 7 | **Packaging**: Single installer, works on clean Win 10/11 | Tested on fresh VM |

---

## 9. Scope Boundaries — What v0.1 Does NOT Include

| Feature | Status | Notes |
|---|---|---|
| VAD (Voice Activity Detection) | Deferred to v0.2 | Adds complexity, hold-to-talk is sufficient |
| Mac / Linux support | Deferred to v0.2 | Windows-only for v0.1 |
| Multiple model sizes | Deferred | Only `small` int8 for now |
| Language selection | Deferred | Auto-detect only |
| Streaming transcription | Deferred | Batch after STOP only |
| Settings UI | Deferred | Config file only for v0.1 |
| Auto-update | Deferred | Manual reinstall for v0.1 |
| Tray menu beyond basics | Deferred | Quit + status only |

---

## 10. Implementation Order

```
Week 1 — Foundation
  ├── Python: WebSocket server skeleton + ring buffer audio capture
  ├── Python: Whisper integration (load model, transcribe buffer)
  ├── Python: PyInstaller freeze — VALIDATE ON CLEAN VM
  └── Electron: Project scaffold + config loader

Week 2 — Integration
  ├── Electron: WebSocket client
  ├── Electron: Global hotkey (hold-to-talk)
  ├── Electron: Spawn + watchdog for Python process
  ├── Electron: Clipboard write + optional paste simulation
  └── End-to-end: Hold key → speak → release → text in clipboard

Week 3 — Polish
  ├── Electron: Orb UI (all states)
  ├── Electron: Model download + SHA256 verify + error handling
  ├── Electron: Graceful shutdown
  ├── Packaging: Electron Builder with bundled stt-service.exe
  └── Testing: Acceptance criteria verification on clean VM

Week 4 — Hardening
  ├── Edge cases: No mic, corrupt model, network failure mid-download
  ├── Logging: Structured logs for both Electron and Python
  ├── Docs: README, SECURITY.md finalized
  └── Release: v0.1.0 tagged
```

---

*This plan is final for v0.1. Changes require updating this document and noting rationale in DECISIONS.md.*
