/**
 * Job orchestration: extract audio -> (setup venv) -> run Python worker ->
 * convert stems to delivery WAVs -> (optionally) remux multitrack .mov.
 * Progress is streamed via callbacks; supports cancellation (kills the worker
 * process tree and cleans the job dir).
 */

import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { mkdir, rm } from 'fs/promises'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'

import {
  extractAudioArgs,
  convertStemArgs,
  remuxMultitrackArgs
} from '../shared/ffmpegArgs'
import {
  STEM_SUFFIX,
  type StemKind,
  type SeparateOptions,
  type JobProgress,
  type JobResult
} from '../shared/types'
import { ffmpegPath, runFfmpeg, probe } from './ffmpeg'
import { findReadyPython, setupUserVenv, workerRoot } from './pythonEnv'
import { LineParser } from '../shared/workerProtocol'

/** Maps a worker stem key to the delivery StemKind. */
const WORKER_TO_STEM: Record<string, StemKind> = {
  dialogue: 'dialogue',
  music: 'music',
  effects: 'sfx'
}

export interface JobHandle {
  id: string
  cancel(): void
}

interface RunCallbacks {
  onProgress(p: JobProgress): void
  /** Called when first-run setup begins/streams (renderer shows setup screen). */
  onSetup(detail: string): void
}

/** Live jobs, so cancel() can reach the child process. */
const active = new Map<string, { child?: ChildProcess; cancelled: boolean; dir: string }>()

export function cancelJob(jobId: string): void {
  const rec = active.get(jobId)
  if (!rec) return
  rec.cancelled = true
  if (rec.child && rec.child.pid) {
    try {
      // Negative pid kills the process group (worker + children).
      process.kill(-rec.child.pid, 'SIGKILL')
    } catch {
      try {
        rec.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  void rm(rec.dir, { recursive: true, force: true }).catch(() => {})
  active.delete(jobId)
}

/**
 * Run a full separation job. Returns the JobResult on success; throws on
 * failure or cancellation.
 */
export async function runJob(
  opts: SeparateOptions,
  cb: RunCallbacks
): Promise<JobResult> {
  const jobId = randomUUID()
  const jobDir = join(app.getPath('userData'), 'jobs', jobId)
  const rec = { child: undefined as ChildProcess | undefined, cancelled: false, dir: jobDir }
  active.set(jobId, rec)

  const checkCancel = () => {
    if (rec.cancelled) throw new Error('Cancelled')
  }

  try {
    await mkdir(jobDir, { recursive: true })

    const info = await probe(opts.inputPath)
    const base = basename(opts.inputPath, extname(opts.inputPath))
    const ffmpeg = await ffmpegPath()

    // 1) Extract/normalize to engine-rate stereo WAV.
    cb.onProgress({ jobId, stage: 'extracting', percent: -1 })
    const inputWav = join(jobDir, 'input.wav')
    await runFfmpeg(ffmpeg, extractAudioArgs(opts.inputPath, inputWav))
    checkCancel()

    // 2) Ensure a Python venv is ready (first-run setup if needed).
    let py = await findReadyPython()
    if (!py) {
      cb.onProgress({ jobId, stage: 'setup', percent: -1 })
      py = await setupUserVenv((detail) => {
        cb.onSetup(detail)
        cb.onProgress({ jobId, stage: 'setup', percent: -1, detail })
      })
    }
    checkCancel()

    // 3) Run the worker; stream its line-JSON progress.
    const workerOut = join(jobDir, 'stems')
    await mkdir(workerOut, { recursive: true })
    const workerOutputs = await runWorker(jobId, py, inputWav, workerOut, rec, cb)
    checkCancel()

    // 4) Convert each stem to 48 kHz / 24-bit delivery WAV.
    cb.onProgress({ jobId, stage: 'writing', percent: 0 })
    await mkdir(opts.outputDir, { recursive: true })
    const stems = {} as Record<StemKind, string>
    let done = 0
    for (const workerKey of Object.keys(WORKER_TO_STEM)) {
      const kind = WORKER_TO_STEM[workerKey]!
      const src = workerOutputs[workerKey]
      if (!src) throw new Error(`Worker did not produce stem "${workerKey}"`)
      const dest = join(opts.outputDir, `${base}_${STEM_SUFFIX[kind]}.wav`)
      await runFfmpeg(ffmpeg, convertStemArgs(src, dest))
      stems[kind] = dest
      done++
      cb.onProgress({ jobId, stage: 'writing', percent: (done / 3) * 100 })
      checkCancel()
    }

    // 5) Optional multitrack video remux (video inputs only).
    let multitrackVideo: string | undefined
    if (opts.multitrackVideo && info.hasVideo) {
      cb.onProgress({ jobId, stage: 'remuxing', percent: -1 })
      multitrackVideo = join(opts.outputDir, `${base}_STEMS.mov`)
      await runFfmpeg(
        ffmpeg,
        remuxMultitrackArgs(opts.inputPath, stems, multitrackVideo)
      )
      checkCancel()
    }

    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    active.delete(jobId)

    return { jobId, stems, multitrackVideo, outputDir: opts.outputDir }
  } catch (err) {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    active.delete(jobId)
    throw err
  }
}

/** Spawn the Python worker and resolve with its `done` outputs map. */
function runWorker(
  jobId: string,
  py: string,
  inputWav: string,
  outDir: string,
  rec: { child?: ChildProcess; cancelled: boolean },
  cb: RunCallbacks
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      py,
      ['-m', 'stemstudio_worker.separate', '--input', inputWav, '--outdir', outDir],
      {
        cwd: workerRoot(),
        // Put the worker package on the path and run it in its own process
        // group so cancel can kill the whole tree.
        env: { ...process.env, PYTHONPATH: workerRoot(), PYTHONUNBUFFERED: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    rec.child = child

    const parser = new LineParser()
    let stderr = ''
    let outputs: Record<string, string> | null = null
    let workerError: string | null = null

    child.stdout.on('data', (buf: Buffer) => {
      for (const ev of parser.push(buf.toString())) {
        if (ev.event === 'progress') {
          cb.onProgress({ jobId, stage: ev.stage, percent: ev.percent })
        } else if (ev.event === 'done') {
          outputs = ev.outputs
        } else if (ev.event === 'error') {
          workerError = ev.message
        }
      }
    })
    child.stderr.on('data', (b) => {
      stderr += b.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      for (const ev of parser.flush()) {
        if (ev.event === 'done') outputs = ev.outputs
        else if (ev.event === 'error') workerError = ev.message
      }
      if (rec.cancelled) return reject(new Error('Cancelled'))
      if (workerError) return reject(new Error(workerError))
      if (code !== 0) {
        return reject(
          new Error(`Worker exited ${code}${stderr ? `\n${stderr.slice(-4000)}` : ''}`)
        )
      }
      if (!outputs) return reject(new Error('Worker finished without a result'))
      resolve(outputs)
    })
  })
}
