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
import {
  defaultQualityForDevice,
  type ProbeResult,
  type JobProgress,
  type JobResult,
  type JobError,
  type PipelineStage,
  type QualityMode,
  type WorkerProbe
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
  'polishing',
  'writing',
  'remuxing'
]

export const STAGE_LABELS: Record<PipelineStage, string> = {
  extracting: 'Extracting audio',
  setup: 'Setting up environment',
  loading: 'Preparing engine',
  separating: 'Separating stems',
  polishing: 'Polishing dialogue',
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
    case 'polishing':
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
  /** Selected quality tier: `fast` | `high` | `max`. Defaulted from the probed
   * device (cuda→max, mps→high, cpu→fast) and user-adjustable. */
  quality: QualityMode
  /** Optional dialogue-polish pass: reduce residual music/effects bleed in the
   * voices. Off by default; a session preference (preserved across reset). */
  polishDialogue: boolean
  /** Device/engine probe result, once known. Null until probed. */
  probe: WorkerProbe | null

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
  setQuality(q: QualityMode): void
  setPolishDialogue(on: boolean): void
  /** Store the probe result and default the quality tier from its device
   * (unless the user has already changed it this session). */
  applyProbe(probe: WorkerProbe): void
  beginSeparate(): void
  applyProgress(p: JobProgress): void
  appendSetup(detail: string): void
  finishDone(result: JobResult): void
  finishError(err: JobError): void
  finishCancelled(): void
  reset(): void
}

// Session flag: has the user explicitly chosen a quality tier? Once true, a
// probe result won't override their choice. Not part of reactive state.
let userChoseQuality = false

export const useStore = create<StemStudioState>((set, get) => ({
  status: 'idle',
  input: null,
  outputDir: null,
  multitrackVideo: false,
  quality: 'fast',
  polishDialogue: false,
  probe: null,
  // Tracks whether the user has manually overridden the quality tier, so a
  // late-arriving probe doesn't clobber an explicit choice.
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

  setQuality: (q) => {
    userChoseQuality = true
    set({ quality: q })
  },

  setPolishDialogue: (on) => set({ polishDialogue: on }),

  applyProbe: (probe) =>
    set({
      probe,
      // Default the tier from the device unless the user already picked one.
      quality: userChoseQuality ? get().quality : defaultQualityForDevice(probe.device)
    }),

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

  reset: () => {
    // A full reset also clears the "user picked a quality" latch so a fresh
    // probe can re-default the tier. `quality`/`probe` values themselves are
    // preserved (session preferences).
    userChoseQuality = false
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
  }
}))
