from __future__ import annotations

import time
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


class Transcriber:
    def __init__(self, model_dir: Path, model_name: str, compute_type: str) -> None:
        model_target = str(model_dir) if model_dir.exists() else model_name
        self._model = WhisperModel(model_target, compute_type=compute_type)

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None = None,
    ) -> tuple[str, dict]:
        if audio.size == 0:
            return "", {"avg_logprob": 0.0, "duration_ms": 0}

        selected_language = None
        if language:
            normalized = language.strip().lower()
            if normalized and normalized != "auto":
                selected_language = normalized

        start = time.perf_counter()
        segments, _ = self._model.transcribe(
            audio,
            beam_size=1,
            best_of=1,
            vad_filter=False,
            condition_on_previous_text=False,
            language=selected_language,
        )
        segment_list = list(segments)
        text = "".join(segment.text for segment in segment_list).strip()
        avg_logprob = (
            float(np.mean([s.avg_logprob for s in segment_list])) if segment_list else 0.0
        )

        duration_ms = int((time.perf_counter() - start) * 1000)
        return text, {"avg_logprob": avg_logprob, "duration_ms": duration_ms}
