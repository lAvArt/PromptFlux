from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ServiceConfig:
    host: str
    port: int
    sample_rate: int
    channels: int
    pre_buffer_ms: int
    model_name: str
    model_dir: Path
    compute_type: str
    transcription_language: str
    capture_source: str
    input_device: str | None
    system_audio_device: str | None


def _appdata_dir() -> Path:
    appdata = os.getenv("APPDATA")
    if appdata:
        return Path(appdata)
    return Path.home() / "AppData" / "Roaming"


def _nullable_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def load_config() -> ServiceConfig:
    default_model_dir = _appdata_dir() / "promptflux" / "models" / "small-int8"
    return ServiceConfig(
        host=os.getenv("PROMPTFLUX_STT_HOST", "127.0.0.1"),
        port=int(os.getenv("PROMPTFLUX_STT_PORT", "9876")),
        sample_rate=int(os.getenv("PROMPTFLUX_SAMPLE_RATE", "16000")),
        channels=int(os.getenv("PROMPTFLUX_CHANNELS", "1")),
        pre_buffer_ms=int(os.getenv("PROMPTFLUX_PRE_BUFFER_MS", "500")),
        model_name=os.getenv("PROMPTFLUX_MODEL_NAME", "small"),
        model_dir=Path(os.getenv("PROMPTFLUX_MODEL_DIR", str(default_model_dir))),
        compute_type=os.getenv("PROMPTFLUX_COMPUTE_TYPE", "int8"),
        transcription_language=os.getenv("PROMPTFLUX_TRANSCRIPTION_LANGUAGE", "auto"),
        capture_source=os.getenv("PROMPTFLUX_CAPTURE_SOURCE", "microphone"),
        input_device=_nullable_env("PROMPTFLUX_INPUT_DEVICE"),
        system_audio_device=_nullable_env("PROMPTFLUX_SYSTEM_AUDIO_DEVICE"),
    )
