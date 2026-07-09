"""Shared torch device selection.

Every engine and the ``--probe`` command pick their device through here so the
policy is identical everywhere: prefer CUDA (e.g. an NVIDIA DGX Spark), then
Apple-silicon MPS, then CPU. The ``STEMSTUDIO_DEVICE`` env var
(``cuda`` / ``mps`` / ``cpu``) overrides the automatic choice; if the requested
device is unavailable we log and fall back to the automatic order.
"""

from __future__ import annotations

import os
import sys


def _log(msg: str) -> None:
    """Diagnostics go to stderr — stdout is the JSON protocol channel."""
    print(f"[device] {msg}", file=sys.stderr, flush=True)


def cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 — torch missing or broken
        return False


def mps_available() -> bool:
    try:
        import torch

        return bool(torch.backends.mps.is_available())
    except Exception:  # noqa: BLE001
        return False


def auto_device_name() -> str:
    """Automatic device name in preference order: cuda > mps > cpu."""
    if cuda_available():
        return "cuda"
    if mps_available():
        return "mps"
    return "cpu"


def select_device_name() -> str:
    """Resolve the device name, honouring ``STEMSTUDIO_DEVICE`` when possible."""
    override = os.environ.get("STEMSTUDIO_DEVICE", "").strip().lower()
    if override in ("cuda", "mps", "cpu"):
        if override == "cuda" and not cuda_available():
            _log("STEMSTUDIO_DEVICE=cuda but CUDA unavailable; using auto order")
            return auto_device_name()
        if override == "mps" and not mps_available():
            _log("STEMSTUDIO_DEVICE=mps but MPS unavailable; using auto order")
            return auto_device_name()
        return override
    return auto_device_name()


def select_device():
    """Return a ``torch.device`` for the resolved device name."""
    import torch

    return torch.device(select_device_name())
