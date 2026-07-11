# Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
"""Engine-agnostic separation CLI.

Usage::

    python -m stemstudio_worker.separate --input <wav> --outdir <dir>

Writes ``dialogue.wav``, ``music.wav``, ``effects.wav`` into ``outdir`` and
emits line-delimited JSON progress on stdout:

    {"event":"progress","stage":"loading|separating|writing","percent":0-100}
    {"event":"done","outputs":{"dialogue":"...","music":"...","effects":"..."}}
    {"event":"error","message":"..."}

The separation itself is delegated to an ``Engine`` (see ``Engine`` protocol
below). Public Windows production runs licensed TIGER; macOS/Linux retain the
upstream engine set, including the dependency-light stub.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Callable, Dict, Protocol

import numpy as np

# Canonical stem keys -> output filename.
STEM_FILES: Dict[str, str] = {
    "dialogue": "dialogue.wav",
    "music": "music.wav",
    "effects": "effects.wav",
}

ProgressCb = Callable[[str, float], None]

# MVSEP checkpoints do not publish a clear license. Public Windows binaries
# default this off and their app/MCP processes force it off. macOS/Linux retain
# the upstream engine behavior; source-only research runs can opt in/out with
# the environment variable.
UNLICENSED_ENGINES_ENABLED = os.environ.get(
    "STEMSTUDIO_ENABLE_UNLICENSED_ENGINES",
    "0" if os.name == "nt" else "1",
) == "1"
TEST_ENGINES_ENABLED = os.environ.get(
    "STEMSTUDIO_ENABLE_TEST_ENGINES",
    "0" if os.name == "nt" else "1",
) == "1"


class Engine(Protocol):
    """Separation engine contract. Any engine implementing this can be used."""

    def load(self, progress_cb: ProgressCb) -> None:
        """Prepare the engine (load model, warm caches). Report 'loading'."""
        ...

    def separate(
        self, audio: np.ndarray, sr: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        """Separate ``audio`` (shape [samples] or [samples, channels], float32
        in [-1, 1]) at sample rate ``sr`` into a dict with keys 'dialogue',
        'music', 'effects'. Report 'separating'."""
        ...


def emit(obj: dict) -> None:
    """Write one JSON event as a line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _make_progress(stage: str) -> ProgressCb:
    def cb(_stage_ignored: str, percent: float) -> None:
        emit({"event": "progress", "stage": stage, "percent": float(percent)})

    # Bind the stage name at call time from the engine, but default to the
    # stage we were created for.
    def wrapped(stage_name: str, percent: float) -> None:
        emit(
            {
                "event": "progress",
                "stage": stage_name or stage,
                "percent": float(percent),
            }
        )

    return wrapped


def _read_wav(path: str):
    import soundfile as sf

    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    # audio: [samples, channels]
    return audio, sr


def _write_wav(path: str, audio: np.ndarray, sr: int) -> None:
    import soundfile as sf

    # soundfile writes [samples, channels]; ensure 2D. We write 32-bit float so
    # the mixture-consistency guarantee (stems sum exactly to the input) is
    # preserved bit-for-bit through to the ffmpeg delivery step — 16-bit PCM
    # rounding would break it. ffmpeg re-quantises to the 24-bit delivery WAVs.
    if audio.ndim == 1:
        audio = audio[:, None]
    sf.write(path, audio, sr, subtype="FLOAT")


def run(
    input_path: str,
    outdir: str,
    engine: Engine,
    polish_dialogue: bool = False,
) -> Dict[str, str]:
    os.makedirs(outdir, exist_ok=True)

    load_cb = _make_progress("loading")
    engine.load(load_cb)

    load_cb("loading", 100.0)

    audio, sr = _read_wav(input_path)

    sep_cb = _make_progress("separating")
    sep_cb("separating", 0.0)
    stems = engine.separate(audio, sr, sep_cb)
    sep_cb("separating", 100.0)

    # Optional dialogue-polish pass: clean residual music/effects bleed out of
    # the voices. The removed bleed is folded into the effects stem, so the
    # three stems still sum to the input sample-for-sample. Runs AFTER the
    # engine's own mixture-consistency step.
    if polish_dialogue:
        from . import pipeline
        from .polish import polish_dialogue as _polish

        polish_cb = _make_progress("polishing")
        polish_cb("polishing", 0.0)
        stems = pipeline.apply_dialogue_polish(
            stems,
            sr,
            lambda d, s: _polish(d, s, polish_cb),
        )
        # Verify the sum-exact guarantee survived the polish fold (same bar as
        # pipeline.enforce_mixture_consistency: max|residual| < 1e-6).
        mix = audio[:, None] if audio.ndim == 1 else audio
        n = min(
            mix.shape[0],
            stems["dialogue"].shape[0],
            stems["music"].shape[0],
            stems["effects"].shape[0],
        )
        residual = mix[:n] - (
            stems["dialogue"][:n] + stems["music"][:n] + stems["effects"][:n]
        )
        max_resid = float(np.max(np.abs(residual))) if n else 0.0
        if max_resid >= 1e-6:
            raise ValueError(
                f"dialogue polish broke mixture consistency: "
                f"max|residual|={max_resid:.3e} (expected < 1e-6)"
            )
        polish_cb("polishing", 100.0)

    write_cb = _make_progress("writing")
    outputs: Dict[str, str] = {}
    keys = list(STEM_FILES.keys())
    for i, key in enumerate(keys):
        if key not in stems:
            raise ValueError(f"engine did not return stem '{key}'")
        out_path = os.path.join(outdir, STEM_FILES[key])
        _write_wav(out_path, stems[key], sr)
        outputs[key] = out_path
        write_cb("writing", (i + 1) / len(keys) * 100.0)

    return outputs


