/**
 * Types and constants shared across main, preload, and renderer. Keep this
 * DOM-free and Electron-free so it can be imported anywhere (and unit-tested
 * under Vitest/Node).
 */

/**
 * Sample rate the separation engine expects its input WAV at. The main
 * process normalizes every input to this rate before handing it to the
 * Python worker. Change here to re-target a future engine.
 */
export const ENGINE_SAMPLE_RATE = 44_100

/** Output stem WAV format. */
export const OUTPUT_SAMPLE_RATE = 48_000
export const OUTPUT_BIT_DEPTH = 24

/** Separation engine the worker runs. `tiger` is the real TIGER-DnR ML model;
 * `stub` is the dependency-light band-splitter (no torch). */
export type EngineName = 'tiger' | 'stub'
export const DEFAULT_ENGINE: EngineName = 'tiger'
/** Human label for the active engine, shown subtly in the UI. */
export const ENGINE_LABEL: Record<EngineName, string> = {
  tiger: 'TIGER-DnR',
  stub: 'Band-split (stub)'
}

/** Separation quality mode. `high` runs a slower test-time-augmentation
 * ensemble; `fast` is a single pass. */
export type QualityMode = 'fast' | 'high'

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm'] as const
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'aac', 'flac', 'm4a'] as const

/** The three stems, in canonical order. */
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

/** Result of probing an input file with ffprobe. */
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
  /** Container/codec label for display, e.g. "mov / aac". */
  format: string
}

/** Progress events streamed from the Python worker (line-JSON on stdout). */
export type WorkerStage = 'loading' | 'separating' | 'writing'

export type WorkerEvent =
  | { event: 'progress'; stage: WorkerStage; percent: number }
  | { event: 'done'; outputs: Record<string, string> }
  | { event: 'error'; message: string }

/** High-level pipeline stage reported to the renderer over IPC. */
export type PipelineStage =
  | 'extracting'
  | 'setup'
  | 'loading'
  | 'separating'
  | 'writing'
  | 'remuxing'

/** A single progress update pushed to the renderer during a job. */
export interface JobProgress {
  jobId: string
  stage: PipelineStage
  /** 0..100 within the current stage, or -1 if indeterminate. */
  percent: number
  /** Optional human detail (e.g. venv pip line). */
  detail?: string
}

/** Terminal success payload for a job. */
export interface JobResult {
  jobId: string
  /** Absolute paths to the three exported stem WAVs. */
  stems: Record<StemKind, string>
  /** Absolute path to the multitrack .mov, if one was produced. */
  multitrackVideo?: string
  /** Folder the outputs were written into. */
  outputDir: string
}

/** Terminal failure payload for a job. */
export interface JobError {
  jobId: string
  message: string
  /** Full detail for the "Copy details" button (stderr, args, etc.). */
  detail?: string
}

/** Options for a separation run. */
export interface SeparateOptions {
  inputPath: string
  /** Folder to write the stem WAVs (and .mov) into. */
  outputDir: string
  /** Remux original video + stems into a multitrack .mov. Video inputs only. */
  multitrackVideo: boolean
  /** Slower, higher-quality separation (test-time augmentation). Default false. */
  highQuality?: boolean
}

/** State of the Python environment, reported before/after setup. */
export interface PythonEnvStatus {
  ready: boolean
  /** Which venv is in use, if ready. */
  venvPath?: string
  /** Reason it is not ready, or the detected python for setup. */
  message?: string
}
