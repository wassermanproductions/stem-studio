"""Quality pipeline helpers shared by the separation engines.

Everything here is engine-agnostic and depends only on numpy:

* :func:`chunked_overlap_add` — process arbitrarily long audio in bounded
  ~N-second blocks with a Hann crossfade in the overlap, so memory use is
  independent of input length and there are no seams between blocks.
* :func:`enforce_mixture_consistency` — the "nothing lost" guarantee: fold the
  residual ``mix - (dialogue + music + effects)`` back into the effects stem so
  the three stems sum to the original mixture sample-for-sample.
* :func:`time_shift` / :func:`tta_average` — test-time-augmentation helpers for
  the ``high`` quality mode (separate several time-shifted copies and average).
* :func:`si_sdr` — scale-invariant SDR, used by the eval harness.

Audio arrays here are always ``float32`` of shape ``[samples, channels]``.
"""

from __future__ import annotations

from typing import Callable, Dict, List

import numpy as np

STEM_KEYS = ("dialogue", "music", "effects")

# A "block" is the unit the engine's model runs on inside the outer overlap-add
# loop. 30 s keeps peak memory modest while amortising the model's own internal
# window padding; 1 s of overlap is crossfaded so blocks join seamlessly.
DEFAULT_BLOCK_SECONDS = 30.0
DEFAULT_OVERLAP_SECONDS = 1.0

# Test-time-augmentation shifts (fractions of a second) for `high` quality.
TTA_SHIFTS_SECONDS = (0.0, 0.25, 0.5)

BlockFn = Callable[[np.ndarray], Dict[str, np.ndarray]]


def _as_2d(x: np.ndarray) -> np.ndarray:
    return x[:, None] if x.ndim == 1 else x


def _conform(y: np.ndarray, n: int, ch: int) -> np.ndarray:
    """Conform a block result to exactly ``[n, ch]``.

    Models occasionally return a block a hair short (or long) in time, or
    collapsed to a single channel; the overlap-add crossfade needs both
    operands the same shape. Truncate/zero-pad the time axis to ``n`` and
    broadcast/truncate the channel axis to ``ch``.
    """
    y = _as_2d(y).astype(np.float32)
    if y.shape[0] > n:
        y = y[:n]
    elif y.shape[0] < n:
        y = np.concatenate([y, np.zeros((n - y.shape[0], y.shape[1]), np.float32)], axis=0)
    if y.shape[1] == ch:
        return y
    if y.shape[1] == 1:
        return np.repeat(y, ch, axis=1)
    if y.shape[1] > ch:
        return y[:, :ch]
    return np.concatenate([y, np.repeat(y[:, -1:], ch - y.shape[1], axis=1)], axis=1)


def _hann_ramps(overlap: int) -> tuple[np.ndarray, np.ndarray]:
    """Complementary fade-in / fade-out ramps of length ``overlap`` that sum to
    1 everywhere (a Hann window split at its midpoint)."""
    if overlap <= 0:
        return np.ones(0, np.float32), np.ones(0, np.float32)
    # Hann over exactly 2*overlap points; the first half rises and the second
    # half falls, and the two halves are complementary (w[i] + w[i+overlap] == 1)
    # so a crossfade using them preserves unity gain across the seam.
    w = np.hanning(2 * overlap).astype(np.float32)  # length 2*overlap
    fade_in = w[:overlap]
    fade_out = w[overlap:]
    return fade_in, fade_out


