import { describe, it, expect } from 'vitest'
import { workerArgs, probeWorkerArgs } from '@shared/workerArgs'
import { DEFAULT_ENGINE } from '@shared/types'

describe('workerArgs', () => {
  it('builds the module invocation with input/outdir and defaults', () => {
    const a = workerArgs({ inputWav: '/j/input.wav', outDir: '/j/stems' })
    expect(a.slice(0, 2)).toEqual(['-m', 'stemstudio_worker.separate'])
    expect(a).toEqual(expect.arrayContaining(['--input', '/j/input.wav']))
    expect(a).toEqual(expect.arrayContaining(['--outdir', '/j/stems']))
    // defaults: the app engine and fast quality
    expect(a).toEqual(expect.arrayContaining(['--engine', DEFAULT_ENGINE]))
    expect(a).toEqual(expect.arrayContaining(['--quality', 'fast']))
  })

  it('passes high quality when requested', () => {
    const a = workerArgs({ inputWav: '/i.wav', outDir: '/o', quality: 'high' })
    expect(a).toEqual(expect.arrayContaining(['--quality', 'high']))
  })

  it('includes the cache dir only when provided', () => {
    const withCache = workerArgs({
      inputWav: '/i.wav',
      outDir: '/o',
      cacheDir: '/data/models'
    })
    expect(withCache).toEqual(expect.arrayContaining(['--cache-dir', '/data/models']))

    const withoutCache = workerArgs({ inputWav: '/i.wav', outDir: '/o' })
    expect(withoutCache).not.toContain('--cache-dir')
  })

  it('honours an explicit engine override (stub)', () => {
    const a = workerArgs({ inputWav: '/i.wav', outDir: '/o', engine: 'stub' })
    expect(a).toEqual(expect.arrayContaining(['--engine', 'stub']))
  })

  it('supports the mvsep engine and max quality', () => {
    const a = workerArgs({
      inputWav: '/i.wav',
      outDir: '/o',
      engine: 'mvsep',
      quality: 'max'
    })
    expect(a).toEqual(expect.arrayContaining(['--engine', 'mvsep']))
    expect(a).toEqual(expect.arrayContaining(['--quality', 'max']))
  })
})

describe('probeWorkerArgs', () => {
  it('builds the --probe invocation', () => {
    const a = probeWorkerArgs()
    expect(a).toEqual(['-m', 'stemstudio_worker.separate', '--probe'])
  })

  it('includes the cache dir only when provided', () => {
    expect(probeWorkerArgs('/data/models')).toEqual([
      '-m',
      'stemstudio_worker.separate',
      '--probe',
      '--cache-dir',
      '/data/models'
    ])
    expect(probeWorkerArgs()).not.toContain('--cache-dir')
  })
})
