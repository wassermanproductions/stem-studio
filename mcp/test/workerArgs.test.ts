// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
import { describe, it, expect } from 'vitest'
import { workerArgs, workerProbeArgs } from '../src/workerArgs.js'

describe('workerArgs', () => {
  it('defaults engine to tiger and quality to fast', () => {
    expect(workerArgs({ inputWav: '/i.wav', outDir: '/o' })).toEqual([
      '-m',
      'stemstudio_worker.separate',
      '--input',
      '/i.wav',
      '--outdir',
      '/o',
      '--engine',
      'tiger',
      '--quality',
      'fast'
    ])
  })

  it('appends --cache-dir only when provided', () => {
    const args = workerArgs({
      inputWav: '/i.wav',
      outDir: '/o',
      engine: 'stub',
      cacheDir: '/c/models'
    })
    expect(args).toContain('--cache-dir')
    expect(args[args.indexOf('--cache-dir') + 1]).toBe('/c/models')
    expect(args[args.indexOf('--engine') + 1]).toBe('stub')
  })

  it('passes the test-only stub engine and high quality', () => {
    const args = workerArgs({
      inputWav: '/i.wav',
      outDir: '/o',
      engine: 'stub',
      quality: 'high'
    })
    expect(args[args.indexOf('--engine') + 1]).toBe('stub')
    expect(args[args.indexOf('--quality') + 1]).toBe('high')
  })

  it('adds --polish-dialogue only when requested', () => {
    expect(
      workerArgs({ inputWav: '/i.wav', outDir: '/o', polishDialogue: true })
    ).toContain('--polish-dialogue')
    expect(
      workerArgs({ inputWav: '/i.wav', outDir: '/o', polishDialogue: false })
    ).not.toContain('--polish-dialogue')
    expect(workerArgs({ inputWav: '/i.wav', outDir: '/o' })).not.toContain(
      '--polish-dialogue'
    )
  })
})

describe('workerProbeArgs', () => {
  it('builds the --probe invocation', () => {
    expect(workerProbeArgs()).toEqual(['-m', 'stemstudio_worker.separate', '--probe'])
  })
})
