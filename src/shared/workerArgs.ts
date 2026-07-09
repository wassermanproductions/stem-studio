/**
 * Pure builder for the Python separation-worker argv. No spawning — just the
 * argument array, so it can be unit-tested. `src/main/job.ts` spawns it.
 */

import { DEFAULT_ENGINE, type EngineName, type QualityMode } from './types'

export interface WorkerArgsOptions {
  inputWav: string
  outDir: string
  /** Separation engine module to run. Defaults to the app default. */
  engine?: EngineName
  /** Quality mode; `high` runs a slower multi-pass ensemble. Defaults to `fast`. */
  quality?: QualityMode
  /** Model-weights cache dir. Omitted if not provided. */
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
  const quality: QualityMode = opts.quality ?? 'fast'
  const args = [
    '-m',
    'stemstudio_worker.separate',
    '--input',
    opts.inputWav,
    '--outdir',
    opts.outDir,
    '--engine',
    engine,
    '--quality',
    quality
  ]
  if (opts.cacheDir) args.push('--cache-dir', opts.cacheDir)
  if (opts.polishDialogue) args.push('--polish-dialogue')
  return args
}

/**
 * Build the argv for the worker's one-shot device probe:
 * `python -m stemstudio_worker.separate --probe [--cache-dir <dir>]`, which
 * prints a single JSON line (a {@link WorkerProbe}) and exits. Used by the main
 * process after setup to default the UI quality tier.
 */
export function probeWorkerArgs(cacheDir?: string): string[] {
  const args = ['-m', 'stemstudio_worker.separate', '--probe']
  if (cacheDir) args.push('--cache-dir', cacheDir)
  return args
}
