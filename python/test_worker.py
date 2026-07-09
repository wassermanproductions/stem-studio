"""End-to-end worker test (no framework required).

Synthesizes a 5s multi-band test tone, runs the worker CLI as a subprocess
(exactly as the Electron main process does), and asserts three non-silent
output WAVs are produced. Run from the repo root with the venv python::

    PYTHONPATH=python .venv/bin/python python/test_worker.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def make_tone(path: str, sr: int = 44_100, dur: float = 5.0) -> None:
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    mono = (
        0.3 * np.sin(2 * np.pi * 150 * t)
        + 0.3 * np.sin(2 * np.pi * 1000 * t)
        + 0.3 * np.sin(2 * np.pi * 8000 * t)
    ).astype(np.float32)
    sf.write(path, np.stack([mono, mono], axis=1), sr, subtype="PCM_16")


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        tone = os.path.join(d, "tone.wav")
        outdir = os.path.join(d, "out")
        make_tone(tone)

        env = dict(os.environ, PYTHONPATH=HERE)
        # Use the stub engine so this e2e test runs without torch installed.
        proc = subprocess.run(
            [sys.executable, "-m", "stemstudio_worker.separate",
             "--input", tone, "--outdir", outdir, "--engine", "stub"],
            capture_output=True, text=True, env=env, cwd=HERE,
        )
        assert proc.returncode == 0, f"worker failed: {proc.stderr}\n{proc.stdout}"

        events = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        assert any(e.get("event") == "done" for e in events), "no done event"

        stems = {}
        for name in ("dialogue.wav", "music.wav", "effects.wav"):
            p = os.path.join(outdir, name)
            assert os.path.exists(p), f"missing {name}"
            audio, sr = sf.read(p, always_2d=True, dtype="float32")
            stems[name] = audio
            rms = float(np.sqrt(np.mean(audio**2)))
            assert rms > 1e-4, f"{name} is silent (rms={rms})"
            print(f"OK {name}: sr={sr} shape={audio.shape} rms={rms:.5f}")

        # Mixture-consistency: the three stems must sum back to the input mix.
        mix, _ = sf.read(tone, always_2d=True, dtype="float32")
        n = min(len(mix), *(len(s) for s in stems.values()))
        residual = mix[:n] - sum(s[:n] for s in stems.values())
        rmax = float(np.max(np.abs(residual)))
        assert rmax < 1e-6, f"stems do not sum to input (max|residual|={rmax:.2e})"
        print(f"OK mixture-consistency: max|residual|={rmax:.2e}")

    print("PASS: worker produced 3 non-silent stems that sum to the input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
