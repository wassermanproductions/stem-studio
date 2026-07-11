/**
 * Pure builder for the Python separation-worker argv. Mirrors the app's
 * `src/shared/workerArgs.ts` but does NOT hard-validate the engine/quality
 * public Windows schema. Legacy macOS/Linux and research-only MVSEP/Max are
 * represented in the internal types and gated by the server/worker runtime.
 */

import {
  DEFAULT_ENGINE,
  DEFAULT_QUALITY,
  type EngineName,
  type QualityMode
} from './types.js'

export interface WorkerArgsOptions {
  inputWav: string
  outDir: string
  /** Engine to run. Defaults to DEFAULT_ENGINE (tiger). */
  engine?: EngineName
  /** Quality mode. Defaults to `fast`. */
  quality?: QualityMode
  /** Model-weights cache dir (tiger only). Omitted if not provided. */
  cacheDir?: string
  /** Optional post-separation pass to reduce music/effects bleed in dialogue.
   * Adds `--polish-dialogue`. Off by default. */
  polishDialogue?: boolean
}

/**
 * Build the `python -m stemstudio_worker.separate ...` argv (without the python
 * executable itself). Order is stable so tests can assert on it.
 */
export function workerArgs(opts: WorkerArgsOptions): string[] {
  const engine = opts.engine ?? DEFAULT_ENGINE
  const quality = opts.quality ?? DEFAULT_QUALITY
  const args = [
    '-m',
    'stemstudio_worker.separate',
    '--input',
    opts.inputWav,
    '--outdir',
    opts.outDir,
    '--engine',
    String(engine),
    '--quality',
    String(quality)
  ]
  if (opts.cacheDir) args.push('--cache-dir', opts.cacheDir)
  if (opts.polishDialogue) args.push('--polish-dialogue')
  return args
}

/**
 * Build the argv for a worker device/readiness probe. The worker MAY grow a
 * `--probe` flag (a concurrent change); if it hasn't in this snapshot, callers
 * fall back to inline torch device detection (see setup.ts). Kept pure/testable.
 */
export function workerProbeArgs(): string[] {
  return ['-m', 'stemstudio_worker.separate', '--probe']
}
