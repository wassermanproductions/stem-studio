/**
 * Pure, DOM-free helpers for the multi-lane waveform/playback UI in the Done
 * view. Everything here is unit-tested and free of WebAudio/Canvas so the
 * transport math and solo/mute resolution can be reasoned about in isolation.
 */

/** The four lanes shown in the Done view, in display order. */
export const LANE_KINDS = ['married', 'dialogue', 'music', 'sfx'] as const
export type LaneKind = (typeof LANE_KINDS)[number]

export const LANE_LABELS: Record<LaneKind, string> = {
  married: 'Married Mix',
  dialogue: 'Dialogue',
  music: 'Music',
  sfx: 'SFX'
}

/**
 * Per-lane min/max peaks for waveform rendering. `min` and `max` are parallel
 * arrays of the same length (one entry per horizontal pixel bucket), each in
 * [-1, 1].
 */
export interface Peaks {
  min: Float32Array
  max: Float32Array
  /** Source duration in seconds (for the time axis / seek math). */
  duration: number
}

/**
 * Downsample a mono (or already-mixed) PCM channel to `buckets` min/max pairs.
 * Each bucket spans an equal slice of the samples; we keep the extremes so
 * transients survive the downsample (standard peak-meter rendering).
 *
 * Pure and allocation-bounded: output size is exactly `buckets`.
 */
export function computePeaks(
  samples: Float32Array,
  buckets: number,
  duration: number
): Peaks {
  const n = Math.max(1, Math.floor(buckets))
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  if (samples.length === 0) {
    return { min, max, duration: Math.max(0, duration) }
  }
  const per = samples.length / n
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per)
    const end = b === n - 1 ? samples.length : Math.floor((b + 1) * per)
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end; i++) {
      const v = samples[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (lo === Infinity) {
      // Empty bucket (can happen when buckets > samples): carry a flat line.
      lo = 0
      hi = 0
    }
    min[b] = lo
    max[b] = hi
  }
  return { min, max, duration: Math.max(0, duration) }
}

/**
 * Average two or more equal-length channels into one Float32Array (e.g. fold a
 * stereo pair to mono for peak display). Returns the first channel unchanged if
 * only one is given. All inputs must be the same length.
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]!
  const len = channels[0]!.length
  const out = new Float32Array(len)
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] = out[i]! + ch[i]!
  }
  const inv = 1 / channels.length
  for (let i = 0; i < len; i++) out[i] = out[i]! * inv
  return out
}

/**
 * Resolve which lanes are audible given the current solo/mute sets.
 *
 * Rules (standard mixer semantics):
 *  - If any lane is soloed, only soloed lanes are audible (mute is ignored for
 *    non-soloed lanes because they're already silenced by the solo).
 *  - Otherwise, a lane is audible unless it is muted.
 *
 * Returns a map lane→gain (1 audible, 0 silent) for every lane in `lanes`.
 */
export function resolveGains(
  lanes: readonly LaneKind[],
  solo: ReadonlySet<LaneKind>,
  mute: ReadonlySet<LaneKind>
): Record<LaneKind, number> {
  const anySolo = lanes.some((l) => solo.has(l))
  const out = {} as Record<LaneKind, number>
  for (const lane of lanes) {
    if (anySolo) out[lane] = solo.has(lane) ? 1 : 0
    else out[lane] = mute.has(lane) ? 0 : 1
  }
  return out
}

/** Toggle a member in an immutable set, returning a new Set. */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/**
 * Convert a horizontal click position to a seek time.
 * @param x       pointer x relative to the lane's left edge (px)
 * @param width   lane width (px)
 * @param duration track duration (s)
 * Clamps to [0, duration]; a zero/negative width or duration yields 0.
 */
export function seekTimeFromX(x: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0
  const frac = Math.max(0, Math.min(1, x / width))
  return frac * duration
}

/**
 * Convert a playback time to a playhead x position within a lane.
 * Inverse of {@link seekTimeFromX}. Clamps to [0, width].
 */
export function playheadX(time: number, width: number, duration: number): number {
  if (duration <= 0 || width <= 0) return 0
  const frac = Math.max(0, Math.min(1, time / duration))
  return frac * width
}

/** Format a seconds value as m:ss (for the transport time readout). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
