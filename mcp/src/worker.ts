/**
 * Spawns the Python separation worker and parses its line-JSON stdout. Mirrors
 * the app's `src/main/job.ts` runWorker: detached process group so the whole
 * tree can be killed on cancel, PYTHONPATH pointed at <repo>/python.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { LineParser } from './workerProtocol.js'
import { workerRoot } from './resolve.js'
import type { WorkerStage } from './types.js'
import { childSpawnOptions, killTree, trackProcess } from './process.js'

export interface WorkerRunHandle {
  /** The spawned child, so callers can register it for cancellation. */
  child: ChildProcess
  /** Resolves with the worker's `done` outputs map, rejects on error/nonzero. */
  result: Promise<Record<string, string>>
}

export interface WorkerRunCallbacks {
  onProgress?(stage: WorkerStage, percent: number): void
}

/**
 * Spawn `python <workerArgs>` with the worker on PYTHONPATH. Returns the child
 * plus a promise for its outputs. `isCancelled` lets the caller signal a cancel
 * so a killed process reports as cancelled rather than a spurious failure.
 */
export function runWorker(
  py: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv
    isCancelled?: () => boolean
    callbacks?: WorkerRunCallbacks
  } = {}
): WorkerRunHandle {
  const root = workerRoot(opts.env ?? process.env)
  const child = trackProcess(spawn(
    py,
    args,
    childSpawnOptions({
      cwd: root,
      env: {
        ...(opts.env ?? process.env),
        PYTHONPATH: root,
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  ))

  const result = new Promise<Record<string, string>>((resolve, reject) => {
    const parser = new LineParser()
    let stderr = ''
    let outputs: Record<string, string> | null = null
    let workerError: string | null = null

    child.stdout?.on('data', (buf: Buffer) => {
      for (const ev of parser.push(buf.toString())) {
        if (ev.event === 'progress') {
          opts.callbacks?.onProgress?.(ev.stage, ev.percent)
        } else if (ev.event === 'done') {
          outputs = ev.outputs
        } else if (ev.event === 'error') {
          workerError = ev.message
        }
      }
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      for (const ev of parser.flush()) {
        if (ev.event === 'done') outputs = ev.outputs
        else if (ev.event === 'error') workerError = ev.message
      }
      if (opts.isCancelled?.()) return reject(new Error('Cancelled'))
      if (workerError) return reject(new Error(workerError))
      if (code !== 0) {
        return reject(
          new Error(
            `Worker exited ${code}${stderr ? `\n${stderr.slice(-4000)}` : ''}`
          )
        )
      }
      if (!outputs) return reject(new Error('Worker finished without a result'))
      resolve(outputs)
    })
  })

  return { child, result }
}

/** Kill a spawned child's whole process group (detached => negative pid). */
export { killTree }
