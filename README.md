# PromptFlux

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)](#requirements)
[![Python](https://img.shields.io/badge/python-3.11%2B-3776AB)](stt-service/requirements.txt)
[![Node](https://img.shields.io/badge/node-20%2B-339933)](electron-app/package.json)

Local, offline voice-to-text for Windows.

Press a shortcut, speak, and get text in your clipboard or pasted into your active app.
No cloud calls for transcription, no accounts, no telemetry.

## Why PromptFlux

- Local-first speech recognition using `faster-whisper`
- Low-latency pre-buffered recording to avoid clipped first words
- Multiple trigger modes:
  - Hold-to-talk
  - Press-and-release to speak (auto-stop on silence)
  - Wake word
- Optional mobile relay over local network (HTTPS + token)
- Windows installer includes packaged STT service (no Python needed on target machine)

## Keywords

offline speech to text, local whisper app, voice typing windows, dictation desktop app, hold to talk transcription, wake word transcription, private speech recognition

## Requirements

- Windows 10/11
- Microphone
- Approx. 200MB disk (app + model)

## Installation

1. Download the latest installer from GitHub Releases.
2. Install and launch PromptFlux.
3. On first run, the Whisper model is downloaded once.

Installer output filename:
- `PromptFlux Setup 0.1.0.exe`

## Quick Start

1. Open PromptFlux.
2. Open `Settings`.
3. Choose trigger mode:
   - `Hold To Talk (Hotkey)`
   - `Press And Release (Hotkey)`
   - `Wake Word`
4. Save with `Confirm`.
5. Speak and receive text in clipboard or auto-paste mode.

## Trigger Modes

### Hold To Talk

- Press and hold hotkey to record
- Release to transcribe

### Press And Release

- Tap hotkey once to start recording
- Speak naturally
- Recording stops automatically on silence (or max duration)

### Wake Word

- Say configured wake phrase
- Recording starts automatically
- Stops on silence (or max duration)

## System Audio Capture

PromptFlux supports system audio capture through WASAPI.
Depending on your PortAudio/sounddevice backend, direct loopback on output devices may not be available.

If needed, choose a `[Input Capture]` style device (for example Stereo Mix, Voicemeeter Out, virtual cable) in settings.

## Configuration

File location:
- `%APPDATA%/promptflux/config.json`

Common settings:
- `hotkey`
- `forceEndHotkey`
- `triggerMode`
- `wakeWord`
- `wakeSilenceMs`
- `wakeRecordMs`
- `outputMode`
- `captureSource`
- `microphoneDevice`
- `systemAudioDevice`

## Architecture

Electron app (UI, hotkeys, clipboard, watchdog) communicates with a local Python STT service over localhost WebSocket.

See:
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`

## Development

### Prerequisites

- Node.js 20+
- Python 3.11+

### Setup

```bash
cd electron-app
npm install

cd ../stt-service
pip install -r requirements.txt
```

### Run (dev)

```bash
# Terminal 1
cd stt-service
python server.py

# Terminal 2
cd electron-app
npm start
```

### Build Windows Installer

```bash
cd electron-app
npm run dist:win
```

## Packaging

- Electron app: `electron-builder`
- STT service: `PyInstaller` via `stt-service/build_windows.ps1`
- Final artifacts: `electron-app/dist/`

## Security and Privacy

- Transcription runs locally
- No cloud API for speech recognition
- WebSocket bound to `127.0.0.1`

See `SECURITY.md` for full policy.

## Contributing

Please read:
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`

## License

This repository is licensed under `GNU Affero General Public License v3.0`.

- Full license text: `LICENSE`
- Commercial licensing notes: `LICENSE-COMMERCIAL.md`

## Roadmap

See `ROADMAP.md`.

## Support

- Bug reports: GitHub Issues
- Security reports: see `SECURITY.md`

## SEO / Discoverability Checklist

For best discoverability after publishing, set in GitHub repo settings:

1. Description: `Local offline voice-to-text desktop app for Windows (Whisper, hotkeys, wake word)`
2. Website: your product or release page
3. Topics:
   - `speech-to-text`
   - `voice-typing`
   - `whisper`
   - `electron`
   - `python`
   - `offline`
   - `windows`
   - `dictation`
   - `privacy`
4. Enable Discussions (optional)
5. Publish Releases with clear changelogs and screenshots
