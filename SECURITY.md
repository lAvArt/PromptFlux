# PromptFlux — Security & Privacy Policy

> Version 0.1 | Last updated: 2026-02-15

---

## Core Principle

**PromptFlux processes all audio locally. No audio, text, or telemetry is ever sent to any external server.**

---

## What PromptFlux Does

1. **Captures microphone audio** — Only while the hold-to-talk key is held, plus a 500ms rolling pre-buffer to avoid clipping.
2. **Transcribes audio locally** — Using a Whisper model running entirely on your CPU. No cloud API calls.
3. **Copies text to clipboard** — The transcription result is placed in your system clipboard (and optionally auto-pasted).

---

## Network Access

| When | What | Why |
|---|---|---|
| First run only | HTTPS request to Hugging Face CDN | Download the Whisper speech model (~150MB) |
| All other times | **Nothing** | Zero outbound connections |

After the model is downloaded, PromptFlux functions with no network access. You can verify this by running the app with your firewall blocking all outbound traffic.

---

## Audio Handling

- **Mic stream** is open while the Python STT service is running, to maintain the 500ms ring buffer.
- **Ring buffer** is continuously overwritten in memory. No audio is saved, logged, or transmitted while idle.
- **Captured audio** (pre-buffer + live recording) exists only in memory during transcription and is discarded immediately after.
- **No audio files** are written to disk at any point.

---

## Data Storage

| Data | Location | Contents |
|---|---|---|
| Config | `%APPDATA%/promptflux/config.json` | Hotkey, output mode, model path, port |
| Model | `%APPDATA%/promptflux/models/` | Whisper model weights (downloaded once) |
| Logs | `%APPDATA%/promptflux/logs/` | Application logs (no audio, no transcriptions) |

- **Transcribed text** is placed in the system clipboard only. It is not logged or stored by PromptFlux.
- **Logs** contain operational information (startup, errors, WebSocket events). They never contain audio data or transcription results.

---

## What PromptFlux Does NOT Do

- ❌ Send audio to any cloud service
- ❌ Send transcription results anywhere
- ❌ Collect telemetry, analytics, or usage data
- ❌ Phone home for update checks
- ❌ Write audio to disk
- ❌ Log transcription text
- ❌ Access any network resource after initial model download

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Network exfiltration | No outbound connections post-setup. Verifiable via firewall. |
| Audio persisted on disk | Audio exists only in memory, never written to files. |
| Clipboard snooping by other apps | OS-level concern, outside PromptFlux's control. Documented limitation. |
| Malicious model file | SHA256 integrity check on download. Manual placement also supported. |
| Python process compromise | Process runs unprivileged. WebSocket bound to 127.0.0.1 only (not network-accessible). |
| Local WebSocket interception | Bound to localhost. Other local apps could connect, but this is a local-trust-boundary concern, not a network one. |

---

## Responsible Disclosure

If you discover a security issue, please open a GitHub issue or contact the maintainer directly. This project is small and local-only, but we take privacy seriously.

---

*This policy applies to PromptFlux v0.1. It will be updated as the project evolves.*
