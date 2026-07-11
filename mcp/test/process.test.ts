import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { trackProcess, waitForExit } from '../src/process.js'

describe('process close tracking', () => {
  it('does not treat exit as fully closed', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { exitCode: null, signalCode: null, pid: 42 })
    trackProcess(child)
    let resolved = false
    const waiting = waitForExit(child).then(() => { resolved = true })
    Object.defineProperty(child, 'exitCode', { value: 0, writable: true })
    child.emit('exit', 0, null)
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('close', 0, null)
    await waiting
    expect(resolved).toBe(true)
  })
})
