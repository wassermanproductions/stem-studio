"""Verify the four delivered WAVs are aligned and reconstruct the married mix."""

from __future__ import annotations

import sys

import numpy as np
import soundfile as sf


def main(paths: list[str]) -> int:
    if len(paths) != 4:
        raise SystemExit("usage: verify_deliveries.py MARRIED DIALOGUE MUSIC SFX")
    loaded = [sf.read(path, always_2d=True, dtype="float32") for path in paths]
    rates = [rate for _, rate in loaded]
    shapes = [audio.shape for audio, _ in loaded]
    assert rates == [48_000] * 4, f"unexpected sample rates: {rates}"
    assert len(set(shapes)) == 1, f"deliveries are not sample-aligned: {shapes}"
    married = loaded[0][0]
    stem_sum = loaded[1][0] + loaded[2][0] + loaded[3][0]
    residual = float(np.max(np.abs(married - stem_sum)))
    assert residual < 1e-5, f"delivery mixture residual too large: {residual:.3e}"
    print(f"PASS deliveries aligned at {shapes[0]} / 48 kHz; max residual={residual:.3e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
