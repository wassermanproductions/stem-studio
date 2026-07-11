import { describe, it, expect } from 'vitest'
import {
  resolveQuality,
  defaultQualityForDevice,
  defaultQualityForProbe,
  productionQualitiesForPlatform
} from '@shared/types'

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

describe('platform quality policy', () => {
  it('retains Max outside Windows and limits public Windows to Fast/High', () => {
    expect(productionQualitiesForPlatform('windows')).toEqual(['fast', 'high'])
    expect(productionQualitiesForPlatform('mac')).toEqual(['fast', 'high', 'max'])
    expect(productionQualitiesForPlatform('linux')).toEqual(['fast', 'high', 'max'])
  })

  it('defaults CUDA to Max only when the worker exposes it', () => {
    expect(defaultQualityForDevice('cuda')).toBe('max')
    expect(defaultQualityForDevice('cuda', false)).toBe('high')
    expect(defaultQualityForDevice('mps')).toBe('high')
    expect(defaultQualityForDevice('cpu')).toBe('fast')
    expect(defaultQualityForProbe({
      device: 'cuda', cuda: true, mps: false, torch: '2', engines: ['tiger'],
      qualities: ['fast', 'high']
    })).toBe('high')
  })
})
