# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

### Added
- Press-and-release hotkey trigger mode with silence auto-stop.
- Expanded settings hints/tooltips.
- Wake-word fuzzy matching with configurable threshold.
- Mobile relay and LAN bridge enhancements.
- System-audio compatibility fallbacks for sounddevice/PortAudio variations.
- Public-launch repository docs and community health files.

### Changed
- Settings save flow now confirms and closes panel.
- Listener-related settings are applied immediately via runtime STT reload.
- Trigger wording and UI labels for silence/max duration are generalized.

### Fixed
- Hotkey detection now supports combinations including `Space + key`.
- WASAPI loopback crash on sounddevice backends that do not support `WasapiSettings(loopback=...)`.
- Device validation for numeric IDs in audio capture path.

## [0.1.0] - 2026-02-15

### Added
- Initial PromptFlux release.
- Local Whisper transcription service.
- Electron desktop shell with global hotkeys.
- Clipboard and optional auto-paste modes.
- Windows packaging pipeline.
