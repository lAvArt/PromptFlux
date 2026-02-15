# Engineering Decisions

## D-001: Local-first speech pipeline

Decision: run transcription locally with faster-whisper.
Reason: privacy, predictable latency, no recurring API cost.

## D-002: Split architecture (Electron + Python)

Decision: keep desktop integration in Electron and STT pipeline in Python.
Reason: practical OS integration in Electron, mature Whisper ecosystem in Python.

## D-003: Multi-trigger design

Decision: support hold-to-talk, press-to-talk, and wake-word.
Reason: users have different interaction preferences and accessibility needs.

## D-004: Pre-buffered recording

Decision: maintain rolling pre-buffer to avoid clipped first words.
Reason: improves usability on fast trigger transitions.

## D-005: Local watchdog

Decision: Electron supervises STT process lifecycle.
Reason: keeps app resilient when Python service crashes.

## D-006: Portable system-audio fallback

Decision: support multiple WASAPI paths and fallback input-capture devices.
Reason: PortAudio/sounddevice loopback behavior varies by backend and driver.

## D-007: Copyleft + commercial strategy

Decision: adopt AGPL-3.0 for Lite edition and reserve commercial licensing for Pro.
Reason: protects open-lite codebase while preserving paid-product path.
