# PromptFlux

**Local AI voice-to-text. Hold a key, speak, release — text in your clipboard.**

No cloud. No accounts. No telemetry. Everything runs on your machine.

---

## How It Works

1. Hold `Ctrl+Shift+Space`
2. Speak
3. Release the key
4. Transcribed text is in your clipboard (optionally auto-pasted)

PromptFlux uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper) running locally on your CPU. Audio never leaves your machine.

## Requirements

- Windows 10/11
- ~200MB disk space (app + model)
- Microphone

## Installation

> v0.1 — Windows only. Mac/Linux coming in v0.2.

Download the installer from [Releases](#). On first run, PromptFlux will download the Whisper speech model (~150MB). After that, no internet is needed.

### Manual Model Setup

If the automatic download fails (firewall, proxy, etc.), you can manually place the model:

1. Download the `small` int8 model from [Hugging Face](https://huggingface.co/Systran/faster-whisper-small)
2. Place the files in `%APPDATA%/promptflux/models/small-int8/`
3. Restart PromptFlux

## Configuration

Config file: `%APPDATA%/promptflux/config.json`

| Setting | Default | Description |
|---|---|---|
| `hotkey` | `Ctrl+Shift+Space` | Hold-to-talk key combination |
| `outputMode` | `clipboard-only` | `clipboard-only` or `auto-paste` |
| `preBufferMs` | `500` | Pre-recording buffer (ms) to avoid clipping |
| `sttPort` | `9876` | Local WebSocket port for STT service |
| `logLevel` | `info` | Logging verbosity |

## Privacy

- All processing is local. No audio or text is sent anywhere.
- The only network request is the one-time model download on first run.
- See [SECURITY.md](SECURITY.md) for the full privacy policy.

## Architecture

Electron app (UI, hotkeys, clipboard) communicates with a local Python service (audio capture, transcription) over a localhost WebSocket.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for diagrams and data flow.

## Development

### Prerequisites

- Node.js 20+
- Python 3.11+
- A microphone

### Setup

```bash
# Electron app
cd electron-app
npm install

# Python service
cd stt-service
pip install -r requirements.txt
```

### Run (dev)

```bash
# Terminal 1 — Start Python STT service
cd stt-service
python server.py

# Terminal 2 — Start Electron
cd electron-app
npm start
```

## License

[Apache 2.0](LICENSE)

---

*PromptFlux v0.1 — Built for people who talk faster than they type.*
