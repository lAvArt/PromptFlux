from __future__ import annotations

import threading

import numpy as np
import sounddevice as sd


class RingBufferAudioCapture:
    def __init__(
        self,
        sample_rate: int,
        channels: int,
        pre_buffer_ms: int,
        capture_source: str = "microphone",
        input_device: str | None = None,
        system_audio_device: str | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        # Ring buffer is always mono. Multi-channel streams are downmixed in callback.
        self.channels = 1
        self.requested_channels = max(1, channels)
        self.pre_buffer_samples = max(1, int(sample_rate * pre_buffer_ms / 1000))
        self.capture_source = capture_source
        self.input_device = input_device
        self.system_audio_device = system_audio_device

        self._ring = np.zeros((self.pre_buffer_samples, self.channels), dtype=np.float32)
        self._write_idx = 0
        self._filled = 0

        self._lock = threading.Lock()
        self._recording = False
        self._recording_chunks: list[np.ndarray] = []
        self._frozen_prefix = np.zeros((0, self.channels), dtype=np.float32)
        self._stream: sd.InputStream | None = None

    def start(self) -> None:
        if self.capture_source == "system-audio":
            self._start_system_audio_stream()
            return
        self._start_microphone_stream()

    def _start_microphone_stream(self) -> None:
        device_index = self._resolve_device_index(
            self.input_device,
            need_input=True,
            need_output=False,
        )
        self._stream = sd.InputStream(
            device=device_index,
            samplerate=self.sample_rate,
            channels=self.requested_channels,
            dtype="float32",
            callback=self._audio_callback,
        )
        self._stream.start()

    def _start_system_audio_stream(self) -> None:
        device_index = self._resolve_device_index(
            self.system_audio_device,
            need_input=False,
            need_output=True,
            prefer_wasapi=True,
        )
        if device_index is None:
            raise RuntimeError("No output device available for system-audio capture.")

        hostapi_name = self._hostapi_name_for_device(device_index)
        if "WASAPI" not in hostapi_name.upper():
            raise RuntimeError(
                "System-audio capture requires a WASAPI output device on Windows."
            )

        device_info = sd.query_devices(device_index)
        output_channels = int(device_info.get("max_output_channels", 1))
        stream_channels = max(1, min(2, output_channels))

        self._stream = sd.InputStream(
            device=device_index,
            samplerate=self.sample_rate,
            channels=stream_channels,
            dtype="float32",
            callback=self._audio_callback,
            extra_settings=sd.WasapiSettings(loopback=True),
        )
        self._stream.start()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    def begin_recording(self) -> None:
        with self._lock:
            self._frozen_prefix = self._read_ring_buffer()
            self._recording_chunks = []
            self._recording = True

    def stop_recording(self) -> np.ndarray:
        with self._lock:
            self._recording = False
            chunks = [self._frozen_prefix, *self._recording_chunks]
            self._recording_chunks = []
            self._frozen_prefix = np.zeros((0, self.channels), dtype=np.float32)

        if not chunks:
            return np.zeros(0, dtype=np.float32)

        merged = np.concatenate(chunks, axis=0)
        return merged.reshape(-1).astype(np.float32, copy=False)

    def _audio_callback(self, indata, frames, _time, status) -> None:
        if status:
            # Keep service running; callback status is transient on some devices.
            pass

        block = np.array(indata, copy=True, dtype=np.float32)
        if block.ndim == 1:
            block = block.reshape(-1, 1)
        elif block.shape[1] != 1:
            block = block.mean(axis=1, keepdims=True, dtype=np.float32)

        with self._lock:
            self._write_ring(block)
            if self._recording:
                self._recording_chunks.append(block)

    def _write_ring(self, block: np.ndarray) -> None:
        frames = block.shape[0]
        if frames >= self.pre_buffer_samples:
            self._ring[:] = block[-self.pre_buffer_samples :]
            self._write_idx = 0
            self._filled = self.pre_buffer_samples
            return

        end = self._write_idx + frames
        if end <= self.pre_buffer_samples:
            self._ring[self._write_idx : end] = block
        else:
            first = self.pre_buffer_samples - self._write_idx
            self._ring[self._write_idx :] = block[:first]
            self._ring[: end % self.pre_buffer_samples] = block[first:]

        self._write_idx = end % self.pre_buffer_samples
        self._filled = min(self.pre_buffer_samples, self._filled + frames)

    def _read_ring_buffer(self) -> np.ndarray:
        if self._filled == 0:
            return np.zeros((0, self.channels), dtype=np.float32)

        if self._filled < self.pre_buffer_samples:
            return np.array(self._ring[: self._filled], copy=True)

        if self._write_idx == 0:
            return np.array(self._ring, copy=True)

        return np.concatenate(
            (
                self._ring[self._write_idx :],
                self._ring[: self._write_idx],
            ),
            axis=0,
        ).copy()

    def _resolve_device_index(
        self,
        spec: str | None,
        need_input: bool,
        need_output: bool,
        prefer_wasapi: bool = False,
    ) -> int | None:
        parsed = self._parse_spec(spec)
        if isinstance(parsed, int):
            return parsed

        candidates: list[tuple[int, dict]] = []
        devices = sd.query_devices()
        for idx, device in enumerate(devices):
            max_input = int(device.get("max_input_channels", 0))
            max_output = int(device.get("max_output_channels", 0))
            if need_input and max_input <= 0:
                continue
            if need_output and max_output <= 0:
                continue
            candidates.append((idx, device))

        if parsed is not None:
            exact = next(
                (
                    idx
                    for idx, device in candidates
                    if str(device.get("name", "")).strip().casefold() == parsed.casefold()
                ),
                None,
            )
            if exact is not None:
                return exact

            partial = next(
                (
                    idx
                    for idx, device in candidates
                    if parsed.casefold() in str(device.get("name", "")).casefold()
                ),
                None,
            )
            if partial is not None:
                return partial

        if prefer_wasapi:
            wasapi = [
                idx
                for idx, _device in candidates
                if "WASAPI" in self._hostapi_name_for_device(idx).upper()
            ]
            if wasapi:
                return wasapi[0]

        default_input, default_output = sd.default.device
        default_index = default_input if need_input else default_output
        if isinstance(default_index, int) and default_index >= 0:
            return default_index

        if candidates:
            return candidates[0][0]
        return None

    @staticmethod
    def _parse_spec(spec: str | None) -> int | str | None:
        if spec is None:
            return None
        stripped = str(spec).strip()
        if not stripped:
            return None
        if stripped.isdigit():
            return int(stripped)
        return stripped

    @staticmethod
    def _hostapi_name_for_device(device_index: int) -> str:
        device = sd.query_devices(device_index)
        hostapi_index = int(device.get("hostapi", -1))
        hostapis = sd.query_hostapis()
        if 0 <= hostapi_index < len(hostapis):
            return str(hostapis[hostapi_index].get("name", "Unknown"))
        return "Unknown"
