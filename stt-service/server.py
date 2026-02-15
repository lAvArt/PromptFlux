from __future__ import annotations

import asyncio
import difflib
import json
import logging
import re
import time
from typing import Any

import websockets
from websockets.server import WebSocketServerProtocol

from audio import RingBufferAudioCapture
from config import load_config
from transcriber import Transcriber


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("promptflux.stt")


def _normalize_language(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    normalized = value.strip().lower()
    if not normalized:
        return None
    return normalized


def _parse_message(message: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(message, bytes):
        message = message.decode("utf-8", errors="ignore")

    if isinstance(message, str):
        stripped = message.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                payload = json.loads(stripped)
                if isinstance(payload, dict):
                    msg_type = str(payload.get("type", "")).upper()
                    return msg_type, payload
                return "", {}
            except json.JSONDecodeError:
                return "", {}
        return stripped.upper(), {}

    if isinstance(message, dict):
        return str(message.get("type", "")).upper(), message

    return "", {}


def _normalize_phrase(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return " ".join(cleaned.split())


def _compact_phrase(value: str) -> str:
    return re.sub(r"\s+", "", _normalize_phrase(value))


def _consonant_skeleton(value: str) -> str:
    compact = _compact_phrase(value)
    return re.sub(r"[aeiou]", "", compact)


def _wake_candidate_compacts(spoken_normalized: str, wake_token_count: int) -> set[str]:
    tokens = spoken_normalized.split()
    if not tokens:
        return set()

    candidates: set[str] = {_compact_phrase(spoken_normalized)}
    if wake_token_count <= 1:
        # Single-word wake phrases are often split ("la vart"), so join short n-grams.
        for i in range(len(tokens)):
            compact = ""
            for j in range(i, min(len(tokens), i + 3)):
                compact += tokens[j]
                candidates.add(compact)
        return candidates

    min_window = max(1, wake_token_count - 1)
    max_window = min(len(tokens), wake_token_count + 1)
    for window_size in range(min_window, max_window + 1):
        for start in range(0, len(tokens) - window_size + 1):
            candidates.add("".join(tokens[start : start + window_size]))
    return candidates


def _wake_match_score(wake_word: str, spoken_text: str) -> tuple[float, str]:
    wake_normalized = _normalize_phrase(wake_word)
    spoken_normalized = _normalize_phrase(spoken_text)
    if not wake_normalized or not spoken_normalized:
        return 0.0, ""

    wake_compact = _compact_phrase(wake_word)
    spoken_compact = _compact_phrase(spoken_text)
    if wake_normalized in spoken_normalized or wake_compact in spoken_compact:
        return 1.0, wake_compact

    wake_tokens = wake_normalized.split()
    target_len = max(1, len(wake_compact))
    wake_skeleton = _consonant_skeleton(wake_word)
    best_score = 0.0
    best_candidate = ""
    for candidate in _wake_candidate_compacts(spoken_normalized, len(wake_tokens)):
        if not candidate:
            continue
        length_ratio = len(candidate) / target_len
        if length_ratio < 0.55 or length_ratio > 1.8:
            continue
        score = difflib.SequenceMatcher(None, wake_compact, candidate).ratio()
        if wake_skeleton and wake_skeleton == _consonant_skeleton(candidate):
            score = max(score, 0.90)
        if score > best_score:
            best_score = score
            best_candidate = candidate
    return best_score, best_candidate


class PromptFluxSttService:
    def __init__(self) -> None:
        self.config = load_config()
        self.audio = RingBufferAudioCapture(
            sample_rate=self.config.sample_rate,
            channels=self.config.channels,
            pre_buffer_ms=self.config.pre_buffer_ms,
            ring_buffer_ms=max(self.config.pre_buffer_ms, self.config.wake_buffer_ms),
            capture_source=self.config.capture_source,
            input_device=self.config.input_device,
            system_audio_device=self.config.system_audio_device,
        )
        self.transcriber = Transcriber(
            model_dir=self.config.model_dir,
            model_name=self.config.model_name,
            compute_type=self.config.compute_type,
        )
        self.shutdown_event = asyncio.Event()
        self.clients: set[WebSocketServerProtocol] = set()
        self.recording_active = False
        self.transcribing_active = False
        self.last_wake_time = 0.0
        self.wake_task: asyncio.Task | None = None
        self.silence_stop_task: asyncio.Task | None = None

    async def send_message(self, ws: WebSocketServerProtocol, event: str, payload: dict) -> None:
        await ws.send(json.dumps({"type": event, **payload}))

    async def broadcast_message(self, event: str, payload: dict) -> None:
        dead_clients: list[WebSocketServerProtocol] = []
        for client in list(self.clients):
            try:
                await self.send_message(client, event, payload)
            except websockets.ConnectionClosed:
                dead_clients.append(client)
        for client in dead_clients:
            self.clients.discard(client)

    async def send_error(
        self,
        ws: WebSocketServerProtocol,
        code: str,
        message: str,
    ) -> None:
        await self.send_message(ws, "ERROR", {"code": code, "message": message})

    def _recent_rms(self, window_ms: int = 250) -> float:
        audio = self.audio.get_recent_audio(window_ms)
        if audio.size == 0:
            return 0.0
        return float((audio.astype("float32") ** 2).mean() ** 0.5)

    def _cancel_silence_monitor(self) -> None:
        if self.silence_stop_task:
            self.silence_stop_task.cancel()
            self.silence_stop_task = None

    async def _silence_stop_monitor(self) -> None:
        threshold = max(0.0008, float(self.config.wake_silence_rms_threshold))
        # Use hysteresis so small RMS fluctuations don't flip speech/silence rapidly.
        speech_threshold = max(threshold * 1.25, threshold + 0.0012)
        required_ms = max(400, int(self.config.wake_silence_ms))
        required_s = required_ms / 1000.0
        start_grace_ms = max(300, int(self.config.wake_silence_start_grace_ms))
        start_grace_s = start_grace_ms / 1000.0
        monitor_started_at = time.monotonic()
        speech_detected = False
        silence_started_at: float | None = None

        while not self.shutdown_event.is_set():
            await asyncio.sleep(0.18)
            if not self.recording_active:
                return
            if self.transcribing_active:
                return

            now = time.monotonic()
            rms = self._recent_rms(250)
            if rms >= speech_threshold:
                speech_detected = True
                silence_started_at = None
                continue

            # Give the user a short grace window after recording starts.
            if not speech_detected and now - monitor_started_at < start_grace_s:
                continue

            # Don't force-stop before speech has been detected; max-duration timer remains the safety bound.
            if not speech_detected:
                continue

            if rms <= threshold:
                if silence_started_at is None:
                    silence_started_at = now
                elif now - silence_started_at >= required_s:
                    logger.info("Silence threshold reached; requesting auto stop")
                    await self.broadcast_message("AUTO_STOP", {"reason": "silence"})
                    return
            else:
                silence_started_at = None

    async def wake_word_loop(self) -> None:
        if self.config.trigger_mode != "wake-word":
            return
        if not self.config.wake_word:
            logger.warning("Wake-word mode enabled but wake word is empty; wake detection disabled.")
            return
        if self.config.capture_source != "microphone":
            logger.warning("Wake-word mode requires microphone capture source.")
            return

        wake_word = self.config.wake_word.strip().lower()
        wake_word_normalized = _normalize_phrase(wake_word)
        wake_word_compact = _compact_phrase(wake_word)
        if not wake_word_normalized:
            logger.warning("Wake word normalized to empty value; wake detection disabled.")
            return
        wake_match_threshold = min(0.99, max(0.55, float(self.config.wake_match_threshold)))
        # Very short wake words are prone to false positives, so require stronger similarity.
        if len(wake_word_compact) <= 4:
            wake_match_threshold = max(wake_match_threshold, 0.90)
        elif len(wake_word_compact) <= 6:
            wake_match_threshold = max(wake_match_threshold, 0.84)
        poll_s = max(0.25, self.config.wake_poll_ms / 1000.0)
        cooldown_s = max(0.5, self.config.wake_cooldown_ms / 1000.0)
        wake_prompt = f"Wake word: {wake_word}."
        logger.info(
            "Wake-word listener enabled for '%s' (threshold=%.2f)",
            wake_word,
            wake_match_threshold,
        )

        while not self.shutdown_event.is_set():
            await asyncio.sleep(poll_s)
            if not self.clients:
                continue
            if self.recording_active or self.transcribing_active:
                continue

            now = time.monotonic()
            if now - self.last_wake_time < cooldown_s:
                continue

            audio = self.audio.get_recent_audio(self.config.wake_buffer_ms)
            if audio.size < int(self.config.sample_rate * 0.6):
                continue

            try:
                text, _meta = await asyncio.to_thread(
                    self.transcriber.transcribe,
                    audio,
                    self.config.sample_rate,
                    self.config.transcription_language,
                    initial_prompt=wake_prompt,
                )
            except Exception:
                logger.exception("Wake-word detection transcription failed")
                continue

            spoken = _normalize_phrase(text)
            if not spoken:
                continue
            match_score, match_candidate = _wake_match_score(wake_word, spoken)
            if match_score >= wake_match_threshold:
                self.last_wake_time = now
                logger.info(
                    "Wake word detected (heard='%s', candidate='%s', score=%.2f)",
                    spoken,
                    match_candidate,
                    match_score,
                )
                await self.broadcast_message(
                    "WAKE",
                    {"wake_word": wake_word, "heard": spoken},
                )

    async def handle_client(self, ws: WebSocketServerProtocol) -> None:
        logger.info("Client connected")
        self.clients.add(ws)
        await self.send_message(ws, "READY", {})
        try:
            async for raw_message in ws:
                msg_type, payload = _parse_message(raw_message)
                if msg_type == "START":
                    if self.recording_active:
                        continue
                    self.recording_active = True
                    self.transcribing_active = False
                    self.audio.begin_recording()
                    start_reason = str(payload.get("reason", "")).strip().lower()
                    if start_reason in {"wake", "tap"}:
                        self._cancel_silence_monitor()
                        self.silence_stop_task = asyncio.create_task(self._silence_stop_monitor())
                    else:
                        self._cancel_silence_monitor()
                    continue

                if msg_type == "STOP":
                    self._cancel_silence_monitor()
                    self.recording_active = False
                    self.transcribing_active = True
                    audio = self.audio.stop_recording()
                    requested_language = _normalize_language(
                        payload.get("language", self.config.transcription_language)
                    )
                    try:
                        text, meta = await asyncio.to_thread(
                            self.transcriber.transcribe,
                            audio,
                            self.config.sample_rate,
                            requested_language,
                        )
                    except Exception as exc:
                        logger.exception("Transcription failed")
                        await self.send_error(ws, "TRANSCRIPTION_FAILED", str(exc))
                        self.transcribing_active = False
                        continue

                    self.transcribing_active = False
                    await self.send_message(ws, "RESULT", {"text": text, "meta": meta})
                    continue

                if msg_type == "QUIT":
                    logger.info("Quit message received")
                    self._cancel_silence_monitor()
                    self.shutdown_event.set()
                    break

                await self.send_error(ws, "UNKNOWN", f"Unsupported message: {raw_message!r}")
        except websockets.ConnectionClosed:
            logger.info("Client disconnected")
        finally:
            self.clients.discard(ws)
            if not self.clients:
                self._cancel_silence_monitor()
                self.recording_active = False
                self.transcribing_active = False
                try:
                    self.audio.stop_recording()
                except Exception:
                    pass

    async def run(self) -> None:
        self.audio.start()
        logger.info(
            "STT service listening on ws://%s:%s",
            self.config.host,
            self.config.port,
        )

        self.wake_task = asyncio.create_task(self.wake_word_loop())
        async with websockets.serve(self.handle_client, self.config.host, self.config.port):
            await self.shutdown_event.wait()
        if self.wake_task:
            self.wake_task.cancel()
            try:
                await self.wake_task
            except asyncio.CancelledError:
                pass
        self._cancel_silence_monitor()
        self.audio.close()


async def _main() -> None:
    try:
        service = PromptFluxSttService()
    except Exception as exc:
        logger.exception("Service failed to initialize")
        raise SystemExit(f"Initialization failed: {exc}") from exc

    try:
        await service.run()
    except KeyboardInterrupt:
        logger.info("Interrupted")


if __name__ == "__main__":
    asyncio.run(_main())
