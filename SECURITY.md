# Security and Privacy Policy

Last updated: 2026-02-15

## Core Principle

PromptFlux processes speech locally. Audio and transcription text are not sent to cloud transcription APIs.

## Data Handling

- Audio is captured locally for transcription.
- Pre-buffer and recording data are memory-resident and short-lived.
- Transcription output is sent to clipboard and optionally auto-paste.

## Network Access

- First run may download the speech model.
- Mobile relay, if enabled, exposes a local LAN endpoint protected by token.
- Core STT websocket is localhost-only (`127.0.0.1`).

## Stored Files

- Config: `%APPDATA%/promptflux/config.json`
- Models: `%APPDATA%/promptflux/models/`
- App artifacts/logs: under `%APPDATA%/promptflux/`

## Security Recommendations

- Use PromptFlux on trusted devices.
- Keep mobile relay disabled on untrusted networks.
- Rotate mobile relay token when needed.
- Review firewall prompts and allow only expected local access.

## Supported Versions

Security fixes are provided for the latest release branch.

## Reporting a Vulnerability

Please report security issues privately to the maintainer first.
Do not publish exploit details in a public issue before remediation.
