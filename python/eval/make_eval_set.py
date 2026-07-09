"""Generate synthetic reference triplets for the separation eval harness.

Each triplet is three 44.1 kHz WAVs — ``dialogue.wav`` / ``music.wav`` /
``effects.wav`` — that the harness sums into a "married" mix, separates, and
scores against. Dialogue is real synthesized speech (macOS ``say`` piped
through ffmpeg to 44.1 kHz), music is a chord progression with harmonics and
per-note envelopes (actually musical, not a bare sine), and effects are
filtered noise bursts / impacts / whooshes.

This material is SYNTHETIC. Scores on it are for regression/sanity only — real
film mixes will score differently.

Usage::

    python -m eval.make_eval_set --outdir python/eval/data
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf

SR = 44_100

FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "ffmpeg"]

# Three clips: (voice, sentence, dur, chord roots (Hz), sfx style).
CLIPS = [
    {
        "name": "clip1",
        "voice": "Samantha",
        "text": "The signal is clean and the stems are separated.",
        "dur": 12.0,
        "chords": [130.81, 164.81, 196.00, 174.61],  # C E G F (roots)
        "sfx": "impacts",
    },
    {
        "name": "clip2",
        "voice": "Daniel",
        "text": "Roll the tape, cue the music, and drop the effects.",
        "dur": 13.0,
        "chords": [110.00, 146.83, 164.81, 123.47],  # A D E B
        "sfx": "whooshes",
    },
    {
        "name": "clip3",
        "voice": "Karen",
        "text": "Dialogue, music, and sound effects, each on its own track.",
        "dur": 11.0,
        "chords": [98.00, 130.81, 146.83, 110.00],  # G C D A
        "sfx": "noise_bursts",
    },
]


def _ffmpeg() -> str:
    for c in FFMPEG_CANDIDATES:
        if shutil.which(c) or os.path.exists(c):
            return c
    raise RuntimeError("ffmpeg not found (looked in /opt/homebrew/bin and PATH)")


def make_speech(text: str, voice: str, dur: float, path: str) -> None:
    """macOS `say` -> AIFF -> 44.1 kHz mono WAV, padded/trimmed to `dur`."""
    ffmpeg = _ffmpeg()
    with tempfile.TemporaryDirectory() as d:
        aiff = os.path.join(d, "s.aiff")
        subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
        raw = os.path.join(d, "s.wav")
        subprocess.run(
            [ffmpeg, "-y", "-i", aiff, "-ac", "1", "-ar", str(SR), raw],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        audio, _ = sf.read(raw, always_2d=False, dtype="float32")

    n = int(SR * dur)
    out = np.zeros(n, np.float32)
    # Place the utterance a beat in so it overlaps music/effects naturally.
    start = int(SR * 1.0)
    seg = audio[: max(0, n - start)]
    out[start : start + len(seg)] = seg
    # Normalise speech to a sensible level.
    peak = float(np.max(np.abs(out))) or 1.0
    out = out * (0.5 / peak)
    sf.write(path, out, SR, subtype="PCM_16")


def _adsr(n: int, a=0.01, d=0.1, s=0.7, r=0.2) -> np.ndarray:
    env = np.ones(n, np.float32) * s
    ai, di, ri = int(a * SR), int(d * SR), int(r * SR)
    ai, di, ri = min(ai, n), min(di, n), min(ri, n)
    if ai:
        env[:ai] = np.linspace(0, 1, ai)
    if di:
        env[ai : ai + di] = np.linspace(1, s, di)
    if ri:
        env[-ri:] = np.linspace(env[-ri], 0, ri)
    return env


def make_music(chords: list[float], dur: float, path: str) -> None:
    """A simple chord progression with harmonics and per-note ADSR envelopes."""
    n = int(SR * dur)
    out = np.zeros(n, np.float32)
    beats = len(chords)
    seg_len = n // beats
    t_seg = np.arange(seg_len) / SR
    for i, root in enumerate(chords):
        note = np.zeros(seg_len, np.float32)
        # Major-triad-ish stack with decaying harmonics.
        for mult, amp in [(1.0, 0.5), (1.26, 0.35), (1.5, 0.3), (2.0, 0.2), (3.0, 0.1)]:
            note += amp * np.sin(2 * np.pi * root * mult * t_seg)
        note *= _adsr(seg_len)
        out[i * seg_len : i * seg_len + seg_len] = note
    peak = float(np.max(np.abs(out))) or 1.0
    out = out * (0.35 / peak)
    sf.write(path, out.astype(np.float32), SR, subtype="PCM_16")


def make_sfx(style: str, dur: float, path: str) -> None:
    n = int(SR * dur)
    out = np.zeros(n, np.float32)
    rng = np.random.default_rng(hash(style) % (2**32))
    if style == "impacts":
        for onset in (2.0, 5.5, 8.0):
            start = int(onset * SR)
            length = int(0.4 * SR)
            noise = rng.standard_normal(length).astype(np.float32)
            env = np.exp(-np.linspace(0, 8, length)).astype(np.float32)
            out[start : start + length] += noise * env * 0.6
    elif style == "whooshes":
        for onset in (1.5, 4.5, 7.5):
            start = int(onset * SR)
            length = int(0.8 * SR)
            noise = rng.standard_normal(length).astype(np.float32)
            # Band-limited-ish via a moving average, swept amplitude.
            k = 20
            noise = np.convolve(noise, np.ones(k) / k, mode="same").astype(np.float32)
            env = np.sin(np.linspace(0, np.pi, length)).astype(np.float32)
            out[start : start + length] += noise * env * 0.7
    else:  # noise_bursts
        for onset in (1.0, 3.0, 5.0, 7.0, 9.0):
            start = int(onset * SR)
            length = int(0.25 * SR)
            if start + length > n:
                break
            noise = rng.standard_normal(length).astype(np.float32)
            env = np.hanning(length).astype(np.float32)
            out[start : start + length] += noise * env * 0.5
    peak = float(np.max(np.abs(out))) or 1.0
    out = out * (0.3 / peak) if peak > 0 else out
    sf.write(path, out.astype(np.float32), SR, subtype="PCM_16")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="eval.make_eval_set")
    parser.add_argument(
        "--outdir",
        default=os.path.join(os.path.dirname(__file__), "data"),
        help="root dir; one subdir per clip with dialogue/music/effects.wav",
    )
    args = parser.parse_args(argv)

    os.makedirs(args.outdir, exist_ok=True)
    for clip in CLIPS:
        d = os.path.join(args.outdir, clip["name"])
        os.makedirs(d, exist_ok=True)
        make_speech(clip["text"], clip["voice"], clip["dur"], os.path.join(d, "dialogue.wav"))
        make_music(clip["chords"], clip["dur"], os.path.join(d, "music.wav"))
        make_sfx(clip["sfx"], clip["dur"], os.path.join(d, "effects.wav"))
        print(f"wrote {d} (dialogue/music/effects.wav, {clip['dur']}s)")
    print(f"done: {len(CLIPS)} triplets in {args.outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
