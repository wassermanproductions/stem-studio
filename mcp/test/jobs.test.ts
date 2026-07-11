import { describe, it, expect } from 'vitest'
import { JobRegistry, isTerminal } from '../src/jobs.js'

describe('isTerminal', () => {
  it('classifies terminal vs running', () => {
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('error')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
  })
})

describe('JobRegistry', () => {
  it('creates a running job with an indeterminate percent', () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    expect(j.status).toBe('running')
    expect(j.percent).toBe(-1)
    expect(r.snapshot(j.jobId)?.kind).toBe('separate')
  })

  it('records progress updates', () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    r.update(j.jobId, { stage: 'separating', percent: 40, detail: 'x' })
    const s = r.snapshot(j.jobId)!
    expect(s.stage).toBe('separating')
    expect(s.percent).toBe(40)
    expect(s.detail).toBe('x')
  })

  it('finish() -> done with result and 100%', () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    expect(r.finish(j.jobId, { stems: {} })).toBe(true)
    const s = r.snapshot(j.jobId)!
    expect(s.status).toBe('done')
    expect(s.percent).toBe(100)
    expect(s.result).toEqual({ stems: {} })
  })

  it('fail() -> error with a message', () => {
    const r = new JobRegistry()
    const j = r.create('setup')
    expect(r.fail(j.jobId, 'boom')).toBe(true)
    const s = r.snapshot(j.jobId)!
    expect(s.status).toBe('error')
    expect(s.error).toBe('boom')
  })

  it('terminal states are immutable: updates and re-finish no-op', () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    r.finish(j.jobId, { a: 1 })
    r.update(j.jobId, { percent: 5 })
    expect(r.fail(j.jobId, 'late')).toBe(false)
    expect(r.finish(j.jobId, { a: 2 })).toBe(false)
    const s = r.snapshot(j.jobId)!
    expect(s.status).toBe('done')
    expect(s.percent).toBe(100)
    expect(s.result).toEqual({ a: 1 })
  })

  it('cancel() awaits the handle before marking cancelled', async () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    let killed = false
    r.setCancel(j.jobId, async () => {
      await Promise.resolve()
      killed = true
    })
    expect(await r.cancel(j.jobId)).toBe('cancelled')
    expect(killed).toBe(true)
    expect(r.snapshot(j.jobId)?.status).toBe('cancelled')
  })

  it('cancel() after done returns the existing terminal status, no re-cancel', async () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    r.finish(j.jobId, {})
    let killed = false
    r.setCancel(j.jobId, async () => {
      killed = true
    })
    expect(await r.cancel(j.jobId)).toBe('done')
    expect(killed).toBe(false)
  })

  it('unknown ids: snapshot null, cancel null', async () => {
    const r = new JobRegistry()
    expect(r.snapshot('nope')).toBeNull()
    expect(await r.cancel('nope')).toBeNull()
  })

  it('snapshot omits the cancel handle', () => {
    const r = new JobRegistry()
    const j = r.create('separate')
    r.setCancel(j.jobId, async () => {})
    const s = r.snapshot(j.jobId)!
    expect('cancel' in s).toBe(false)
  })
})
