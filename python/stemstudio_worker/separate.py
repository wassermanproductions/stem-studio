"""Engine-agnostic separation CLI.

Usage::

    python -m stemstudio_worker.separate --input <wav> --outdir <dir>

Writes ``dialogue.wav``, ``music.wav``, ``effects.wav`` into ``outdir`` and
emits line-delimited JSON progress on stdout:

    {"event":"progress","stage":"loading|separating|writing","percent":0-100}
    {"event":"done","outputs":{"dialogue":"...","music":"...","effects":"..."}}
    {"event":"error","message":"..."}

The separation itself is delegated to an ``Engine`` (see ``Engine`` protocol
below). The default engine is the dependency-light band-splitter in
``engine_stub.EngineStub``; swap it out to plug in a real model.
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


def run(input_path: str, outdir: str, engine: Engine) -> Dict[str, str]:
    os.makedirs(outdir, exist_ok=True)

    load_cb = _make_progress("loading")
    engine.load(load_cb)

    load_cb("loading", 100.0)

    audio, sr = _read_wav(input_path)

    sep_cb = _make_progress("separating")
    sep_cb("separating", 0.0)
    stems = engine.separate(audio, sr, sep_cb)
    sep_cb("separating", 100.0)

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
    """Construct the requested engine. 'tiger' is the real ML model;
    'stub' is the dependency-light band-splitter (no torch required)."""
    if name == "stub":
        from .engine_stub import EngineStub

        return EngineStub()
    if name == "tiger":
        from .engine_tiger import EngineTiger

        return EngineTiger(cache_dir=cache_dir, quality=quality)
    raise ValueError(f"unknown engine '{name}' (expected 'tiger' or 'stub')")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="stemstudio_worker.separate")
    parser.add_argument("--input", required=True, help="input WAV path")
    parser.add_argument("--outdir", required=True, help="output directory")
    parser.add_argument(
        "--engine",
        default="tiger",
        choices=["tiger", "stub"],
        help="separation engine (default: tiger)",
    )
    parser.add_argument(
        "--quality",
        default="fast",
        choices=["fast", "high"],
        help="quality mode; 'high' runs a test-time-augmentation ensemble "
        "(tiger only; ignored by stub). Default: fast",
    )
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("STEMSTUDIO_CACHE_DIR"),
        help="directory to cache downloaded model weights (tiger only)",
    )
    args = parser.parse_args(argv)

    try:
        engine: Engine = build_engine(args.engine, args.quality, args.cache_dir)
        outputs = run(args.input, args.outdir, engine)
        emit({"event": "done", "outputs": outputs})
        return 0
    except Exception as exc:  # noqa: BLE001 — surface any failure as an event
        detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        emit({"event": "error", "message": f"{exc}\n\n{detail}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
