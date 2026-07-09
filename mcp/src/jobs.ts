/**
 * In-memory job registry + state machine for long-running tools (separation and
 * environment setup). Tracks status/stage/percent, terminal outputs or error,
 * and holds a cancel handle. The pure transition logic is unit-tested; the
 * process wiring lives in pipeline.ts / setup.ts, which call these mutators.
 *
 * Legal transitions:
 *   running --update(stage,percent)--> running
 *   running --finish(outputs)--------> done
 *   running --fail(message)----------> error
 *   running --cancel()---------------> cancelled
 * Terminal states (done/error/cancelled) are immutable — later updates no-op,
 * so a cancel that races a finish keeps whichever landed first.
 */

import { randomUUID } from 'node:crypto'
import type { JobStatus, PipelineStage } from './types.js'

export type JobKind = 'separate' | 'setup'

export interface JobSnapshot {
  jobId: string
  kind: JobKind
  status: JobStatus
  /** Current pipeline stage (best-effort; undefined before first update). */
  stage?: PipelineStage
  /** 0..100 within the current stage, or -1 if indeterminate. */
  percent: number
  /** Optional human detail (e.g. a pip line, a device note). */
  detail?: string
  /** Terminal success payload (shape depends on kind). */
  result?: unknown
  /** Terminal failure message. */
  error?: string
  createdAt: number
  updatedAt: number
}

export interface Job extends JobSnapshot {
  /** Kills the running work and marks the job cancelled. Set by the runner. */
  cancel?: () => void
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'done',
  'error',
  'cancelled'
])

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status)
}

/** A tiny registry; one instance is created per server process. */
export class JobRegistry {
  private jobs = new Map<string, Job>()

  /** Create a fresh running job and return it. */
  create(kind: JobKind): Job {
    const now = Date.now()
    const job: Job = {
      jobId: randomUUID(),
      kind,
      status: 'running',
      percent: -1,
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(job.jobId, job)
    return job
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId)
  }

  /** Public snapshot (no cancel fn) for a job, or null if unknown. */
  snapshot(jobId: string): JobSnapshot | null {
    const j = this.jobs.get(jobId)
    if (!j) return null
    const { cancel: _cancel, ...snap } = j
    return { ...snap }
  }

  /** Attach the cancel handle for a running job. */
  setCancel(jobId: string, cancel: () => void): void {
    const j = this.jobs.get(jobId)
    if (j && !isTerminal(j.status)) j.cancel = cancel
  }

  /** Progress update. No-op once the job is terminal. */
  update(
    jobId: string,
    patch: { stage?: PipelineStage; percent?: number; detail?: string }
  ): void {
    const j = this.jobs.get(jobId)
    if (!j || isTerminal(j.status)) return
    if (patch.stage !== undefined) j.stage = patch.stage
    if (patch.percent !== undefined) j.percent = patch.percent
    if (patch.detail !== undefined) j.detail = patch.detail
    j.updatedAt = Date.now()
  }

  /** Mark done with a result. No-op if already terminal. Returns success. */
  finish(jobId: string, result: unknown): boolean {
    const j = this.jobs.get(jobId)
    if (!j || isTerminal(j.status)) return false
    j.status = 'done'
    j.stage = 'done'
    j.percent = 100
    j.result = result
    j.detail = undefined
    j.updatedAt = Date.now()
    return true
  }

  /** Mark error. No-op if already terminal. Returns success. */
  fail(jobId: string, message: string): boolean {
    const j = this.jobs.get(jobId)
    if (!j || isTerminal(j.status)) return false
    j.status = 'error'
    j.error = message
    j.updatedAt = Date.now()
    return true
  }

  /**
   * Cancel a running job: invoke its cancel handle (if any) and mark cancelled.
   * Returns the resulting status ('cancelled', or the existing terminal status
   * if it already finished, or null if unknown).
   */
  cancel(jobId: string): JobStatus | null {
    const j = this.jobs.get(jobId)
    if (!j) return null
    if (isTerminal(j.status)) return j.status
    try {
      j.cancel?.()
    } catch {
      /* best effort */
    }
    j.status = 'cancelled'
    j.updatedAt = Date.now()
    return 'cancelled'
  }

  /** All snapshots (for diagnostics/tests). */
  all(): JobSnapshot[] {
    return [...this.jobs.values()].map(({ cancel: _c, ...s }) => ({ ...s }))
  }
}
