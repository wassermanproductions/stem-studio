import { describe, it, expect, beforeEach } from 'vitest'
import {
  useStore,
  canSeparate,
  stageProgress,
  statusForStage,
  STAGE_ORDER
} from '@renderer/store'
import type { ProbeResult, JobResult } from '@shared/types'

const videoInput: ProbeResult = {
  path: '/movies/clip.mov',
  name: 'clip.mov',
  ext: 'mov',
  duration: 12,
  sampleRate: 48000,
  channels: 2,
  hasVideo: true,
  format: 'mov / aac'
}

const audioInput: ProbeResult = {
  ...videoInput,
  path: '/audio/song.wav',
  name: 'song.wav',
  ext: 'wav',
  hasVideo: false,
  format: 'wav / pcm_s16le'
}

beforeEach(() => useStore.getState().reset())

describe('canSeparate', () => {
  it('requires an input and an output folder', () => {
    expect(canSeparate('ready', false, true)).toBe(false)
    expect(canSeparate('ready', true, false)).toBe(false)
    expect(canSeparate('ready', true, true)).toBe(true)
  })
  it('allows a rerun from done/error/cancelled but not mid-flight', () => {
    for (const s of ['done', 'error', 'cancelled'] as const) {
      expect(canSeparate(s, true, true)).toBe(true)
    }
    for (const s of ['extracting', 'setup', 'separating', 'writing', 'idle'] as const) {
      expect(canSeparate(s, true, true)).toBe(false)
    }
  })
})

describe('statusForStage', () => {
  it('collapses fine stages to coarse statuses', () => {
    expect(statusForStage('extracting')).toBe('extracting')
    expect(statusForStage('setup')).toBe('setup')
    expect(statusForStage('loading')).toBe('separating')
    expect(statusForStage('separating')).toBe('separating')
    expect(statusForStage('polishing')).toBe('separating')
    expect(statusForStage('writing')).toBe('writing')
    expect(statusForStage('remuxing')).toBe('writing')
  })
})

describe('stageProgress', () => {
  it('is 0 at the first stage start and 1 at the last stage end', () => {
    expect(stageProgress('extracting', 0)).toBeCloseTo(0)
    expect(stageProgress('remuxing', 100)).toBeCloseTo(1)
  })
  it('treats indeterminate (-1) as the stage start', () => {
    const idx = STAGE_ORDER.indexOf('separating')
    expect(stageProgress('separating', -1)).toBeCloseTo(idx / STAGE_ORDER.length)
  })
  it('interpolates within a stage', () => {
    const idx = STAGE_ORDER.indexOf('writing')
    expect(stageProgress('writing', 50)).toBeCloseTo((idx + 0.5) / STAGE_ORDER.length)
  })
})

describe('store state machine', () => {
  it('idle -> ready on setInput, defaulting multitrack for video', () => {
    useStore.getState().setInput(videoInput, '/out')
    const s = useStore.getState()
    expect(s.status).toBe('ready')
    expect(s.multitrackVideo).toBe(true)
    expect(s.outputDir).toBe('/out')
  })

  it('leaves multitrack off for audio input', () => {
    useStore.getState().setInput(audioInput, '/out')
    expect(useStore.getState().multitrackVideo).toBe(false)
  })

  it('ready -> extracting -> separating -> writing -> done', () => {
    const st = useStore.getState()
    st.setInput(videoInput, '/out')
    st.beginSeparate('j1')
    expect(useStore.getState().status).toBe('extracting')
    expect(useStore.getState().currentJobId).toBe('j1')

    st.applyProgress({ jobId: 'j1', stage: 'separating', percent: 40 })
    expect(useStore.getState().status).toBe('separating')
    expect(useStore.getState().currentJobId).toBe('j1')

    st.applyProgress({ jobId: 'j1', stage: 'writing', percent: 66 })
    expect(useStore.getState().status).toBe('writing')

    const result: JobResult = {
      jobId: 'j1',
      stems: { dialogue: '/o/d.wav', music: '/o/m.wav', sfx: '/o/s.wav' },
      marriedMix: '/o/CLIP_MARRIED.wav',
      outputDir: '/out'
    }
    st.finishDone(result)
    expect(useStore.getState().status).toBe('done')
    expect(useStore.getState().result).toEqual(result)
  })

  it('captures errors with detail', () => {
    const st = useStore.getState()
    st.setInput(videoInput, '/out')
    st.beginSeparate('j1')
    st.finishError({ jobId: 'j1', message: 'worker died', detail: 'stack…' })
    expect(useStore.getState().status).toBe('error')
    expect(useStore.getState().error?.message).toBe('worker died')
  })

  it('handles cancellation', () => {
    const st = useStore.getState()
    st.setInput(videoInput, '/out')
    st.beginSeparate('j1')
    st.finishCancelled()
    expect(useStore.getState().status).toBe('cancelled')
    expect(useStore.getState().currentJobId).toBeNull()
  })

  it('accumulates then trims the setup log', () => {
    const st = useStore.getState()
    for (let i = 0; i < 250; i++) st.appendSetup(`line ${i}`)
    const log = useStore.getState().setupLog
    expect(log.length).toBeLessThanOrEqual(201)
    expect(log[log.length - 1]).toBe('line 249')
  })

  it('defaults quality to fast and lets the user change it', () => {
    expect(useStore.getState().quality).toBe('fast')
    useStore.getState().setQuality('high')
    expect(useStore.getState().quality).toBe('high')
  })

  it('preserves the quality preference across setInput and reset', () => {
    const st = useStore.getState()
    st.setQuality('high')
    st.setInput(videoInput, '/out')
    expect(useStore.getState().quality).toBe('high')
    st.reset()
    expect(useStore.getState().quality).toBe('high')
  })

  it('defaults polishDialogue off and lets the user toggle it', () => {
    expect(useStore.getState().polishDialogue).toBe(false)
    useStore.getState().setPolishDialogue(true)
    expect(useStore.getState().polishDialogue).toBe(true)
  })

  it('preserves the polishDialogue preference across setInput and reset', () => {
    const st = useStore.getState()
    st.setPolishDialogue(true)
    st.setInput(videoInput, '/out')
    expect(useStore.getState().polishDialogue).toBe(true)
    st.reset()
    expect(useStore.getState().polishDialogue).toBe(true)
  })

  it('applyProbe defaults CUDA to High when Max is unavailable', () => {
    useStore.getState().applyProbe({
      device: 'cuda',
      cuda: true,
      mps: false,
      torch: '2.6.0',
      engines: ['tiger'],
      qualities: ['fast', 'high']
    })
    expect(useStore.getState().quality).toBe('high')
    expect(useStore.getState().probe?.device).toBe('cuda')
  })

  it("applyProbe does not override the user's explicit quality choice", () => {
    const st = useStore.getState()
    st.setQuality('fast')
    st.applyProbe({
      device: 'cuda',
      cuda: true,
      mps: false,
      torch: '2.6.0',
      engines: ['tiger', 'mvsep', 'stub'],
      qualities: ['fast', 'high', 'max']
    })
    expect(useStore.getState().quality).toBe('fast')
  })
})
