/**
 * Headless separation pipeline: probe -> extract audio -> run worker ->
 * convert stems + conform the married mix -> optional multitrack .mov remux.
 * Mirrors the app's `src/main/job.ts` but writes to a temp job dir under the OS
 * tmpdir (no Electron userData) and never streams audio through the protocol —
 * paths in, paths out.
 */

import { type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, extname, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  extractAudioArgs,
  convertStemArgs,
  marriedMixArgs,
  remuxMultitrackArgs
} from './ffmpegArgs.js'
import { workerArgs } from './workerArgs.js'
import { runFfmpeg, probe } from './ffmpeg.js'
import { ffmpegPath, modelCacheDir, workerPythonPath } from './resolve.js'
import { runWorker, killTree } from './worker.js'
import {
  STEM_SUFFIX,
  MARRIED_SUFFIX,
  WORKER_TO_STEM,
  DEFAULT_ENGINE,
  DEFAULT_QUALITY,
  type StemKind,
  type PipelineStage,
  type SeparationOutputs
} from './types.js'

export interface SeparateParams {
  inputPath: string
  /** Output dir; defaults to the input's directory. */
  outputDir?: string
  quality?: string
  engine?: string
  /** Remux original video + stems into a multitrack .mov (video inputs only). */
  multitrackVideo?: boolean
  /** Optional post-separation pass to reduce music/effects bleed in dialogue. */
  polishDialogue?: boolean
}

export interface PipelineCallbacks {
  onStage?(stage: PipelineStage, percent: number, detail?: string): void
}

/** A running pipeline that can be cancelled (kills the worker, cleans temp). */
export interface PipelineHandle {
  result: Promise<SeparationOutputs>
  cancel(): void
}

/**
 * Kick off a separation. Returns a handle immediately; the caller awaits
 * `handle.result` for the delivery paths (or registers it for `check_job`).
 */
export function startSeparation(
  params: SeparateParams,
  cb: PipelineCallbacks = {},
  env: NodeJS.ProcessEnv = process.env
): PipelineHandle {
  let cancelled = false
  let worker: ChildProcess | undefined
  const jobDir = join(tmpdir(), 'stem-studio-mcp', randomUUID())

  const cancel = () => {
    cancelled = true
    killTree(worker)
    void rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
  const checkCancel = () => {
    if (cancelled) throw new Error('Cancelled')
  }

  const result = (async (): Promise<SeparationOutputs> => {
    const stage = (s: PipelineStage, pct: number, detail?: string) =>
      cb.onStage?.(s, pct, detail)
    try {
      await mkdir(jobDir, { recursive: true })

      const info = await probe(params.inputPath)
      checkCancel()
      const base = basename(params.inputPath, extname(params.inputPath))
      const outputDir = params.outputDir ?? dirname(params.inputPath)
      await mkdir(outputDir, { recursive: true })
      const ffmpeg = await ffmpegPath()

      // 1) Extract/normalize to engine-rate stereo WAV.
      stage('extracting', -1)
      const inputWav = join(jobDir, 'input.wav')
      await runFfmpeg(ffmpeg, extractAudioArgs(params.inputPath, inputWav))
      checkCancel()

      // 2) Run the worker; stream its line-JSON progress.
      const workerOut = join(jobDir, 'stems')
      await mkdir(workerOut, { recursive: true })
      const cacheDir = modelCacheDir(env)
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      const args = workerArgs({
        inputWav,
        outDir: workerOut,
        engine: params.engine ?? DEFAULT_ENGINE,
        quality: params.quality ?? DEFAULT_QUALITY,
        cacheDir,
        polishDialogue: params.polishDialogue
      })
      const py = workerPythonPath(env)
      const handle = runWorker(py, args, {
        env,
        isCancelled: () => cancelled,
        callbacks: {
          onProgress: (s, pct) => stage(s, pct)
        }
      })
      worker = handle.child
      const workerOutputs = await handle.result
      checkCancel()

      // 3) Convert each stem to 48 kHz / 24-bit delivery WAV.
      stage('writing', 0)
      const stems = {} as Record<StemKind, string>
      let done = 0
      const workerKeys = Object.keys(WORKER_TO_STEM)
      for (const workerKey of workerKeys) {
        const kind = WORKER_TO_STEM[workerKey]!
        const src = workerOutputs[workerKey]
        if (!src) throw new Error(`Worker did not produce stem "${workerKey}"`)
        const dest = join(outputDir, `${base}_${STEM_SUFFIX[kind]}.wav`)
        await runFfmpeg(ffmpeg, convertStemArgs(src, dest))
        stems[kind] = dest
        done++
        stage('writing', (done / (workerKeys.length + 1)) * 100)
        checkCancel()
      }

      // 3b) Deliver the conformed original mix (the "married" reference track).
      const married = join(outputDir, `${base}_${MARRIED_SUFFIX}.wav`)
      await runFfmpeg(ffmpeg, marriedMixArgs(params.inputPath, married))
      stage('writing', 100)
      checkCancel()

      // 4) Optional multitrack video remux (video inputs only).
      let multitrackVideo: string | undefined
      if (params.multitrackVideo && info.hasVideo) {
        stage('remuxing', -1)
        multitrackVideo = join(outputDir, `${base}_STEMS.mov`)
        await runFfmpeg(
          ffmpeg,
          remuxMultitrackArgs(params.inputPath, stems, multitrackVideo)
        )
        checkCancel()
      }

      await rm(jobDir, { recursive: true, force: true }).catch(() => {})
      stage('done', 100)
      return { stems, married, multitrackVideo, outputDir }
    } catch (err) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  })()

  return { result, cancel }
}
