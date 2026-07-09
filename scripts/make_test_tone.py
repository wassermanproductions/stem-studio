"""Synthesize a 5-second stereo test WAV mixing low/mid/high content.

Writes a 44.1 kHz stereo WAV with a 150 Hz tone (music band), a 1 kHz tone
(speech band), and an 8 kHz tone (effects band) so a band-split engine has
energy to route into every stem.

Usage: python scripts/make_test_tone.py <out.wav>
"""

from __future__ import annotations

import sys

import numpy as np
import soundfile as sf

SR = 44_100
DURATION = 5.0


def main(out_path: str) -> None:
    t = np.linspace(0, DURATION, int(SR * DURATION), endpoint=False)
    low = 0.3 * np.sin(2 * np.pi * 150 * t)     # music band
    mid = 0.3 * np.sin(2 * np.pi * 1000 * t)    # dialogue band
    high = 0.3 * np.sin(2 * np.pi * 8000 * t)   # effects band
    mono = (low + mid + high).astype(np.float32)
    stereo = np.stack([mono, mono], axis=1)
    sf.write(out_path, stereo, SR, subtype="PCM_16")
    print(f"wrote {out_path}: {stereo.shape[0]} samples @ {SR} Hz")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test_tone.wav")
