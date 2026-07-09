import { describe, it, expect } from 'vitest'
import { parseWorkerLine, LineParser } from '@shared/workerProtocol'

describe('parseWorkerLine', () => {
  it('parses a progress event and clamps percent', () => {
    expect(parseWorkerLine('{"event":"progress","stage":"separating","percent":42.5}')).toEqual({
      event: 'progress',
      stage: 'separating',
      percent: 42.5
    })
    expect(
      parseWorkerLine('{"event":"progress","stage":"loading","percent":250}')
    ).toEqual({ event: 'progress', stage: 'loading', percent: 100 })
    expect(
      parseWorkerLine('{"event":"progress","stage":"writing","percent":-5}')
    ).toEqual({ event: 'progress', stage: 'writing', percent: 0 })
  })

  it('rejects unknown stages and non-numeric percents', () => {
    expect(parseWorkerLine('{"event":"progress","stage":"bogus","percent":10}')).toBeNull()
    expect(parseWorkerLine('{"event":"progress","stage":"loading","percent":"x"}')).toBeNull()
  })

  it('parses done with string outputs only', () => {
    const ev = parseWorkerLine(
      '{"event":"done","outputs":{"dialogue":"/a.wav","music":"/b.wav","effects":"/c.wav","bad":5}}'
    )
    expect(ev).toEqual({
      event: 'done',
      outputs: { dialogue: '/a.wav', music: '/b.wav', effects: '/c.wav' }
    })
  })

  it('parses error, defaulting a missing message', () => {
    expect(parseWorkerLine('{"event":"error","message":"boom"}')).toEqual({
      event: 'error',
      message: 'boom'
    })
    expect(parseWorkerLine('{"event":"error"}')).toEqual({
      event: 'error',
      message: 'Unknown worker error'
    })
  })

  it('returns null for blank lines, junk, and unknown events', () => {
    expect(parseWorkerLine('')).toBeNull()
    expect(parseWorkerLine('   ')).toBeNull()
    expect(parseWorkerLine('not json')).toBeNull()
    expect(parseWorkerLine('{"event":"nope"}')).toBeNull()
    expect(parseWorkerLine('42')).toBeNull()
  })
})

describe('LineParser', () => {
  it('emits events per complete line and buffers partials', () => {
    const p = new LineParser()
    let out = p.push('{"event":"progress","stage":"loading","percent":10}\n{"event":"prog')
    expect(out).toEqual([{ event: 'progress', stage: 'loading', percent: 10 }])

    out = p.push('ress","stage":"separating","percent":50}\n')
    expect(out).toEqual([{ event: 'progress', stage: 'separating', percent: 50 }])
  })

  it('flushes a trailing newline-less line', () => {
    const p = new LineParser()
    expect(p.push('{"event":"done","outputs":{"dialogue":"/d.wav"}}')).toEqual([])
    expect(p.flush()).toEqual([{ event: 'done', outputs: { dialogue: '/d.wav' } }])
  })

  it('skips noise lines interleaved with events', () => {
    const p = new LineParser()
    const out = p.push('warming up\n{"event":"error","message":"x"}\n\n')
    expect(out).toEqual([{ event: 'error', message: 'x' }])
  })
})
