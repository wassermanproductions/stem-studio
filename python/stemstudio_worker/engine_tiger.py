"""TIGER-DnR separation engine.

Wraps the vendored TIGER-DnR model (``vendor/tiger``) behind the ``Engine``
protocol used by ``separate.py``. Weights are the Apache-2.0
``JusperLee/TIGER-DnR`` checkpoint (~17 MB), downloaded from the Hugging Face
Hub into a caller-provided cache dir on first use.

Device: MPS when available (Apple silicon), else CPU. Override with the
``STEMSTUDIO_DEVICE`` env var (``mps`` / ``cpu``). The model is kept in float32
(MPS has no float64), and one MPS-only op (``adaptive_avg_pool1d`` with
non-divisible sizes) is transparently routed to CPU via a small compat shim.

Quality modes (chosen by ``separate.py`` from ``--quality``):

* ``fast`` — a single separation pass.
* ``high`` — test-time augmentation: separate a few time-shifted copies and
  average (see ``pipeline.tta_average``).

Either way the audio is processed with a memory-bounded overlap-add chunker and
the three stems are made to sum exactly to the input (mixture consistency).
"""

from __future__ import annotations

import os
import sys
from typing import Callable, Dict

import numpy as np

from . import pipeline
from .device import select_device

ProgressCb = Callable[[str, float], None]

HF_REPO = "JusperLee/TIGER-DnR"
MODEL_SAMPLE_RATE = 44_100

# The vendored TIGERDNR runs its own internal overlap-add windowing inside every
# forward, at a fixed ``target_length`` window (see ``wav_chunk_inference``).
# Every session it feeds the sub-models is padded to exactly this length, so a
# single compiled graph at this shape serves the whole file with no recompiles.
_MODEL_SESSION_SECONDS = 12.0

# On CUDA we feed the whole file to the model in one call: the model already
# does internal overlap-add windowing, its peak memory is bounded (~2.5 GB for
# 100 s on GB10, independent of the outer block size), and a single block avoids
# both the outer crossfade seams and the redundant per-block boundary
# reprocessing. MPS/CPU keep the memory-bounded outer chunker.
_CUDA_WHOLE_FILE_BLOCK_SECONDS = 3600.0


def _log(msg: str) -> None:
    """Diagnostics go to stderr — stdout is the JSON protocol channel."""
    print(f"[engine_tiger] {msg}", file=sys.stderr, flush=True)


# TIGER-DnR is an extremely launch-bound model on CUDA: a single forward issues
# ~50k tiny per-band conv/norm/attention kernels (57 sub-bands × 3 source
# models × the model's own internal 12 s/4 s overlap-add windows). On the DGX
# Spark (GB10) that floods the driver's command-submission path — the GPU sits
# at ~95 % SM utilisation while wall time is dominated by kernel-launch overhead
# (seen as very large *system* time). `torch.compile` fuses those kernels and
# cuts the launch count dramatically. These knobs are CUDA-only; MPS/CPU keep
# the eager path (compile there is either unsupported or not worth the warmup).
_CUDA_TUNED = False


def _tune_cuda_env() -> None:
    """Set CUDA allocator / compile-cache env defaults *before* torch does any
    CUDA work. Idempotent and only touches vars the operator hasn't set.

    * ``PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`` — friendlier to the
      GB10 unified-memory allocator (harmless elsewhere).
    * Triton / Inductor caches point at a writable temp dir so ``torch.compile``
      works regardless of the deploy user's home-dir permissions.
    """
    global _CUDA_TUNED
    if _CUDA_TUNED:
        return
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    import tempfile

    cache_root = os.path.join(tempfile.gettempdir(), "stemstudio_torch_cache")
    os.environ.setdefault("TRITON_CACHE_DIR", os.path.join(cache_root, "triton"))
    os.environ.setdefault(
        "TORCHINDUCTOR_CACHE_DIR", os.path.join(cache_root, "inductor")
    )
    _CUDA_TUNED = True


def _install_mps_compat() -> None:
    """Route the one MPS-incompatible op used by TIGER (adaptive_avg_pool1d with
    non-divisible output sizes) through CPU. Idempotent."""
    import torch.nn.functional as F

    if getattr(F, "_stemstudio_aap_patched", False):
        return
    _orig = F.adaptive_avg_pool1d

    def _safe(input, output_size):  # noqa: A002 — mirror torch signature
        if input.device.type == "mps":
            osz = output_size[0] if isinstance(output_size, (list, tuple)) else output_size
            if osz and input.shape[-1] % osz != 0:
                return _orig(input.cpu(), output_size).to(input.device)
        return _orig(input, output_size)

    F.adaptive_avg_pool1d = _safe
    F._stemstudio_aap_patched = True


