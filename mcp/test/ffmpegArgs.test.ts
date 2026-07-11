// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
import { describe, it, expect } from 'vitest'
import {
  probeArgs,
  extractAudioArgs,
  convertStemArgs,
  marriedMixArgs,
  remuxMultitrackArgs
} from '../src/ffmpegArgs.js'
import type { StemKind } from '../src/types.js'

describe('probeArgs', () => {
  it('emits json format+streams for the input', () => {
    expect(probeArgs('/in.mov')).toEqual([
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      '/in.mov'
    ])
  })
})

describe('extractAudioArgs', () => {
  it('drops video, forces stereo 44.1k pcm_s16le', () => {
    expect(extractAudioArgs('/in.mov', '/tmp/x.wav')).toEqual([
      '-y',
      '-i',
      '/in.mov',
      '-vn',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'pcm_s16le',
      '/tmp/x.wav'
    ])
  })
})

describe('convertStemArgs', () => {
  it('resamples to 48k/24-bit delivery WAV', () => {
    expect(convertStemArgs('/s/dialogue.wav', '/o/base_DIALOGUE.wav')).toEqual([
      '-y',
      '-i',
      '/s/dialogue.wav',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s24le',
      '/o/base_DIALOGUE.wav'
    ])
  })
})

describe('marriedMixArgs', () => {
  it('conforms the original mix to 48k/24-bit stereo, video dropped', () => {
    expect(marriedMixArgs('/in.mov', '/o/base_MARRIED.wav')).toEqual([
      '-y',
      '-i',
      '/in.mov',
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s24le',
      '/o/base_MARRIED.wav'
    ])
  })
})

describe('remuxMultitrackArgs', () => {
  const stems: Record<StemKind, string> = {
    dialogue: '/o/base_DIALOGUE.wav',
    music: '/o/base_MUSIC.wav',
    sfx: '/o/base_SFX.wav'
  }

  it('maps video + 3 stem audio tracks in canonical order with titles', () => {
    expect(remuxMultitrackArgs('/in.mov', stems, '/o/base_STEMS.mov')).toEqual([
      '-y',
      '-i',
      '/in.mov',
      '-i',
      '/o/base_DIALOGUE.wav',
      '-i',
      '/o/base_MUSIC.wav',
      '-i',
      '/o/base_SFX.wav',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-map',
      '3:a',
      '-c:v',
      'copy',
      '-c:a',
      'pcm_s24le',
      '-metadata:s:a:0',
      'title=Dialogue',
      '-metadata:s:a:0',
      'handler_name=Dialogue',
      '-metadata:s:a:1',
      'title=Music',
      '-metadata:s:a:1',
      'handler_name=Music',
      '-metadata:s:a:2',
      'title=SFX',
      '-metadata:s:a:2',
      'handler_name=SFX',
      '/o/base_STEMS.mov'
    ])
  })
})
