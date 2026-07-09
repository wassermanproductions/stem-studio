"""Cross-model "max" quality engine: TIGER (high/TTA) + MVSEP-CDX23, blended.

Runs both real engines and blends their per-stem outputs with fixed weights,
then applies mixture consistency so the three stems still sum to the input.

Blend weights are the weight on **TIGER** per stem (1.0 = all TIGER, 0.0 = all
MVSEP). They were chosen empirically on the synthetic eval set
(``python/eval/``) by scoring tiger-high, mvsep, and candidate blends per stem
and keeping whatever measured best. See ``MAX_BLEND_WEIGHTS`` for the measured
basis; a 1.0/0.0 weight is a legitimate outcome when one engine simply wins a
stem outright on the eval material.

On CUDA the MVSEP side runs its 3-checkpoint ensemble (fast there); on CPU /
macOS it runs a single checkpoint to keep the runtime bounded.
"""

from __future__ import annotations

import sys
from typing import Callable, Dict

import numpy as np

from . import pipeline
from .device import cuda_available
from .engine_mvsep import EngineMvsep
from .engine_tiger import EngineTiger

ProgressCb = Callable[[str, float], None]

# ---------------------------------------------------------------------------
# Empirically-chosen blend weights: the weight on TIGER per stem (MVSEP gets the
# remainder). Basis: SI-SDR on the synthetic eval set (python/eval), scoring
# tiger-high, mvsep, and candidate blends with mixture consistency applied
# exactly as shipped. Measured (mean SI-SDR dB over 3 clips, consistency-applied
# per stem + overall):
#
#   config             dialogue  music   effects  overall
#   tiger-high          +11.06  +17.23   +11.42   +13.24
#   mvsep               +13.31  +19.11    +8.74   +13.72
#   50/50 (SHIPPED)     +13.04  +18.94   +10.94   +14.31   ← best overall
#   {d0.2,m0.2,e0.5}    +13.46  +19.28    +9.68   +14.14
#   {d0.25,m0.25,e0.5}  +13.45  +19.27    +9.91   +14.21
#
# MVSEP wins dialogue and music; TIGER wins effects (its raw effects SI-SDR is
# higher, and effects also absorbs the mixture-consistency residual, so pushing
# dialogue/music toward MVSEP drags effects down). An even 50/50 blend measured
# best OVERALL (+14.31) and beats tiger-high by ~+1.07 dB while regressing no
# stem badly, so that is what ships. (This is synthetic material — see the
# README caveats; on real film mixes the balance may differ.)
MAX_BLEND_WEIGHTS: Dict[str, float] = {
    "dialogue": 0.5,
    "music": 0.5,
    "effects": 0.5,
}
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    print(f"[engine_max] {msg}", file=sys.stderr, flush=True)


class EngineMax:
    """Blend of TIGER (high) and MVSEP-CDX23. ``max`` quality tier."""

    def __init__(self, cache_dir: str | None = None) -> None:
        self.cache_dir = cache_dir
        # MVSEP ensemble only where it's cheap enough (CUDA).
        ensemble = cuda_available()
        self._tiger = EngineTiger(cache_dir=cache_dir, quality="high")
        self._mvsep = EngineMvsep(cache_dir=cache_dir, ensemble=ensemble)
        self._loaded = False

    def load(self, progress_cb: ProgressCb) -> None:
        # Split the loading bar across the two engines.
        _log("loading TIGER (high) + MVSEP-CDX23")
        self._tiger.load(lambda _s, p: progress_cb("loading", p * 0.4))
        self._mvsep.load(lambda _s, p: progress_cb("loading", 40.0 + p * 0.6))
        progress_cb("loading", 100.0)
        self._loaded = True

    def separate(
        self, audio: np.ndarray, sr: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        if not self._loaded:
            raise RuntimeError("EngineMax.load() must be called before separate()")

        # Run both engines; give each half the separating bar.
        tiger_stems = self._tiger.separate(
            audio, sr, lambda _s, p: progress_cb("separating", p * 0.5)
        )
        mvsep_stems = self._mvsep.separate(
            audio, sr, lambda _s, p: progress_cb("separating", 50.0 + p * 0.5)
        )

        blended = pipeline.blend_stems(tiger_stems, mvsep_stems, MAX_BLEND_WEIGHTS)
        blended = pipeline.enforce_mixture_consistency(audio, blended)
        progress_cb("separating", 100.0)
        return blended