def chunked_overlap_add(
    audio: np.ndarray,
    sr: int,
    block_fn: BlockFn,
    *,
    block_seconds: float = DEFAULT_BLOCK_SECONDS,
    overlap_seconds: float = DEFAULT_OVERLAP_SECONDS,
    progress_cb: Callable[[float], None] | None = None,
) -> Dict[str, np.ndarray]:
    """Run ``block_fn`` over ``audio`` in overlapping blocks and stitch the
    per-stem results with a Hann crossfade in the overlap region.

    ``block_fn`` receives a ``[block_samples, channels]`` float32 array and must
    return a dict with keys ``dialogue`` / ``music`` / ``effects``, each the
    same length as its input. Memory is bounded by the block size regardless of
    how long ``audio`` is.
    """
    audio = _as_2d(audio).astype(np.float32)
    n, ch = audio.shape

    block = max(int(round(block_seconds * sr)), 1)
    overlap = int(round(overlap_seconds * sr))
    overlap = max(0, min(overlap, block // 2))

    # Short enough to do in one shot: no seams to worry about.
    if n <= block:
        out = block_fn(audio)
        return {k: _as_2d(out[k]).astype(np.float32) for k in STEM_KEYS}

    fade_in, fade_out = _hann_ramps(overlap)
    hop = block - overlap

    outputs = {k: np.zeros((n, ch), np.float32) for k in STEM_KEYS}
    written = np.zeros(n, np.float32)  # per-sample: has this index been written?

    start = 0
    total = n
    while start < n:
        end = min(start + block, n)
        seg = audio[start:end]
        res = block_fn(seg)

        for k in STEM_KEYS:
            seg_len = end - start
            # Conform the model's block output to exactly [seg_len, ch] so the
            # crossfade operands always align (models can return a hair short or
            # channel-collapsed).
            y = _conform(res[k], seg_len, ch)
            dst = outputs[k]

            # The leading `overlap` samples of every block after the first are
            # crossfaded with the tail of the previous block.
            lead = overlap if start > 0 else 0
            if lead > 0:
                w_out = fade_out[:, None]
                w_in = fade_in[:, None]
                m = min(lead, seg_len)
                dst[start : start + m] = (
                    dst[start : start + m] * w_out[:m] + y[:m] * w_in[:m]
                )
                if seg_len > m:
                    dst[start + m : end] = y[m:]
            else:
                dst[start:end] = y

        written[start:end] = 1.0
        if progress_cb is not None:
            progress_cb(min(end / total, 1.0))
        if end >= n:
            break
        start += hop

    return outputs


def enforce_mixture_consistency(
    mix: np.ndarray, stems: Dict[str, np.ndarray]
) -> Dict[str, np.ndarray]:
    """Guarantee ``dialogue + music + effects == mix`` sample-for-sample by
    folding the residual into the effects stem. Returns a new dict; inputs are
    not mutated. Shapes are aligned/truncated to the mixture length.
    """
    mix = _as_2d(mix).astype(np.float32)
    n = mix.shape[0]

    d = _as_2d(stems["dialogue"]).astype(np.float32)[:n]
    m = _as_2d(stems["music"]).astype(np.float32)[:n]
    e = _as_2d(stems["effects"]).astype(np.float32)[:n]

    # Pad any short stem back up to n (models occasionally return a hair short).
    def _fit(x: np.ndarray) -> np.ndarray:
        if x.shape[0] < n:
            pad = np.zeros((n - x.shape[0], x.shape[1]), np.float32)
            x = np.concatenate([x, pad], axis=0)
        return x

    d, m, e = _fit(d), _fit(m), _fit(e)
    residual = mix - (d + m + e)
    e = e + residual
    return {"dialogue": d, "music": m, "effects": e}


def apply_dialogue_polish(
    stems: Dict[str, np.ndarray],
    sr: int,
    polish_fn: Callable[[np.ndarray, int], np.ndarray],
) -> Dict[str, np.ndarray]:
    """Run the optional dialogue-polish pass while preserving the sum-exact
    "nothing lost" guarantee.

    Given sum-consistent ``stems`` (dialogue + music + effects == mix), replace
    the dialogue with its polished version and fold the removed bleed
    (``dialogue_raw - dialogue_polished``) into the effects stem, so the three
    stems still sum to the original mixture sample-for-sample. Call this *after*
    :func:`enforce_mixture_consistency`. Returns a new dict; inputs are not
    mutated. ``polish_fn(dialogue, sr)`` returns a same-length cleaned dialogue.
    """
    d = _as_2d(stems["dialogue"]).astype(np.float32)
    m = _as_2d(stems["music"]).astype(np.float32)
    e = _as_2d(stems["effects"]).astype(np.float32)

    polished = _conform(polish_fn(d, sr), d.shape[0], d.shape[1])

    # Everything the polish removed from dialogue moves to effects, so the sum
    # dialogue + music + effects is unchanged (bleed is relocated, not lost).
    bleed = d - polished
    return {"dialogue": polished, "music": m, "effects": e + bleed}


def blend_stems(
    a: Dict[str, np.ndarray],
    b: Dict[str, np.ndarray],
    weights: Dict[str, float],
) -> Dict[str, np.ndarray]:
    """Per-stem weighted blend of two engines' outputs:
    ``out[k] = weights[k] * a[k] + (1 - weights[k]) * b[k]``.

    ``weights[k]`` is the weight on ``a`` for stem ``k`` (so 1.0 = all ``a``,
    0.0 = all ``b``). Stems are aligned/truncated to a common length per key.
    """
    out: Dict[str, np.ndarray] = {}
    for k in STEM_KEYS:
        ya = _as_2d(a[k]).astype(np.float32)
        yb = _as_2d(b[k]).astype(np.float32)
        n = min(ya.shape[0], yb.shape[0])
        w = float(weights.get(k, 0.5))
        out[k] = (w * ya[:n] + (1.0 - w) * yb[:n]).astype(np.float32)
    return out


def time_shift(audio: np.ndarray, shift: int) -> np.ndarray:
    """Circularly shift ``audio`` by ``shift`` samples along time (wraparound)."""
    if shift == 0:
        return audio
    return np.roll(_as_2d(audio), shift, axis=0)


def tta_average(
    audio: np.ndarray,
    sr: int,
    separate_once: BlockFn,
    *,
    shifts_seconds: tuple[float, ...] = TTA_SHIFTS_SECONDS,
    progress_cb: Callable[[float], None] | None = None,
) -> Dict[str, np.ndarray]:
    """Test-time augmentation: separate several time-shifted copies of the
    audio, un-shift the results, and average per stem. ``separate_once`` runs a
    single full separation pass on a ``[samples, channels]`` array.
    """
    audio = _as_2d(audio).astype(np.float32)
    shifts = [int(round(s * sr)) for s in shifts_seconds]
    acc = {k: np.zeros_like(audio) for k in STEM_KEYS}

    for i, sh in enumerate(shifts):
        shifted = time_shift(audio, sh)
        res = separate_once(shifted)
        for k in STEM_KEYS:
            y = _as_2d(res[k]).astype(np.float32)[: audio.shape[0]]
            acc[k] += time_shift(y, -sh)
        if progress_cb is not None:
            progress_cb((i + 1) / len(shifts))

    inv = 1.0 / len(shifts)
    return {k: (acc[k] * inv).astype(np.float32) for k in STEM_KEYS}


def si_sdr(reference: np.ndarray, estimate: np.ndarray, eps: float = 1e-8) -> float:
    """Scale-invariant signal-to-distortion ratio (dB), averaged over channels.

    Both inputs are ``[samples]`` or ``[samples, channels]`` float arrays and
    are truncated to a common length. Higher is better.
    """
    ref = _as_2d(np.asarray(reference, np.float64))
    est = _as_2d(np.asarray(estimate, np.float64))
    n = min(ref.shape[0], est.shape[0])
    ref, est = ref[:n], est[:n]
    ch = min(ref.shape[1], est.shape[1])

    vals: List[float] = []
    for c in range(ch):
        r = ref[:, c] - ref[:, c].mean()
        e = est[:, c] - est[:, c].mean()
        r_energy = float(np.dot(r, r)) + eps
        scale = float(np.dot(e, r)) / r_energy
        proj = scale * r
        noise = e - proj
        ratio = (float(np.dot(proj, proj)) + eps) / (float(np.dot(noise, noise)) + eps)
        vals.append(10.0 * np.log10(ratio))
    return float(np.mean(vals)) if vals else float("nan")
