# PromptFlux — Decision Log

> Every non-obvious decision, with rationale. Updated as decisions are made.

---

## D-001: Audio Capture Ownership

**Decision:** Python owns the microphone.
**Alternatives considered:** Capture in Electron via Web Audio API, stream PCM over WebSocket.
**Rationale:**
Moving capture to Electron was suggested to avoid first-syllable clipping (WebSocket `START` latency). However, it introduces significant complexity:
- Web Audio API format quirks and sample rate mismatches.
- Binary PCM streaming over WebSocket adds IPC complexity.
- Cross-platform mic permission handling in Electron is painful.

Instead, a **500ms rolling ring buffer** in Python eliminates clipping with zero architecture cost. The mic stream stays open while the service runs; the buffer is overwritten continuously and never persisted.

**Status:** Final (v0.1)

---

## D-002: No VAD in v0.1

**Decision:** Voice Activity Detection is cut from v0.1.
**Rationale:**
Hold-to-talk already defines a clean stop boundary. VAD adds tuning complexity (silence thresholds, false triggers in noisy environments) that contradicts the "brutally simple" goal. Pure key-controlled start/stop is deterministic and testable.

**Status:** Final (v0.1). Revisit for v0.2.

---

## D-003: Default Hotkey — Ctrl+Shift+Space

**Decision:** `Ctrl+Shift+Space` is the default hold-to-talk key.
**Alternatives considered:** `Alt+Space`, `Win+Shift+A`.
**Rationale:**
`Alt+Space` opens the Windows system window menu (Minimize/Maximize/Close) on every application. It cannot be safely overridden without fighting the OS. `Ctrl+Shift+Space` has minimal conflicts across common applications. The hotkey is user-configurable via `config.json`.

**Status:** Final (v0.1)

---

## D-004: Clipboard-Only Default, Auto-Paste Opt-In

**Decision:** Default output mode is `clipboard-only`. Auto-paste (`Ctrl+V` simulation) is opt-in.
**Rationale:**
Simulated keystrokes are inherently fragile:
- Some apps intercept paste differently (terminals, Slack, VS Code).
- Another app can overwrite the clipboard between copy and simulated paste.
- Behaviour varies across Windows versions and accessibility settings.

Clipboard-only is deterministic and safe. Auto-paste is available for users who want it, with documented limitations.

**Status:** Final (v0.1)

---

## D-005: Model Not Bundled — Download on First Run

**Decision:** The Whisper model is downloaded on first run, not bundled in the installer.
**Rationale:**
- Keeps installer size under ~50MB (vs ~150MB+ with model).
- Avoids model redistribution licensing friction.
- Allows future model switching without re-packaging.
- Integrity verified via SHA256 checksum.
- Fallback: manual file placement if download fails.

**Status:** Final (v0.1)

---

## D-006: PyInstaller First, Nuitka Fallback

**Decision:** Package Python service with PyInstaller. Switch to Nuitka if PyInstaller fails.
**Rationale:**
PyInstaller is more widely used and documented, but `faster-whisper` + CTranslate2 + OpenMP is a known packaging risk. Nuitka handles C++-backed native libraries more reliably in some cases. The freeze must be validated in week 1 on a clean VM to catch issues early.

**Status:** Final (v0.1)

---

## D-007: Graceful Shutdown Protocol

**Decision:** Electron sends `QUIT` over WebSocket, waits 2s, then escalates to `SIGTERM` → `SIGKILL`.
**Rationale:**
Without explicit shutdown, the Python process becomes a zombie when Electron quits. Windows `taskkill` is used for `SIGTERM` equivalent; `taskkill /F` for force kill. The 2s window allows Python to close the mic stream and release file handles cleanly.

**Status:** Final (v0.1)

---

## D-008: Watchdog Restart Limits

**Decision:** Max 3 automatic restarts within a 30-second window, then stop and show error.
**Rationale:**
Unlimited restarts can mask a persistent crash (e.g., corrupted model, broken audio driver). Three attempts gives transient failures a chance to recover. After that, the user needs to see the problem.

**Status:** Final (v0.1)

---

## D-009: Always-Open Mic Stream

**Decision:** The Python service opens the mic stream at startup and keeps it open.
**Rationale:**
Required for the ring buffer strategy (D-001). Opening/closing the mic on each `START`/`STOP` adds latency (~100-300ms on some drivers) and risks permission prompts. The stream is always open but audio only leaves the overwriting ring buffer when a `START` command is received. No audio is stored or transmitted while idle.

**Status:** Final (v0.1)

---

*Add new decisions above this line.*
