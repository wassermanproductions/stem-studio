import { describe, it, expect } from 'vitest'
import { resolveQuality, defaultQualityForDevice } from '@shared/types'

describe('resolveQuality', () => {
  it('prefers an explicit quality tier over the legacy boolean', () => {
    expect(resolveQuality({ quality: 'high', highQuality: false })).toBe('high')
    expect(resolveQuality({ quality: 'fast', highQuality: true })).toBe('fast')
  })

  it('maps the legacy highQuality boolean when no tier is set', () => {
    expect(resolveQuality({ highQuality: true })).toBe('high')
    expect(resolveQuality({ highQuality: false })).toBe('fast')
    expect(resolveQuality({})).toBe('fast')
  })
})

describe('defaultQualityForDevice', () => {
  it('defaults GPU devices to high and cpu to fast', () => {
    expect(defaultQualityForDevice('cuda')).toBe('high')
    expect(defaultQualityForDevice('mps')).toBe('high')
    expect(defaultQualityForDevice('cpu')).toBe('fast')
  })
})
