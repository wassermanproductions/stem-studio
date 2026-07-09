"""Evaluate a separation engine/quality mode on reference triplets.

Takes a directory of reference triplets (each a subdir with ``dialogue.wav``,
``music.wav``, ``effects.wav``), builds the married mix by summing the three,
runs the chosen engine, computes SI-SDR per stem plus SI-SDR improvement over
the mix baseline, and prints a markdown table.

SI-SDR (``pipeline.si_sdr``) is scale-invariant SDR in dB — higher is better.
"SI-SDRi" is the improvement of the estimated stem's SI-SDR over the trivial
"the mix itself is the stem" baseline; positive means the separation helped.

Usage::

    python -m eval.evaluate --data python/eval/data --engine tiger --quality fast
    python -m eval.evaluate --data python/eval/data --engine stub
"""

from __future__ import annotations

import argparse
import os
import time
from typing import Dict, List

import numpy as np
import soundfile as sf

from stemstudio_worker import pipeline

STEMS = ("dialogue", "music", "effects")


def _read(path: str) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    return audio, sr


def _load_triplet(d: str) -> tuple[Dict[str, np.ndarray], int]:
    refs: Dict[str, np.ndarray] = {}
    sr = None
    for k in STEMS:
        a, s = _read(os.path.join(d, f"{k}.wav"))
        refs[k] = a
        sr = s if sr is None else sr
    n = min(v.shape[0] for v in refs.values())
    refs = {k: v[:n] for k, v in refs.items()}
    return refs, int(sr)


def _make_engine(name: str, quality: str, cache_dir: str | None):
    # `--quality max` runs the cross-model blend regardless of engine.
    if quality == "max":
        from stemstudio_worker.engine_max import EngineMax

        return EngineMax(cache_dir=cache_dir)
    if name == "stub":
        from stemstudio_worker.engine_stub import EngineStub

        return EngineStub()
    if name == "tiger":
        from stemstudio_worker.engine_tiger import EngineTiger

        return EngineTiger(cache_dir=cache_dir, quality=quality)
    if name == "mvsep":
        from stemstudio_worker.engine_mvsep import EngineMvsep

        return EngineMvsep(cache_dir=cache_dir, ensemble=False)
    raise ValueError(f"unknown engine '{name}'")


def _silent_cb(_stage: str, _pct: float) -> None:
    pass


def evaluate(
    data_dir: str, engine_name: str, quality: str, cache_dir: str | None
) -> Dict[str, object]:
    clips = sorted(
        d
        for d in os.listdir(data_dir)
        if os.path.isdir(os.path.join(data_dir, d))
        and os.path.exists(os.path.join(data_dir, d, "dialogue.wav"))
    )
    if not clips:
        raise SystemExit(f"no triplets found under {data_dir}")

    engine = _make_engine(engine_name, quality, cache_dir)
    engine.load(_silent_cb)

    per_stem: Dict[str, List[float]] = {k: [] for k in STEMS}
    per_stem_i: Dict[str, List[float]] = {k: [] for k in STEMS}
    total_seconds = 0.0
    total_wall = 0.0

    rows: List[str] = []
    for name in clips:
        refs, sr = _load_triplet(os.path.join(data_dir, name))
        mix = refs["dialogue"] + refs["music"] + refs["effects"]
        dur = mix.shape[0] / sr
        total_seconds += dur

        t0 = time.time()
        est = engine.separate(mix.copy(), sr, _silent_cb)
        wall = time.time() - t0
        total_wall += wall

        cells = []
        for k in STEMS:
            sdr = pipeline.si_sdr(refs[k], est[k])
            base = pipeline.si_sdr(refs[k], mix)  # mix-as-stem baseline
            per_stem[k].append(sdr)
            per_stem_i[k].append(sdr - base)
            cells.append(f"{sdr:+.2f} ({sdr - base:+.2f})")
        rows.append(f"| {name} | " + " | ".join(cells) + f" | {wall:.1f}s |")

    return {
        "engine": engine_name,
        "quality": quality,
        "clips": clips,
        "rows": rows,
        "per_stem": {k: float(np.mean(v)) for k, v in per_stem.items()},
        "per_stem_i": {k: float(np.mean(v)) for k, v in per_stem_i.items()},
        "overall": float(np.mean([np.mean(v) for v in per_stem.values()])),
        "overall_i": float(np.mean([np.mean(v) for v in per_stem_i.values()])),
        "rtf": total_wall / total_seconds if total_seconds else float("nan"),
        "audio_seconds": total_seconds,
        "wall_seconds": total_wall,
    }


def print_report(res: Dict[str, object]) -> None:
    if res["quality"] == "max":
        label = "max (tiger-high + mvsep blend)"
    elif res["engine"] == "tiger":
        label = f"tiger-{res['quality']}"
    else:
        label = str(res["engine"])
    print(f"\n### {label}\n")
    print("SI-SDR dB per stem, higher is better. Parenthesised = SI-SDRi over the mix baseline.\n")
    print("| clip | dialogue | music | effects | time |")
    print("|------|----------|-------|---------|------|")
    for r in res["rows"]:
        print(r)
    ps, psi = res["per_stem"], res["per_stem_i"]
    print(
        f"| **mean** | **{ps['dialogue']:+.2f} ({psi['dialogue']:+.2f})** "
        f"| **{ps['music']:+.2f} ({psi['music']:+.2f})** "
        f"| **{ps['effects']:+.2f} ({psi['effects']:+.2f})** | |"
    )
    print(
        f"\n**Overall mean SI-SDR: {res['overall']:+.2f} dB "
        f"(SI-SDRi {res['overall_i']:+.2f} dB)** · "
        f"RTF {res['rtf']:.2f}× ({res['wall_seconds']:.0f}s wall / "
        f"{res['audio_seconds']:.0f}s audio)"
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="eval.evaluate")
    parser.add_argument(
        "--data", default=os.path.join(os.path.dirname(__file__), "data")
    )
    parser.add_argument(
        "--engine", default="tiger", choices=["tiger", "mvsep", "stub"]
    )
    parser.add_argument(
        "--quality", default="fast", choices=["fast", "high", "max"]
    )
    parser.add_argument("--cache-dir", default=os.environ.get("STEMSTUDIO_CACHE_DIR"))
    args = parser.parse_args(argv)

    res = evaluate(args.data, args.engine, args.quality, args.cache_dir)
    print_report(res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
