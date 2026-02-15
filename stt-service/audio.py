from __future__ import annotations

import threading

import numpy as np
import sounddevice as sd


class RingBufferAudioCapture:
    def __init__(self, sample_rate: int, channels: int, pre_buffer_ms: int) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.pre_buffer_samples = max(1, int(sample_rate * pre_buffer_ms / 1000))

        self._ring = np.zeros((self.pre_buffer_samples, channels), dtype=np.float32)
        self._write_idx = 0
        self._filled = 0

        self._lock = threading.Lock()
        self._recording = False
        self._recording_chunks: list[np.ndarray] = []
        self._frozen_prefix = np.zeros((0, channels), dtype=np.float32)
        self._stream: sd.InputStream | None = None

    def start(self) -> None:
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="float32",
            callback=self._audio_callback,
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
        if self.channels > 1:
            merged = np.mean(merged, axis=1, keepdims=True)
        return merged.reshape(-1).astype(np.float32, copy=False)

    def _audio_callback(self, indata, frames, _time, status) -> None:
        if status:
            # Keep service running; callback status is transient on some devices.
            pass

        block = np.array(indata, copy=True, dtype=np.float32)
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
