/**
 * Application state (zustand). Models the job as a state machine:
 *
 *   idle → ready → extracting → setup(first-run) → separating → writing
 *        → done | error | cancelled
 *
 * (loading/remuxing map onto the "separating"/"writing" phases for the UI.)
 * The pure transition helpers (canSeparate, stageProgress, STAGE_ORDER) are
 * exported for unit testing without React.
 */

import { create } from 'zustand'
import type {
  ProbeResult,
  JobProgress,
  JobResult,
  JobError,
  PipelineStage
} from '@shared/types'

export type JobStatus =
  | 'idle'
  | 'ready'
  | 'extracting'
  | 'setup'
  | 'separating'
  | 'writing'
  | 'done'
  | 'error'
  | 'cancelled'

/** Ordered pipeline stages for the progress UI, with display labels. */
export const STAGE_ORDER: PipelineStage[] = [
  'extracting',
  'setup',
  'loading',
  'separating',
  'writing',
  'remuxing'
]

export const STAGE_LABELS: Record<PipelineStage, string> = {
  extracting: 'Extracting audio',
  setup: 'Setting up Python',
  loading: 'Loading model',
  separating: 'Separating stems',
  writing: 'Writing stems',
  remuxing: 'Building multitrack video'
}

/** Map a fine-grained pipeline stage to the coarse job status. */
export function statusForStage(stage: PipelineStage): JobStatus {
  switch (stage) {
    case 'extracting':
      return 'extracting'
    case 'setup':
      return 'setup'
    case 'loading':
    case 'separating':
      return 'separating'
    case 'writing':
    case 'remuxing':
      return 'writing'
  }
}

/** Whether a Separate run may start from the current status. */
export function canSeparate(status: JobStatus, hasInput: boolean, hasOutput: boolean): boolean {
  if (!hasInput || !hasOutput) return false
  return status === 'ready' || status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * Overall 0..1 progress across the whole pipeline, given the current stage
 * and its local percent (-1 = indeterminate → treated as stage start).
 * Uses equal weighting across the (input-appropriate) stages.
 */
export function stageProgress(
  stage: PipelineStage,
  percent: number,
  stages: PipelineStage[] = STAGE_ORDER
): number {
  const idx = stages.indexOf(stage)
  if (idx < 0) return 0
  const local = percent < 0 ? 0 : Math.max(0, Math.min(100, percent)) / 100
  return (idx + local) / stages.length
}

interface StemStudioState {
  status: JobStatus
  input: ProbeResult | null
  outputDir: string | null
  multitrackVideo: boolean
  /** Slower, higher-quality separation (test-time augmentation). Default off. */
  highQuality: boolean

  stage: PipelineStage | null
  stagePercent: number
  setupLog: string[]

  result: JobResult | null
  error: JobError | null

  currentJobId: string | null

  // actions
  setInput(info: ProbeResult, outputDir: string): void
  setOutputDir(dir: string): void
  setMultitrackVideo(on: boolean): void
  setHighQuality(on: boolean): void
  beginSeparate(): void
  applyProgress(p: JobProgress): void
  appendSetup(detail: string): void
  finishDone(result: JobResult): void
  finishError(err: JobError): void
  finishCancelled(): void
  reset(): void
}

export const useStore = create<StemStudioState>((set, get) => ({
  status: 'idle',
  input: null,
  outputDir: null,
  multitrackVideo: false,
  highQuality: false,
  stage: null,
  stagePercent: -1,
  setupLog: [],
  result: null,
  error: null,
  currentJobId: null,

  setInput: (info, outputDir) =>
    set({
      input: info,
      outputDir,
      // Multitrack only meaningful for video; default it on for video inputs.
      multitrackVideo: info.hasVideo,
      status: 'ready',
      stage: null,
      stagePercent: -1,
      result: null,
      error: null,
      setupLog: []
    }),

  setOutputDir: (dir) => set({ outputDir: dir }),

  setMultitrackVideo: (on) => set({ multitrackVideo: on }),

  setHighQuality: (on) => set({ highQuality: on }),

  beginSeparate: () =>
    set({
      status: 'extracting',
      stage: 'extracting',
      stagePercent: -1,
      result: null,
      error: null,
      setupLog: []
    }),

  applyProgress: (p) =>
    set({
      status: statusForStage(p.stage),
      stage: p.stage,
      stagePercent: p.percent,
      currentJobId: p.jobId
    }),

  appendSetup: (detail) => set({ setupLog: [...get().setupLog.slice(-200), detail] }),

  finishDone: (result) =>
    set({ status: 'done', result, stage: null, currentJobId: null }),

  finishError: (err) => set({ status: 'error', error: err, currentJobId: null }),

  finishCancelled: () =>
    set({ status: 'cancelled', stage: null, stagePercent: -1, currentJobId: null }),

  reset: () =>
    // Note: `highQuality` is a user preference and is intentionally preserved
    // across reset (it is not cleared here).
    set({
      status: 'idle',
      input: null,
      outputDir: null,
      multitrackVideo: false,
      stage: null,
      stagePercent: -1,
      setupLog: [],
      result: null,
      error: null,
      currentJobId: null
    })
}))