class EngineTiger:
    """TIGER-DnR engine. ``quality`` is 'fast' or 'high'."""

    def __init__(self, cache_dir: str | None = None, quality: str = "fast") -> None:
        self.cache_dir = cache_dir
        self.quality = quality if quality in ("fast", "high") else "fast"
        self._model = None
        self._device = None
        self._torch = None
        self._compiled = False

    # ---- Engine protocol -------------------------------------------------

    def load(self, progress_cb: ProgressCb) -> None:
        # Set CUDA allocator / compile-cache env before torch touches CUDA. The
        # device is resolved from env/availability without initialising CUDA, so
        # this stays a no-op on MPS/CPU.
        from .device import select_device_name

        if select_device_name() == "cuda":
            _tune_cuda_env()

        import torch

        self._torch = torch
        _install_mps_compat()
        self._device = select_device()
        _log(f"device = {self._device}")

        progress_cb("loading", 5.0)

        # Import the vendored model (also validates the vendor tree is intact).
        from .vendor.tiger import TIGERDNR

        progress_cb("loading", 15.0)

        # Downloads on first run (into cache_dir), then loads from cache. The
        # checkpoint is small (~17 MB) but the download can still take a moment.
        _log(f"loading {HF_REPO} (cache_dir={self.cache_dir})")
        kwargs = {}
        if self.cache_dir:
            os.makedirs(self.cache_dir, exist_ok=True)
            kwargs["cache_dir"] = self.cache_dir
        model = TIGERDNR.from_pretrained(HF_REPO, **kwargs)
        progress_cb("loading", 80.0)

        model.eval().to(self._device)

        # On CUDA, fuse the model's many tiny kernels with torch.compile. The
        # three source sub-models share one internal session shape (the model's
        # own 12 s window), so a single compile serves every forward. We warm it
        # here at that exact shape: warmup is a one-time cost paid during
        # `loading`, and compiled kernels are deterministic run-to-run once
        # warmed (bit-exact across separations of the same input).
        if self._device.type == "cuda":
            try:
                for name in ("dialog", "effect", "music"):
                    setattr(model, name, torch.compile(getattr(model, name)))
                self._compiled = True
                warm_len = int(MODEL_SAMPLE_RATE * _MODEL_SESSION_SECONDS)
                with torch.no_grad():
                    warm = torch.zeros(1, 2, warm_len, device=self._device)
                    for name in ("dialog", "effect", "music"):
                        getattr(model, name)(warm)
                torch.cuda.synchronize()
                _log("torch.compile warmup complete (cuda)")
            except Exception as exc:  # noqa: BLE001 — fall back to eager
                _log(f"torch.compile unavailable, using eager: {exc}")
                self._compiled = False
        else:
            # Warm the MPS graph so the first real block isn't penalised.
            try:
                with torch.no_grad():
                    warm = torch.zeros(1, 1, MODEL_SAMPLE_RATE, device=self._device)
                    model(warm)
                if self._device.type == "mps":
                    torch.mps.synchronize()
            except Exception as exc:  # noqa: BLE001 — warmup is best-effort
                _log(f"warmup skipped: {exc}")

        self._model = model
        progress_cb("loading", 100.0)

    def separate(
        self, audio: np.ndarray, sr: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        if self._model is None:
            raise RuntimeError("EngineTiger.load() must be called before separate()")
        if audio.ndim == 1:
            audio = audio[:, None]
        audio = audio.astype(np.float32)

        # Outer block size is device-aware. On CUDA the model runs whole-file in
        # one block (see ``_CUDA_WHOLE_FILE_BLOCK_SECONDS``): memory is bounded by
        # the model's own internal windowing, so this is faster (no redundant
        # boundary reprocessing) *and* more correct (no outer crossfade seams).
        # MPS/CPU keep the default memory-bounded block size.
        block_seconds = (
            _CUDA_WHOLE_FILE_BLOCK_SECONDS
            if self._device.type == "cuda"
            else pipeline.DEFAULT_BLOCK_SECONDS
        )

        # A single full-length separation pass (fast) or a TTA ensemble (high),
        # each built on the memory-bounded overlap-add chunker.
        if self.quality == "high":

            def one_pass(x: np.ndarray) -> Dict[str, np.ndarray]:
                return pipeline.chunked_overlap_add(
                    x, sr, self._run_block, block_seconds=block_seconds
                )

            stems = pipeline.tta_average(
                audio,
                sr,
                one_pass,
                progress_cb=lambda f: progress_cb("separating", f * 95.0),
            )
        else:
            stems = pipeline.chunked_overlap_add(
                audio,
                sr,
                self._run_block,
                block_seconds=block_seconds,
                progress_cb=lambda f: progress_cb("separating", f * 95.0),
            )

        # Nothing-lost guarantee: stems sum exactly to the input mixture.
        stems = pipeline.enforce_mixture_consistency(audio, stems)
        progress_cb("separating", 100.0)
        return stems

    # ---- internals -------------------------------------------------------

    def _run_block(self, seg: np.ndarray) -> Dict[str, np.ndarray]:
        """Separate one ``[samples, channels]`` block with the model.

        The model takes ``[1, nch, T]`` and returns ``(dialog, effect, music)``,
        each ``[nch, T]``. We transpose back to ``[T, nch]``.
        """
        torch = self._torch
        seg = np.ascontiguousarray(seg.astype(np.float32))
        x = torch.from_numpy(seg.T[None, :, :]).to(self._device)  # [1, nch, T]
        # no_grad (not inference_mode): the vendored model constructs a
        # ``requires_grad=True`` scratch tensor internally, which inference_mode
        # would reject.
        with torch.no_grad():
            dialog, effect, music = self._model(x)
        if self._device.type in ("mps", "cuda"):
            getattr(torch, self._device.type).synchronize()

        def to_np(t) -> np.ndarray:
            return t.detach().to("cpu").float().numpy().T  # [nch, T] -> [T, nch]

        return {
            "dialogue": to_np(dialog),
            "music": to_np(music),
            "effects": to_np(effect),
        }
