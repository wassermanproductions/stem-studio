import { describe, it, expect } from 'vitest'
import { parseWorkerLine, LineParser } from '../src/workerProtocol.js'

describe('parseWorkerLine', () => {
  it('parses a progress event and clamps percent', () => {
    expect(
      parseWorkerLine('{"event":"progress","stage":"separating","percent":150}')
    ).toEqual({ event: 'progress', stage: 'separating', percent: 100 })
  })

  it('rejects unknown stages', () => {
    expect(
      parseWorkerLine('{"event":"progress","stage":"bogus","percent":10}')
    ).toBeNull()
  })

  it('parses a done event keeping only string outputs', () => {
    expect(
      parseWorkerLine(
        '{"event":"done","outputs":{"dialogue":"/d.wav","music":"/m.wav","effects":"/e.wav","junk":5}}'
      )
    ).toEqual({
      event: 'done',
      outputs: { dialogue: '/d.wav', music: '/m.wav', effects: '/e.wav' }
    })
  })

  it('parses an error event with a fallback message', () => {
    expect(parseWorkerLine('{"event":"error"}')).toEqual({
      event: 'error',
      message: 'Unknown worker error'
    })
  })

  it('ignores blank lines and non-JSON noise', () => {
    expect(parseWorkerLine('')).toBeNull()
    expect(parseWorkerLine('loading model...')).toBeNull()
    expect(parseWorkerLine('{"event":"other"}')).toBeNull()
  })
})

describe('LineParser', () => {
  it('reassembles events split across chunks', () => {
    const p = new LineParser()
    expect(p.push('{"event":"progress","stage":"loa')).toEqual([])
    const evs = p.push('ding","percent":42}\n{"event":"progress","stage":"writing","percent":10}\n')
    expect(evs).toEqual([
      { event: 'progress', stage: 'loading', percent: 42 },
      { event: 'progress', stage: 'writing', percent: 10 }
    ])
  })

  it('flushes a trailing newline-less line', () => {
    const p = new LineParser()
    p.push('{"event":"done",')
    expect(p.push('"outputs":{"dialogue":"/d.wav"}}')).toEqual([])
    expect(p.flush()).toEqual([
      { event: 'done', outputs: { dialogue: '/d.wav' } }
    ])
  })

  it('drops interleaved noise lines but keeps events', () => {
    const p = new LineParser()
    const evs = p.push(
      'starting up\n{"event":"progress","stage":"separating","percent":5}\nrandom\n'
    )
    expect(evs).toEqual([{ event: 'progress', stage: 'separating', percent: 5 }])
  })
})
