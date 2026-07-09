import { describe, it, expect } from 'vitest'
import {
  computePeaks,
  mixToMono,
  resolveGains,
  toggleInSet,
  seekTimeFromX,
  playheadX,
  formatClock,
  LANE_KINDS,
  type LaneKind
} from '@shared/audioLanes'

describe('computePeaks', () => {
  it('produces exactly `buckets` min/max pairs', () => {
    const s = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, -0.25, 0])
    const p = computePeaks(s, 4, 2)
    expect(p.min.length).toBe(4)
    expect(p.max.length).toBe(4)
    expect(p.duration).toBe(2)
  })

  it('keeps the extremes within each bucket', () => {
    const s = new Float32Array([0.1, -0.9, 0.9, -0.1])
    const p = computePeaks(s, 2, 1)
    // bucket 0 = [0.1, -0.9], bucket 1 = [0.9, -0.1]
    expect(p.max[0]).toBeCloseTo(0.1)
    expect(p.min[0]).toBeCloseTo(-0.9)
    expect(p.max[1]).toBeCloseTo(0.9)
    expect(p.min[1]).toBeCloseTo(-0.1)
  })

  it('covers the last sample even with uneven bucketing', () => {
    const s = new Float32Array([0, 0, 0, 1])
    const p = computePeaks(s, 3, 1)
    // last bucket must reach the final sample (1)
    expect(p.max[2]).toBeCloseTo(1)
  })

  it('handles empty input without throwing', () => {
    const p = computePeaks(new Float32Array(0), 5, 3)
    expect(p.min.length).toBe(5)
    expect(p.max.every((v) => v === 0)).toBe(true)
    expect(p.duration).toBe(3)
  })

  it('flat-lines empty buckets when buckets exceed samples', () => {
    const p = computePeaks(new Float32Array([0.5, -0.5]), 8, 1)
    expect(p.min.length).toBe(8)
    // every entry is finite
    expect(p.min.every((v) => Number.isFinite(v))).toBe(true)
    expect(p.max.every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('mixToMono', () => {
  it('returns the single channel unchanged', () => {
    const c = new Float32Array([1, 2, 3])
    expect(mixToMono([c])).toBe(c)
  })
  it('averages two channels', () => {
    const l = new Float32Array([1, 0, -1])
    const r = new Float32Array([0, 1, 1])
    const m = mixToMono([l, r])
    expect(Array.from(m)).toEqual([0.5, 0.5, 0])
  })
  it('returns empty for no channels', () => {
    expect(mixToMono([]).length).toBe(0)
  })
})

describe('resolveGains', () => {
  const lanes = LANE_KINDS

  it('is all-audible with no solo/mute', () => {
    const g = resolveGains(lanes, new Set(), new Set())
    expect(Object.values(g).every((v) => v === 1)).toBe(true)
  })

  it('mutes only muted lanes when nothing is soloed', () => {
    const g = resolveGains(lanes, new Set(), new Set<LaneKind>(['music']))
    expect(g.music).toBe(0)
    expect(g.dialogue).toBe(1)
    expect(g.married).toBe(1)
    expect(g.sfx).toBe(1)
  })

  it('solo silences every non-soloed lane, ignoring mute', () => {
    const g = resolveGains(
      lanes,
      new Set<LaneKind>(['dialogue']),
      new Set<LaneKind>(['dialogue']) // muted AND soloed → solo wins, audible
    )
    expect(g.dialogue).toBe(1)
    expect(g.music).toBe(0)
    expect(g.sfx).toBe(0)
    expect(g.married).toBe(0)
  })

  it('multiple solos are all audible', () => {
    const g = resolveGains(lanes, new Set<LaneKind>(['dialogue', 'sfx']), new Set())
    expect(g.dialogue).toBe(1)
    expect(g.sfx).toBe(1)
    expect(g.music).toBe(0)
    expect(g.married).toBe(0)
  })
})

describe('toggleInSet', () => {
  it('adds when absent and removes when present, without mutating', () => {
    const a = new Set<LaneKind>(['music'])
    const b = toggleInSet(a, 'dialogue')
    expect(b.has('dialogue')).toBe(true)
    expect(a.has('dialogue')).toBe(false) // original untouched
    const c = toggleInSet(b, 'music')
    expect(c.has('music')).toBe(false)
  })
})

describe('seekTimeFromX / playheadX', () => {
  it('maps click x to time and back', () => {
    expect(seekTimeFromX(50, 100, 10)).toBeCloseTo(5)
    expect(playheadX(5, 100, 10)).toBeCloseTo(50)
  })
  it('clamps out-of-range x', () => {
    expect(seekTimeFromX(-20, 100, 10)).toBe(0)
    expect(seekTimeFromX(200, 100, 10)).toBeCloseTo(10)
  })
  it('is safe with zero width or duration', () => {
    expect(seekTimeFromX(50, 0, 10)).toBe(0)
    expect(seekTimeFromX(50, 100, 0)).toBe(0)
    expect(playheadX(5, 0, 10)).toBe(0)
    expect(playheadX(5, 100, 0)).toBe(0)
  })
  it('round-trips a fraction', () => {
    const t = seekTimeFromX(37, 100, 8)
    expect(playheadX(t, 100, 8)).toBeCloseTo(37)
  })
})

describe('formatClock', () => {
  it('formats m:ss with zero-padded seconds', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(600)).toBe('10:00')
  })
  it('clamps negatives and non-finite to 0:00', () => {
    expect(formatClock(-3)).toBe('0:00')
    expect(formatClock(NaN)).toBe('0:00')
    expect(formatClock(Infinity)).toBe('0:00')
  })
})
