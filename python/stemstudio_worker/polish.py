"""Optional dialogue-polish pass: reduce residual music/SFX bleed in voices.

This runs *after* separation, on the dialogue stem only, to clean the music and
sound-effects energy that the separator leaves bleeding into the voices. It is
opt-in (the ``--polish-dialogue`` flag / UI toggle) and defaults off.

Engine
------
Speech enhancement is done with spectral gating via ``noisereduce`` (MIT). The
non-stationary mode continuously re-estimates the non-speech spectrum, which
suits music/effects bleed (a moving "noise" floor) better than a single static
profile. It is pure NumPy/SciPy under the hood — no model download, no Rust or
native build step — so it installs cleanly into the worker venv (Python 3.13,
arm64) and runs fast on CPU.

DeepFilterNet was evaluated first (it is the nominally preferred model) but its
``deepfilterlib`` core is a Rust extension with no prebuilt wheel for this
platform and requires a Cargo toolchain to compile — not something the app's
auto-built pip venv provides — so it is not used here.

Sum-exact guarantee
-------------------
This module only *returns* a cleaned dialogue array; it never changes the
three-stem sum on its own. The caller (``pipeline.apply_dialogue_polish``)
preserves the "nothing lost" guarantee by folding the removed bleed
(``dialogue_raw - dialogue_polished``) into the effects stem, so the three
delivered stems still sum to the input mixture sample-for-sample.

API
---
``polish_dialogue(dialogue, sr, progress_cb) -> np.ndarray`` takes and returns a
``[samples, channels]`` float32 array of the *same sample length* (per-channel
processing, no resampling, so length is preserved exactly).
"""

from __future__ import annotations

from typing import Callable

import numpy as np

ProgressCb = Callable[[str, float], None]

# How much of the estimated bleed to remove (0..1). Kept below 1.0 so the pass
# cleans music/effects out of the voices without gating speech itself; the
# residual it does remove is folded into the effects stem by the caller, so
# nothing is discarded.
PROP_DECREASE = 0.9

# STFT size for the spectral gate. 1024 @ ~44.1/48 kHz (~21–23 ms) is a good
# speech-enhancement trade-off between frequency resolution and time smearing.
N_FFT = 1024


def _noop(_stage: str, _percent: float) -> None:
    pass


def polish_dialogue(
    dialogue: np.ndarray,
    sr: int,
    progress_cb: ProgressCb | None = None,
) -> np.ndarray:
    """Clean residual music/SFX bleed from the dialogue stem.

    Parameters
    ----------
    dialogue:
        ``[samples]`` or ``[samples, channels]`` float32 audio in ``[-1, 1]``.
    sr:
        Sample rate of ``dialogue``.
    progress_cb:
        Optional ``(stage, percent)`` callback; called with stage
        ``"polishing"`` as channels are processed.

    Returns
    -------
    np.ndarray
        ``[samples, channels]`` float32 of the *same sample length* as the
        input, with music/effects bleed attenuated. Length is preserved exactly
        (per-channel processing, no resampling), so the caller can fold the
        difference back into the effects stem bit-for-bit.
    """
    cb = progress_cb or _noop

    import noisereduce as nr

    x = dialogue
    if x.ndim == 1:
        x = x[:, None]
    x = np.ascontiguousarray(x.astype(np.float32))
    n, ch = x.shape

    cb("polishing", 0.0)

    out = np.empty_like(x)
    for c in range(ch):
        # Non-stationary spectral gating: re-estimate the non-speech floor over
        # time so music/effects bleed (which moves) is tracked, not just a
        # static hiss. n_jobs=1 keeps it single-process (the parallel path can
        # deadlock under some Python 3.13 builds).
        cleaned = nr.reduce_noise(
            y=x[:, c],
            sr=sr,
            stationary=False,
            prop_decrease=PROP_DECREASE,
            n_fft=N_FFT,
            n_jobs=1,
            use_tqdm=False,
        ).astype(np.float32)

        # Guard sample-exact length: spectral gating should round-trip to the
        # same length, but conform defensively so the sum-exact fold is safe.
        if cleaned.shape[0] > n:
            cleaned = cleaned[:n]
        elif cleaned.shape[0] < n:
            cleaned = np.concatenate(
                [cleaned, np.zeros(n - cleaned.shape[0], np.float32)]
            )
        out[:, c] = cleaned
        cb("polishing", (c + 1) / ch * 100.0)

    return out
