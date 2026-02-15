# Architecture

## Overview

PromptFlux has two runtime components:

1. Electron app (`electron-app`)
- UI and settings
- Global hotkey handling
- Clipboard / optional auto-paste
- STT process watchdog

2. Python STT service (`stt-service`)
- Audio capture (mic or system-audio path)
- Rolling pre-buffer
- Whisper transcription
- WebSocket server on localhost

## Data Flow

1. User triggers recording (hotkey or wake word).
2. Electron sends `START` to local STT service.
3. STT captures audio and buffers frames.
4. Electron sends `STOP` (or STT emits auto-stop).
5. STT transcribes and returns `RESULT`.
6. Electron writes text to clipboard (and optional paste).

## IPC Contract

Transport: WebSocket on `ws://127.0.0.1:<sttPort>`

Electron to STT:
- `START`
- `STOP`
- `QUIT`

STT to Electron:
- `READY`
- `RESULT`
- `ERROR`
- `WAKE`
- `AUTO_STOP`

## Trigger Modes

- `hold-to-talk`: record while shortcut is held.
- `press-to-talk`: start on release, stop on silence/max duration.
- `wake-word`: start when wake phrase is detected.

## Reliability

- Watchdog restarts STT service on crash.
- Restart limits prevent infinite crash loops.
- Listener settings can be applied with runtime STT reload.

## Security Boundary

- STT WebSocket binds to localhost.
- Mobile relay is optional and token-protected.
- No cloud transcription API usage.
