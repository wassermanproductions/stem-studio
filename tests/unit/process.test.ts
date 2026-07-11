import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it } from 'vitest'
import { trackProcess, waitForExit } from '../../src/main/process'

describe('process close tracking', () => {
  it('waits for close after exit has already fired', async () => {
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