def build_engine(name: str, quality: str, cache_dir: str | None) -> Engine:
    """Construct the engine for ``name``/``quality``.

    * ``quality == 'max'`` implies the cross-model blend (TIGER-high + MVSEP)
      regardless of ``--engine``.
    * ``tiger`` is the TIGER-DnR ML model; ``mvsep`` is MVSEP-CDX23 (HTDemucs);
      ``stub`` is the dependency-light band-splitter (no torch required).
    """
    if (name == "mvsep" or quality == "max") and not UNLICENSED_ENGINES_ENABLED:
        raise ValueError(
            "MVSEP and Max are disabled in public builds because the checkpoint "
            "license has not been established"
        )
    if quality == "max":
        from .engine_max import EngineMax

        return EngineMax(cache_dir=cache_dir)
    if name == "stub":
        if not TEST_ENGINES_ENABLED:
            raise ValueError("the stub engine is unavailable in this distribution")
        from .engine_stub import EngineStub

        return EngineStub()
    if name == "tiger":
        from .engine_tiger import EngineTiger

        return EngineTiger(cache_dir=cache_dir, quality=quality)
    if name == "mvsep":
        from .engine_mvsep import EngineMvsep

        # A bare `--engine mvsep` runs a single checkpoint; the ensemble is
        # reserved for `max` quality on CUDA (see EngineMax).
        return EngineMvsep(cache_dir=cache_dir, ensemble=False)
    raise ValueError(f"unknown engine '{name}'")


def available_engines() -> list[str]:
    return (
        ["tiger"]
        + (["mvsep"] if UNLICENSED_ENGINES_ENABLED else [])
        + (["stub"] if TEST_ENGINES_ENABLED else [])
    )


def available_qualities() -> list[str]:
    return ["fast", "high"] + (["max"] if UNLICENSED_ENGINES_ENABLED else [])


def probe() -> dict:
    """Return one dict describing the worker's torch/device stack. Printed as a
    single JSON line by ``--probe`` and used by the app to default the quality
    tier (Windows GPU→high; non-Windows CUDA→max; CPU→fast)."""
    from . import device

    torch_version: str | None = None
    try:
        import torch

        torch_version = str(torch.__version__)
    except Exception:  # noqa: BLE001 — torch may be absent
        torch_version = None

    return {
        "device": device.select_device_name(),
        "cuda": device.cuda_available(),
        "mps": device.mps_available(),
        "torch": torch_version,
        "engines": available_engines(),
        "qualities": available_qualities(),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="stemstudio_worker.separate")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="print one JSON line describing the torch/device stack and exit",
    )
    parser.add_argument("--input", help="input WAV path")
    parser.add_argument("--outdir", help="output directory")
    parser.add_argument(
        "--engine",
        default="tiger",
        choices=available_engines(),
        help="separation engine (public Windows build: tiger)",
    )
    parser.add_argument(
        "--quality",
        default="fast",
        choices=available_qualities(),
        help="quality mode; 'high' runs a TTA ensemble. Default: fast",
    )
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("STEMSTUDIO_CACHE_DIR"),
        help="directory to cache downloaded model weights",
    )
    parser.add_argument(
        "--polish-dialogue",
        action="store_true",
        help="optional post-separation pass: reduce residual music/effects "
        "bleed in the dialogue stem (the removed bleed is folded into effects, "
        "so the stems still sum to the input). Slower. Default: off.",
    )
    args = parser.parse_args(argv)

    if args.probe:
        # Pure JSON line, no traceback noise: emit best-effort even on failure.
        try:
            emit(probe())
        except Exception as exc:  # noqa: BLE001
            emit(
                {
                    "device": "cpu",
                    "cuda": False,
                    "mps": False,
                    "torch": None,
                    "engines": available_engines(),
                    "qualities": available_qualities(),
                    "error": str(exc),
                }
            )
        return 0

    if not args.input or not args.outdir:
        parser.error("--input and --outdir are required unless --probe is given")

    try:
        engine: Engine = build_engine(args.engine, args.quality, args.cache_dir)
        outputs = run(args.input, args.outdir, engine, polish_dialogue=args.polish_dialogue)
        emit({"event": "done", "outputs": outputs})
        return 0
    except Exception as exc:  # noqa: BLE001 — surface any failure as an event
        detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        emit({"event": "error", "message": f"{exc}\n\n{detail}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
