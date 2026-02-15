from __future__ import annotations

import inspect
import threading

import numpy as np
import sounddevice as sd


class RingBufferAudioCapture:
    def __init__(
        self,
        sample_rate: int,
        channels: int,
        pre_buffer_ms: int,
        ring_buffer_ms: int | None = None,
        capture_source: str = "microphone",
        input_device: str | None = None,
        system_audio_device: str | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        # Ring buffer is always mono. Multi-channel streams are downmixed in callback.
        self.channels = 1
        self.requested_channels = max(1, channels)
        self.pre_buffer_samples = max(1, int(sample_rate * pre_buffer_ms / 1000))
        self.ring_buffer_samples = max(
            self.pre_buffer_samples,
            int(sample_rate * (ring_buffer_ms if ring_buffer_ms is not None else pre_buffer_ms) / 1000),
        )
        self.capture_source = capture_source
        self.input_device = input_device
        self.system_audio_device = system_audio_device

        self._ring = np.zeros((self.ring_buffer_samples, self.channels), dtype=np.float32)
        self._write_idx = 0
        self._filled = 0

        self._lock = threading.Lock()
        self._recording = False
        self._recording_chunks: list[np.ndarray] = []
        self._frozen_prefix = np.zeros((0, self.channels), dtype=np.float32)
        self._stream: sd.InputStream | None = None
        self._stream_sample_rate = float(sample_rate)

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
        self._stream_sample_rate = float(self.sample_rate)

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
        errors: list[str] = []

        # Newer/alternative backends may expose loopback as InputStream(loopback=True).
        input_stream_params = inspect.signature(sd.InputStream).parameters
        if "loopback" in input_stream_params:
            try:
                self._stream = sd.InputStream(
                    device=device_index,
                    samplerate=self.sample_rate,
                    channels=stream_channels,
                    dtype="float32",
                    callback=self._audio_callback,
                    loopback=True,  # type: ignore[arg-type]
                )
                self._stream.start()
                self._stream_sample_rate = float(self.sample_rate)
                return
            except Exception as exc:
                errors.append(f"InputStream(loopback=True): {exc}")

        # Some builds exposed loopback via WasapiSettings(loopback=True).
        try:
            self._stream = sd.InputStream(
                device=device_index,
                samplerate=self.sample_rate,
                channels=stream_channels,
                dtype="float32",
                callback=self._audio_callback,
                extra_settings=sd.WasapiSettings(loopback=True),  # type: ignore[call-arg]
            )
            self._stream.start()
            self._stream_sample_rate = float(self.sample_rate)
            return
        except Exception as exc:
            errors.append(f"WasapiSettings(loopback=True): {exc}")

        # Fallback for builds without explicit loopback flag support.
        try:
            self._stream = sd.InputStream(
                device=device_index,
                samplerate=self.sample_rate,
                channels=stream_channels,
                dtype="float32",
                callback=self._audio_callback,
                extra_settings=sd.WasapiSettings(exclusive=False, auto_convert=True),
            )
            self._stream.start()
            self._stream_sample_rate = float(self.sample_rate)
            return
        except Exception as exc:
            errors.append(f"WasapiSettings(auto_convert=True): {exc}")

        # Final fallback: use a WASAPI input capture device (e.g. Stereo Mix/virtual cable).
        fallback_input_index = self._resolve_system_audio_input_fallback()
        if fallback_input_index is not None:
            try:
                fallback_info = sd.query_devices(fallback_input_index)
                fallback_channels = max(1, min(2, int(fallback_info.get("max_input_channels", 1))))
                fallback_default_sr = int(round(float(fallback_info.get("default_samplerate", self.sample_rate))))
                candidate_sample_rates = [self.sample_rate]
                if fallback_default_sr > 0 and fallback_default_sr not in candidate_sample_rates:
                    candidate_sample_rates.append(fallback_default_sr)

                for candidate_sr in candidate_sample_rates:
                    try:
                        self._stream = sd.InputStream(
                            device=fallback_input_index,
                            samplerate=candidate_sr,
                            channels=fallback_channels,
                            dtype="float32",
                            callback=self._audio_callback,
                        )
                        self._stream.start()
                        self._stream_sample_rate = float(candidate_sr)
                        return
                    except Exception as exc:
                        errors.append(
                            f"Input capture fallback device {fallback_input_index} @ {candidate_sr}Hz: {exc}"
                        )
            except Exception as exc:
                errors.append(f"Input capture fallback device {fallback_input_index}: {exc}")

        joined = " | ".join(errors[-4:]) if errors else "no additional diagnostics"
        raise RuntimeError(
            "System-audio capture could not start. Your sounddevice/PortAudio build does not expose "
            "WASAPI loopback on output devices. Select a real input-capture device (Stereo Mix/virtual "
            f"cable/Voicemeeter Out) for System Audio. Details: {joined}"
        )

    def _resolve_system_audio_input_fallback(self) -> int | None:
        devices = sd.query_devices()
        parsed_spec = self._parse_spec(self.system_audio_device)

        def is_wasapi(index: int) -> bool:
            return "WASAPI" in self._hostapi_name_for_device(index).upper()

        def is_input(index: int) -> bool:
            return int(devices[index].get("max_input_channels", 0)) > 0

        def normalized_name(index: int) -> str:
            return str(devices[index].get("name", "")).strip().casefold()

        keyword_markers = (
            "stereo mix",
            "loopback",
            "what u hear",
            "monitor",
            "voicemeeter out",
            "cable output",
            "mix out",
        )

        def is_likely_system_capture(index: int) -> bool:
            name = normalized_name(index)
            return any(marker in name for marker in keyword_markers)

        # If the user selected a specific input-capture device, honor it.
        if isinstance(parsed_spec, int):
            if 0 <= parsed_spec < len(devices) and is_input(parsed_spec) and is_wasapi(parsed_spec):
                return parsed_spec
            return None

        if isinstance(parsed_spec, str) and parsed_spec:
            parsed_lower = parsed_spec.casefold()
            exact = next(
                (
                    idx
                    for idx in range(len(devices))
                    if is_input(idx) and is_wasapi(idx) and normalized_name(idx) == parsed_lower
                ),
                None,
            )
            if exact is not None:
                return exact

            partial = next(
                (
                    idx
                    for idx in range(len(devices))
                    if is_input(idx) and is_wasapi(idx) and parsed_lower in normalized_name(idx)
                ),
                None,
            )
            if partial is not None:
                return partial

        preferred = next(
            (idx for idx in range(len(devices)) if is_input(idx) and is_wasapi(idx) and is_likely_system_capture(idx)),
            None,
        )
        return preferred

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    def begin_recording(self) -> None:
        with self._lock:
            self._frozen_prefix = self._read_latest_samples(self.pre_buffer_samples)
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

    def get_recent_audio(self, max_ms: int | None = None) -> np.ndarray:
        if max_ms is None:
            sample_count = self.ring_buffer_samples
        else:
            sample_count = max(1, int(self.sample_rate * max_ms / 1000))
        with self._lock:
            block = self._read_latest_samples(sample_count)
        return block.reshape(-1).astype(np.float32, copy=False)

    def _audio_callback(self, indata, frames, _time, status) -> None:
        if status:
            # Keep service running; callback status is transient on some devices.
            pass

        block = np.array(indata, copy=True, dtype=np.float32)
        if block.ndim == 1:
            block = block.reshape(-1, 1)
        elif block.shape[1] != 1:
            block = block.mean(axis=1, keepdims=True, dtype=np.float32)
        block = self._resample_to_target_rate(block)

        with self._lock:
            self._write_ring(block)
            if self._recording:
                self._recording_chunks.append(block)

    def _resample_to_target_rate(self, block: np.ndarray) -> np.ndarray:
        src_rate = float(self._stream_sample_rate)
        dst_rate = float(self.sample_rate)
        if src_rate <= 0 or abs(src_rate - dst_rate) < 0.5:
            return block
        if block.shape[0] <= 1:
            return block

        target_frames = max(1, int(round(block.shape[0] * dst_rate / src_rate)))
        if target_frames == block.shape[0]:
            return block

        x_old = np.linspace(0.0, 1.0, num=block.shape[0], endpoint=False, dtype=np.float32)
        x_new = np.linspace(0.0, 1.0, num=target_frames, endpoint=False, dtype=np.float32)
        resampled = np.interp(x_new, x_old, block[:, 0]).astype(np.float32, copy=False)
        return resampled.reshape(-1, 1)

    def _write_ring(self, block: np.ndarray) -> None:
        frames = block.shape[0]
        if frames >= self.ring_buffer_samples:
            self._ring[:] = block[-self.ring_buffer_samples :]
            self._write_idx = 0
            self._filled = self.ring_buffer_samples
            return

        end = self._write_idx + frames
        if end <= self.ring_buffer_samples:
            self._ring[self._write_idx : end] = block
        else:
            first = self.ring_buffer_samples - self._write_idx
            self._ring[self._write_idx :] = block[:first]
            self._ring[: end % self.ring_buffer_samples] = block[first:]

        self._write_idx = end % self.ring_buffer_samples
        self._filled = min(self.ring_buffer_samples, self._filled + frames)

    def _read_ring_buffer(self) -> np.ndarray:
        if self._filled == 0:
            return np.zeros((0, self.channels), dtype=np.float32)

        if self._filled < self.ring_buffer_samples:
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

    def _read_latest_samples(self, sample_count: int) -> np.ndarray:
        if self._filled == 0:
            return np.zeros((0, self.channels), dtype=np.float32)

        ordered = self._read_ring_buffer()
        take = min(sample_count, ordered.shape[0])
        if take <= 0:
            return np.zeros((0, self.channels), dtype=np.float32)
        return np.array(ordered[-take:], copy=True)

    def _resolve_device_index(
        self,
        spec: str | None,
        need_input: bool,
        need_output: bool,
        prefer_wasapi: bool = False,
    ) -> int | None:
        parsed = self._parse_spec(spec)
        if isinstance(parsed, int):
            devices = sd.query_devices()
            if not (0 <= parsed < len(devices)):
                return None
            device = devices[parsed]
            max_input = int(device.get("max_input_channels", 0))
            max_output = int(device.get("max_output_channels", 0))
            if need_input and max_input <= 0:
                return None
            if need_output and max_output <= 0:
                return None
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
