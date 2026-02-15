from __future__ import annotations

import asyncio
import json
import logging
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
        poll_s = max(0.25, self.config.wake_poll_ms / 1000.0)
        cooldown_s = max(0.5, self.config.wake_cooldown_ms / 1000.0)
        logger.info("Wake-word listener enabled for '%s'", wake_word)

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
                )
            except Exception:
                logger.exception("Wake-word detection transcription failed")
                continue

            spoken = " ".join(text.lower().split())
            if not spoken:
                continue
            if wake_word in spoken:
                self.last_wake_time = now
                logger.info("Wake word detected")
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
                    self.recording_active = True
                    self.audio.begin_recording()
                    continue

                if msg_type == "STOP":
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
                    self.shutdown_event.set()
                    break

                await self.send_error(ws, "UNKNOWN", f"Unsupported message: {raw_message!r}")
        except websockets.ConnectionClosed:
            logger.info("Client disconnected")
        finally:
            self.clients.discard(ws)

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
