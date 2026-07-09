"""MVSEP-CDX23 (Cinematic Sound Demixing) separation engine.

Wraps ZFTurbo's HTDemucs-based DnR model behind the ``Engine`` protocol used by
``separate.py``. The three checkpoints (~54 MB each ``.th``) are published on the
project's GitHub Releases and downloaded on first use into the worker's cache
dir (same mechanism as the TIGER weights).

Source / reference (personal use — the upstream repo is unlicensed; weights are
downloaded at runtime and never committed):
https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing

Verified from that repo's ``inference.py``:

* Checkpoints load via ``demucs.states.load_model`` and run via
  ``demucs.apply.apply_model(model, audio, shifts=1, overlap=0.8)``.
* The model emits three sources; the index → stem mapping is::

      dnr_demucs[0] -> music
      dnr_demucs[1] -> effect
      dnr_demucs[2] -> dialog

* Model sample rate is 44.1 kHz; input is fed as a raw float tensor (no
  extra normalisation).

Device: CUDA when available (e.g. an NVIDIA DGX Spark), else CPU. On macOS we
default to **CPU** even when MPS is present, because HTDemucs hits known
complex-tensor MPS issues — unless the user forces ``STEMSTUDIO_DEVICE=mps``.

Modes:

* Single checkpoint (default) — one ``.th``.
* 3-checkpoint ensemble — average the three checkpoints' outputs (upstream's
  published ensemble; better SDR, ~3× the runtime). Selected by
  ``ensemble=True`` (the worker turns this on for CUDA in ``max`` quality).
"""

from __future__ import annotations

import os
import ssl
import sys
from typing import Callable, Dict, List
from urllib.request import urlopen

import numpy as np

from . import pipeline
from .device import mps_available, select_device_name

ProgressCb = Callable[[str, float], None]

MODEL_SAMPLE_RATE = 44_100

# Checkpoints published on the repo's GitHub Releases (v.1.0.0). Verified from
# the upstream inference.py download URL. The first is the single-checkpoint
# default; all three are averaged in ensemble mode.
_RELEASE_BASE = (
    "https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing/"
    "releases/download/v.1.0.0/"
)
CHECKPOINTS = (
    "97d170e1-dbb4db15.th",
    "97d170e1-a778de4a.th",
    "97d170e1-e41a5468.th",
)

# apply_model params, matching upstream inference.py.
_SHIFTS = 1
_OVERLAP = 0.8

# Source index -> our canonical stem key (verified from upstream inference.py).
_SRC_INDEX = {"music": 0, "effects": 1, "dialogue": 2}


def _log(msg: str) -> None:
    """Diagnostics go to stderr — stdout is the JSON protocol channel."""
    print(f"[engine_mvsep] {msg}", file=sys.stderr, flush=True)


def _select_device_name() -> str:
    """MVSEP device policy: honour STEMSTUDIO_DEVICE; otherwise CUDA if present,
    else CPU. Never auto-select MPS (HTDemucs has complex-tensor MPS issues) —
    the user must force it explicitly with STEMSTUDIO_DEVICE=mps."""
    override = os.environ.get("STEMSTUDIO_DEVICE", "").strip().lower()
    if override in ("cuda", "mps", "cpu"):
        # select_device_name handles cuda/cpu + unavailable fallbacks; but it
        # would auto-pick mps, which we avoid here. Only honour mps if forced.
        if override == "mps" and mps_available():
            return "mps"
        if override == "mps":
            _log("STEMSTUDIO_DEVICE=mps but MPS unavailable; using cpu")
            return "cpu"
        # cuda / cpu: reuse shared resolution (falls back cuda->auto if absent),
        # but collapse an auto 'mps' pick to 'cpu' for this engine.
        name = select_device_name()
        return "cpu" if name == "mps" else name
    # Auto: CUDA if available, else CPU (skip MPS on purpose).
    name = select_device_name()
    return "cpu" if name == "mps" else name


