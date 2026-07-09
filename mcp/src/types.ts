/**
 * Constants and types the MCP server needs, mirrored from the app's
 * `src/shared/types.ts`. This package cannot import Electron/app code, so the
 * load-bearing contracts (sample rates, stem naming, engine names, the worker
 * JSON protocol) are re-declared here. Keep in sync with the app.
 */

/** Sample rate the separation engine expects its input WAV at (app: ENGINE_SAMPLE_RATE). */
export const ENGINE_SAMPLE_RATE = 44_100

/** Delivery WAV format (app: OUTPUT_SAMPLE_RATE / OUTPUT_BIT_DEPTH). */
export const OUTPUT_SAMPLE_RATE = 48_000
export const OUTPUT_BIT_DEPTH = 24

/**
 * Separation engines. `tiger` is the real TIGER-DnR ML model; `stub` is the
 * torch-free band-splitter. `mvsep` may be added by a concurrent worker change
 * and is passed through without hard validation — the worker is the authority.
 */
export type EngineName = 'tiger' | 'stub' | 'mvsep'
export const DEFAULT_ENGINE: EngineName = 'tiger'

/** Quality modes. `max` may be added by a concurrent worker change; passed through. */
export type QualityMode = 'fast' | 'high' | 'max'
export const DEFAULT_QUALITY: QualityMode = 'fast'

/** The three delivery stems, in canonical order. */
export const STEMS = ['dialogue', 'music', 'sfx'] as const
export type StemKind = (typeof STEMS)[number]

export const STEM_LABELS: Record<StemKind, string> = {
  dialogue: 'Dialogue',
  music: 'Music',
  sfx: 'SFX'
}

/** Filename suffix for each stem's exported WAV, e.g. `<basename>_DIALOGUE.wav`. */
export const STEM_SUFFIX: Record<StemKind, string> = {
  dialogue: 'DIALOGUE',
  music: 'MUSIC',
  sfx: 'SFX'
}

/** Suffix for the conformed original mix delivered alongside the stems. */
export const MARRIED_SUFFIX = 'MARRIED'

/** Maps a worker stem key (dialogue/music/effects) to the delivery StemKind. */
export const WORKER_TO_STEM: Record<string, StemKind> = {
  dialogue: 'dialogue',
  music: 'music',
  effects: 'sfx'
}

/** Worker stem keys, in canonical order, matching WORKER_TO_STEM. */
export const WORKER_STEM_KEYS = ['dialogue', 'music', 'effects'] as const

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm'] as const
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'aac', 'flac', 'm4a'] as const

/** Result of probing an input file with ffprobe (app: ProbeResult). */
export interface ProbeResult {
  path: string
  name: string
  /** Lowercased extension without the dot. */
  ext: string
  /** Seconds. */
  duration: number
  sampleRate: number
  channels: number
  hasVideo: boolean
  /** Container/codec label, e.g. "mov / aac". */
  format: string
}

/** Worker progress stages (app: WorkerStage). */
export type WorkerStage = 'loading' | 'separating' | 'writing'

/** Typed worker event parsed from line-JSON stdout (app: WorkerEvent). */
export type WorkerEvent =
  | { event: 'progress'; stage: WorkerStage; percent: number }
  | { event: 'done'; outputs: Record<string, string> }
  | { event: 'error'; message: string }

/** High-level pipeline stage reported to MCP clients. */
export type PipelineStage =
  | 'extracting'
  | 'setup'
  | 'loading'
  | 'separating'
  | 'writing'
  | 'remuxing'
  | 'done'

/** Terminal + in-flight job statuses for the job registry. */
export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

/** Delivery paths produced by a completed separation job. */
export interface SeparationOutputs {
  /** Absolute paths to the three delivery stem WAVs, by StemKind. */
  stems: Record<StemKind, string>
  /** Absolute path to the conformed original mix WAV (`<base>_MARRIED.wav`). */
  married: string
  /** Absolute path to the multitrack .mov, if one was produced. */
  multitrackVideo?: string
  /** Folder the outputs were written into. */
  outputDir: string
}
