# PromptFlux — Architecture

> System diagram and data flow for v0.1.

---

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│                     ELECTRON APP                         │
│                                                          │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐  │
│  │ Hotkey  │  │ Watchdog  │  │  Model   │  │ Config │  │
│  │ Manager │  │           │  │ Manager  │  │ Loader │  │
│  └────┬────┘  └─────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │             │              │             │        │
│       ▼             ▼              │             │        │
│  ┌─────────────────────────────────┴─────────────┘       │
│  │              Main Process                     │       │
│  │  ┌──────────────┐    ┌───────────────────┐    │       │
│  │  │  WebSocket   │    │    Clipboard +    │    │       │
│  │  │   Client     │    │   Paste Simulator │    │       │
│  │  └──────┬───────┘    └───────────────────┘    │       │
│  └─────────┼─────────────────────────────────────┘       │
│            │                                             │
│  ┌─────────┴──────────────────────┐                      │
│  │        Renderer Process        │                      │
│  │  ┌──────────────────────────┐  │                      │
│  │  │     Orb UI (6 states)   │  │                      │
│  │  └──────────────────────────┘  │                      │
│  └────────────────────────────────┘                      │
└──────────────┬───────────────────────────────────────────┘
               │
               │  WebSocket (ws://127.0.0.1:9876)
               │  Localhost only — never exposed
               │
┌──────────────▼───────────────────────────────────────────┐
│                   PYTHON STT SERVICE                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  WebSocket   │  │    Audio     │  │  Transcriber  │  │
│  │   Server     │◄─┤   Capture   │  │ (faster-      │  │
│  │              │  │              │  │  whisper)     │  │
│  │  :9876       │  │  ┌────────┐ │  │               │  │
│  │              │  │  │ Ring   │ │  │  ┌─────────┐  │  │
│  │              │  │  │ Buffer │ │  │  │ small   │  │  │
│  │              │  │  │ 500ms  │ │  │  │ int8    │  │  │
│  │              │  │  └────────┘ │  │  │ model   │  │  │
│  └──────────────┘  └──────────────┘  │  └─────────┘  │  │
│                                      └───────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Data Flow — Hold-to-Talk Cycle

```
User          Electron                    Python STT
 │               │                            │
 │  Key Down     │                            │
 ├──────────────►│                            │
 │               │──── START ────────────────►│
 │               │  Orb → Red (Recording)     │── Freeze ring buffer
 │               │                            │── Begin live capture
 │               │                            │
 │  Key Up       │                            │
 ├──────────────►│                            │
 │               │  Orb → Yellow (instant)    │
 │               │──── STOP ────────────────►│
 │               │                            │── Stop capture
 │               │                            │── Concat: pre-buffer + live
 │               │                            │── Transcribe
 │               │                            │
 │               │◄─── RESULT ───────────────│
 │               │  { text, meta }            │
 │               │                            │
 │               │── Copy to clipboard        │
 │               │── (Optional: Ctrl+V sim)   │
 │               │  Orb → Green (1.5s)        │
 │               │  Orb → Idle                │
 │               │                            │
```

---

## Startup Sequence

```
Electron starts
    │
    ▼
Load config.json
    │
    ▼
Model files exist?
    │
    ├── NO ──► Show Blue Orb ──► Download model ──► Verify SHA256
    │              │                                     │
    │              │            ┌── FAIL: Error Orb ◄────┤
    │              │            │   (allow manual drop)   │
    │              │            │                         │
    │              ▼            │                    SUCCESS
    │                           │                         │
    ├── YES ◄───────────────────┘─────────────────────────┘
    │
    ▼
Spawn stt-service.exe
    │
    ▼
Connect WebSocket → ws://127.0.0.1:9876
    │
    ▼
Wait for READY message
    │
    ▼
Register global hotkey (Ctrl+Shift+Space)
    │
    ▼
Orb → Idle (dimmed)
    │
    ▼
Ready for input
```

---

## Process Lifecycle

```
Electron (parent)
    │
    ├── spawn ──► stt-service.exe (child)
    │                 │
    │   Watchdog ◄────┤ monitors process
    │                 │
    │   On crash (exit code ≠ 0):
    │     ├── Log crash
    │     ├── Wait 500ms
    │     ├── Restart (max 3x in 30s)
    │     └── If limit exceeded → Error Orb, stop retrying
    │
    │   On quit (Electron closing):
    │     ├── Send QUIT via WebSocket
    │     ├── Wait 2s
    │     ├── taskkill (SIGTERM)
    │     ├── Wait 1s
    │     └── taskkill /F (SIGKILL)
    │
    └── Clean exit
```

---

## Network Boundary

```
┌─────────────────────────────────────────┐
│              localhost only              │
│                                         │
│   Electron ◄──── ws://127.0.0.1:9876   │
│              ────► Python STT           │
│                                         │
└─────────────────────────────────────────┘

External network access:
  - Model download (first run only, pinned URL, SHA256 verified)
  - NOTHING else. Ever.
```

---

## Orb State Machine

```
                    ┌─────────────┐
         ┌─────────│ DOWNLOADING │ (first run only)
         │         │  Blue Spin  │
         │         └──────┬──────┘
         │                │ model ready
         │                ▼
         │         ┌─────────────┐
         │    ┌───►│    IDLE     │◄──────────────┐
         │    │    │  Dim/Hidden │                │
         │    │    └──────┬──────┘                │
         │    │           │ key down              │
         │    │           ▼                       │
         │    │    ┌─────────────┐                │
         │    │    │  RECORDING  │                │
         │    │    │  Red Pulse  │                │
         │    │    └──────┬──────┘                │
         │    │           │ key up (instant)      │
         │    │           ▼                       │
         │    │    ┌──────────────┐               │
         │    │    │ TRANSCRIBING │               │
         │    │    │ Yellow Spin  │               │
         │    │    └──────┬──────┘               │
         │    │           │                       │
         │    │     ┌─────┴─────┐                │
         │    │     ▼           ▼                │
         │    │ ┌────────┐ ┌─────────┐           │
         │    │ │SUCCESS │ │  ERROR  │           │
         │    │ │Green   │ │Red Static│          │
         │    │ │Flash   │ │  3s     │           │
         │    │ └───┬────┘ └────┬────┘           │
         │    │     │           │                 │
         │    │     └─────┬─────┘                │
         │    │           │ timeout               │
         │    └───────────┘──────────────────────┘
         │
         └── On fatal error (any state) → ERROR
```

---

*Diagrams are ASCII for portability. No external rendering tools required.*