def _ssl_context() -> "ssl.SSLContext":
    """A verifying SSL context that uses certifi's CA bundle when present.
    Framework Python builds on macOS often ship without a system CA bundle,
    which breaks HTTPS to GitHub Releases; certifi (a transitive dep of
    huggingface_hub) provides one."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001 — fall back to the platform default
        return ssl.create_default_context()


def _allow_demucs_globals(torch) -> None:
    """Allowlist the demucs classes stored in the MVSEP checkpoints so
    torch>=2.6's ``weights_only=True`` default doesn't reject them, then also
    force ``torch.load`` to a full unpickle for the load call (the checkpoints
    are full model packages, not bare state_dicts). Idempotent.

    Only run for these user-approved MVSEP weights."""
    if getattr(torch, "_stemstudio_mvsep_allow", False):
        return
    try:
        from demucs.htdemucs import HTDemucs

        add = getattr(torch.serialization, "add_safe_globals", None)
        if add is not None:
            add([HTDemucs])
    except Exception:  # noqa: BLE001 — best effort; the patch below is the real fix
        pass

    # demucs.states.load_model calls torch.load(path, 'cpu') with the modern
    # default weights_only=True. Patch it to weights_only=False for our trusted
    # checkpoints. We wrap once and forward everything else unchanged.
    _orig_load = torch.load

    def _load(*args, **kwargs):  # noqa: ANN001, ANN002
        kwargs.setdefault("weights_only", False)
        return _orig_load(*args, **kwargs)

    torch.load = _load
    torch._stemstudio_mvsep_allow = True


def _download(url: str, dest: str, progress_cb: ProgressCb, span: tuple[float, float]) -> None:
    """Stream ``url`` to ``dest`` with progress mapped into ``span`` (lo, hi)."""
    lo, hi = span
    tmp = dest + ".part"
    _log(f"downloading {url}")
    ctx = _ssl_context()
    with urlopen(url, context=ctx) as resp:  # noqa: S310 — fixed https release URL
        total = int(resp.headers.get("Content-Length", 0) or 0)
        read = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                read += len(chunk)
                if total:
                    frac = read / total
                    progress_cb("loading", lo + (hi - lo) * frac)
    os.replace(tmp, dest)
    progress_cb("loading", hi)


class EngineMvsep:
    """MVSEP-CDX23 engine. ``ensemble`` averages all three checkpoints."""

    def __init__(self, cache_dir: str | None = None, ensemble: bool = False) -> None:
        self.cache_dir = cache_dir
        self.ensemble = bool(ensemble)
        self._models: List[object] = []
        self._device = None
        self._torch = None

    # ---- helpers ---------------------------------------------------------

    def _checkpoint_names(self) -> tuple[str, ...]:
        return CHECKPOINTS if self.ensemble else CHECKPOINTS[:1]

    def _ensure_checkpoint(self, name: str, progress_cb: ProgressCb, span) -> str:
        cache = self.cache_dir or os.path.join(
            os.path.expanduser("~"), ".cache", "stemstudio", "mvsep"
        )
        os.makedirs(cache, exist_ok=True)
        dest = os.path.join(cache, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            progress_cb("loading", span[1])
            return dest
        _download(_RELEASE_BASE + name, dest, progress_cb, span)
        return dest

    # ---- Engine protocol -------------------------------------------------

    def load(self, progress_cb: ProgressCb) -> None:
        import torch
        from demucs.states import load_model

        self._torch = torch
        self._device = torch.device(_select_device_name())
        _log(f"device = {self._device} · ensemble = {self.ensemble}")

        progress_cb("loading", 2.0)

        # demucs.states.load_model uses torch.load without weights_only, which
        # torch >= 2.6 blocks by default (it now unpickles with weights_only=
        # True and refuses non-tensor globals). The MVSEP checkpoints are full
        # HTDemucs packages, so we allowlist the demucs classes they contain.
        # These are user-approved weights (personal use), so this is safe here.
        _allow_demucs_globals(torch)

        names = self._checkpoint_names()
        self._models = []
        n = len(names)
        for i, name in enumerate(names):
            # Reserve most of the bar for downloading; loading is quick.
            lo = 2.0 + (i / n) * 90.0
            hi = 2.0 + ((i + 1) / n) * 90.0
            path = self._ensure_checkpoint(name, progress_cb, (lo, hi - 5.0))
            _log(f"loading checkpoint {name}")
            model = load_model(path)
            model.to(self._device)
            model.eval()
            self._models.append(model)
            progress_cb("loading", hi)

        progress_cb("loading", 100.0)

    def separate(
        self, audio: np.ndarray, sr: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        if not self._models:
            raise RuntimeError("EngineMvsep.load() must be called before separate()")
        if audio.ndim == 1:
            audio = audio[:, None]
        audio = audio.astype(np.float32)

        # Demucs' apply_model already splits long audio into overlapping
        # segments internally, but we drive it through the same memory-bounded
        # overlap-add chunker so progress is granular and peak memory is bounded
        # regardless of input length (important on CPU / macOS).
        stems = pipeline.chunked_overlap_add(
            audio,
            sr,
            self._run_block,
            progress_cb=lambda f: progress_cb("separating", f * 95.0),
        )

        # Nothing-lost guarantee: stems sum exactly to the input mixture.
        stems = pipeline.enforce_mixture_consistency(audio, stems)
        progress_cb("separating", 100.0)
        return stems

    # ---- internals -------------------------------------------------------

    def _run_block(self, seg: np.ndarray) -> Dict[str, np.ndarray]:
        """Separate one ``[samples, channels]`` block. demucs wants
        ``[batch, channels, time]`` and returns ``[batch, sources, channels,
        time]``. In ensemble mode we average across checkpoints."""
        torch = self._torch
        from demucs.apply import apply_model

        seg = np.ascontiguousarray(seg.astype(np.float32))
        # HTDemucs expects 2 channels; the app always feeds stereo, but guard.
        if seg.shape[1] == 1:
            seg = np.repeat(seg, 2, axis=1)
        x = torch.from_numpy(seg.T[None, :, :]).to(self._device)  # [1, ch, T]

        acc = None
        with torch.no_grad():
            for model in self._models:
                out = apply_model(
                    model, x, shifts=_SHIFTS, overlap=_OVERLAP, progress=False
                )  # [1, sources, ch, T]
                out = out[0].detach().to("cpu").float()
                acc = out if acc is None else acc + out
        if self._device.type in ("mps", "cuda"):
            try:
                getattr(torch, self._device.type).synchronize()
            except Exception:  # noqa: BLE001
                pass
        acc = acc / float(len(self._models))  # [sources, ch, T]

        def stem(key: str) -> np.ndarray:
            return acc[_SRC_INDEX[key]].numpy().T  # [ch, T] -> [T, ch]

        return {
            "dialogue": stem("dialogue"),
            "music": stem("music"),
            "effects": stem("effects"),
        }
