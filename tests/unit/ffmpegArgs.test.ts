import { describe, it, expect } from 'vitest'
import {
  probeArgs,
  extractAudioArgs,
  convertStemArgs,
  marriedMixArgs,
  remuxMultitrackArgs
} from '@shared/ffmpegArgs'
import { ENGINE_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from '@shared/types'

describe('probeArgs', () => {
  it('requests JSON format + streams for the input', () => {
    const a = probeArgs('/in.mov')
    expect(a).toContain('-show_format')
    expect(a).toContain('-show_streams')
    expect(a).toContain('json')
    expect(a[a.length - 1]).toBe('/in.mov')
  })
})

describe('extractAudioArgs', () => {
  const a = extractAudioArgs('/in.mov', '/tmp/out.wav')
  it('drops video and forces stereo at the engine sample rate', () => {
    expect(a).toContain('-vn')
    expect(a).toEqual(expect.arrayContaining(['-ac', '2']))
    expect(a).toEqual(expect.arrayContaining(['-ar', String(ENGINE_SAMPLE_RATE)]))
  })
  it('writes PCM 16-bit and ends with the output path', () => {
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'pcm_s16le']))
    expect(a[a.length - 1]).toBe('/tmp/out.wav')
    expect(a[0]).toBe('-y')
  })
})

describe('convertStemArgs', () => {
  const a = convertStemArgs('/j/dialogue.wav', '/out/CLIP_DIALOGUE.wav')
  it('targets 48 kHz 24-bit PCM delivery', () => {
    expect(a).toEqual(expect.arrayContaining(['-ar', String(OUTPUT_SAMPLE_RATE)]))
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le']))
    expect(a[a.length - 1]).toBe('/out/CLIP_DIALOGUE.wav')
  })
})

describe('marriedMixArgs', () => {
  const a = marriedMixArgs('/j/input.wav', '/out/CLIP_MARRIED.wav')
  it('conforms the mix to the same 48 kHz / 24-bit stereo delivery spec', () => {
    expect(a).toEqual(expect.arrayContaining(['-ar', String(OUTPUT_SAMPLE_RATE)]))
    expect(a).toEqual(expect.arrayContaining(['-ac', '2']))
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le']))
    expect(a[0]).toBe('-y')
    expect(a).toEqual(expect.arrayContaining(['-i', '/j/input.wav']))
    expect(a[a.length - 1]).toBe('/out/CLIP_MARRIED.wav')
  })
})

describe('remuxMultitrackArgs', () => {
  const stems = {
    dialogue: '/o/d.wav',
    music: '/o/m.wav',
    sfx: '/o/s.wav'
  }
  const a = remuxMultitrackArgs('/in.mov', stems, '/o/CLIP_STEMS.mov')

  it('takes the video first then the three stems as inputs', () => {
    // -i /in.mov -i d -i m -i s
    const iIdx = a.reduce<number[]>((acc, v, i) => (v === '-i' ? [...acc, i] : acc), [])
    expect(iIdx.length).toBe(4)
    expect(a[iIdx[0]! + 1]).toBe('/in.mov')
    expect(a[iIdx[1]! + 1]).toBe('/o/d.wav')
    expect(a[iIdx[2]! + 1]).toBe('/o/m.wav')
    expect(a[iIdx[3]! + 1]).toBe('/o/s.wav')
  })

  it('maps video from input 0 and one audio track per stem input', () => {
    expect(a).toEqual(expect.arrayContaining(['-map', '0:v']))
    expect(a).toEqual(expect.arrayContaining(['-map', '1:a']))
    expect(a).toEqual(expect.arrayContaining(['-map', '2:a']))
    expect(a).toEqual(expect.arrayContaining(['-map', '3:a']))
  })

  it('copies video, encodes 24-bit PCM audio, and titles the tracks', () => {
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'copy']))
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:0', 'title=Dialogue']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:1', 'title=Music']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:2', 'title=SFX']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:0', 'handler_name=Dialogue']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:1', 'handler_name=Music']))
    expect(a).toEqual(expect.arrayContaining(['-metadata:s:a:2', 'handler_name=SFX']))
    expect(a[a.length - 1]).toBe('/o/CLIP_STEMS.mov')
  })
})
