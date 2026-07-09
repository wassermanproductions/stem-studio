/**
 * Pure builder for the Python separation-worker argv. No spawning — just the
 * argument array, so it can be unit-tested. `src/main/job.ts` spawns it.
 */

import { DEFAULT_ENGINE, type EngineName, type QualityMode } from './types'

export interface WorkerArgsOptions {
  inputWav: string
  outDir: string
  /** Engine to run. Defaults to the app default (TIGER-DnR). */
  engine?: EngineName
  /** Quality mode; `high` runs the TTA ensemble. Defaults to `fast`. */
  quality?: QualityMode
  /** Model-weights cache dir (tiger only). Omitted if not provided. */
  cacheDir?: string
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
  return args
}
