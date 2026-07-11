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

/** Internal worker engines. The app itself always invokes licensed TIGER;
 * `stub` exists solely for the repository test harness. */
export type EngineName = 'tiger' | 'stub'
export const DEFAULT_ENGINE: EngineName = 'tiger'
/** Human label for the active engine, if surfaced in the UI. */
export const ENGINE_LABEL: Record<EngineName, string> = {
  tiger: 'Neural separation engine',
  stub: 'Band-split (stub)'
}

/** Separation quality mode.
 * - `fast` — a single quick pass.
 * - `high` — a slower multi-pass ensemble, better separation.
 */
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

/** Filename suffix for the conformed full-mix WAV, e.g. `<basename>_MARRIED.wav`. */
export const MARRIED_SUFFIX = 'MARRIED'

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

/** Progress events streamed from the Python worker (line-JSON on stdout).
 * `polishing` is emitted only when the optional dialogue-polish pass runs. */
export type WorkerStage = 'loading' | 'separating' | 'polishing' | 'writing'

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
  | 'polishing'
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
  /** Absolute path to the `<basename>_MARRIED.wav` — the full original mix
   * conformed to the same delivery spec as the stems (48 kHz / 24-bit). */
  marriedMix: string
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
  /** Quality tier: `fast` | `high`. Takes precedence over `highQuality`. */
  quality?: QualityMode
  /** Legacy toggle: slower TTA (`high`) when true. Superseded by `quality`. */
  highQuality?: boolean
  /** Optional post-separation pass that reduces residual music/effects bleed in
   * the dialogue stem. Slower. Off by default. */
  polishDialogue?: boolean
}

/** Resolve the effective quality tier from a SeparateOptions. `quality` wins;
 * otherwise the legacy `highQuality` boolean maps to `high`/`fast`. */
export function resolveQuality(opts: {
  quality?: QualityMode
  highQuality?: boolean
}): QualityMode {
  if (opts.quality) return opts.quality
  return opts.highQuality ? 'high' : 'fast'
}

/** One-line result of `separate.py --probe`: what the worker's torch/device
 * stack looks like. Used to default the quality selector. */
export interface WorkerProbe {
  /** The device the engines will run on: cuda > mps > cpu. */
  device: 'cuda' | 'mps' | 'cpu'
  cuda: boolean
  mps: boolean
  /** torch version string, or null if torch is unavailable. */
  torch: string | null
  /** Engines available in this worker build. */
  engines: EngineName[]
}

/** Map a probed device to the public quality tier default. */
export function defaultQualityForDevice(device: WorkerProbe['device']): QualityMode {
  if (device === 'cuda' || device === 'mps') return 'high'
  return 'fast'
}

/** Platform/app labels exposed by preload without granting Node access. */
export interface PlatformInfo {
  platform: 'mac' | 'windows' | 'linux'
  appName: string
  showInFolderLabel: string
  isCommunityBuild: boolean
  /** Optional derivative-build credit injected by packaging metadata. */
  maintainerCredit?: string
}

/** State of the Python environment, reported before/after setup. */
export interface PythonEnvStatus {
  ready: boolean
  /** Which venv is in use, if ready. */
  venvPath?: string
  /** Reason it is not ready, or the detected python for setup. */
  message?: string
}
