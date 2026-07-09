"""Dependency-light stub separation engine.

Splits the input by frequency band so the whole pipeline is testable
end-to-end without an ML model:

* music     = low band (lowpass, < ~300 Hz plus the residual bass)
* dialogue  = speech band (bandpass ~300-3400 Hz)
* effects   = everything else (the residual: input - music - dialogue)

This is a placeholder. A real engine implementing the same ``Engine`` protocol
(``load`` / ``separate``) can replace it without any change to ``separate.py``
or the app. The band-split is done with a zero-phase Butterworth filter via
scipy when available, falling back to a pure-numpy FFT brick-wall filter.
"""

from __future__ import annotations

from typing import Callable, Dict

import numpy as np

ProgressCb = Callable[[str, float], None]

# Speech band edges (Hz). Dialogue is what falls between these.
LOW_CUT = 300.0
HIGH_CUT = 3400.0


def _filter_channel(x: np.ndarray, sr: int, low: float, high: float) -> np.ndarray:
    """Return the band [low, high) of a single channel. low<=0 => lowpass;
    high>=nyquist => highpass."""
    nyq = sr / 2.0
    low_n = max(low, 0.0)
    high_n = min(high, nyq)

    try:
        from scipy.signal import butter, sosfiltfilt

        sos_list = []
        if low_n > 0.0:
            sos_list.append(butter(4, low_n / nyq, btype="highpass", output="sos"))
        if high_n < nyq:
            sos_list.append(butter(4, high_n / nyq, btype="lowpass", output="sos"))
        y = x
        for sos in sos_list:
            y = sosfiltfilt(sos, y)
        return y.astype(np.float32)
    except Exception:
        # Pure-numpy FFT brick-wall fallback.
        n = x.shape[0]
        freqs = np.fft.rfftfreq(n, d=1.0 / sr)
        spec = np.fft.rfft(x)
        mask = np.ones_like(freqs, dtype=bool)
        if low_n > 0.0:
            mask &= freqs >= low_n
        if high_n < nyq:
            mask &= freqs < high_n
        spec = spec * mask
        return np.fft.irfft(spec, n=n).astype(np.float32)


class EngineStub:
    """Band-split placeholder engine."""

    def load(self, progress_cb: ProgressCb) -> None:
        # Nothing to load; report a couple of steps so the UI shows motion.
        progress_cb("loading", 20.0)
        progress_cb("loading", 100.0)

    def separate(
        self, audio: np.ndarray, sr: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        # audio: [samples, channels], float32.
        if audio.ndim == 1:
            audio = audio[:, None]
        n_samples, n_channels = audio.shape

        dialogue = np.zeros_like(audio)
        music = np.zeros_like(audio)

        total = max(n_channels, 1)
        for ch in range(n_channels):
            x = audio[:, ch]
            music[:, ch] = _filter_channel(x, sr, 0.0, LOW_CUT)
            dialogue[:, ch] = _filter_channel(x, sr, LOW_CUT, HIGH_CUT)
            progress_cb("separating", (ch + 0.6) / total * 100.0)

        # Effects = residual so the three stems sum back to the original.
        effects = (audio - music - dialogue).astype(np.float32)
        progress_cb("separating", 100.0)

        return {
            "dialogue": dialogue.astype(np.float32),
            "music": music.astype(np.float32),
            "effects": effects.astype(np.float32),
        }
