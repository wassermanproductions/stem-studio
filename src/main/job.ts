// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
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

import {
  extractAudioArgs,
  convertStemArgs,
  marriedMixArgs,
  remuxMultitrackArgs
} from '../shared/ffmpegArgs'
import { workerArgs, probeWorkerArgs } from '../shared/workerArgs'
import {
  STEM_SUFFIX,
  MARRIED_SUFFIX,
  DEFAULT_ENGINE,
  productionQualitiesForPlatform,
  resolveQuality,
  type AppPlatform,
  type QualityMode,
  type StemKind,
  type SeparateOptions,
  type JobProgress,
  type JobResult,
  type WorkerProbe
} from '../shared/types'
import { ffmpegPath, runFfmpeg, probe } from './ffmpeg'
import { findReadyPython, setupUserVenv, workerRoot } from './pythonEnv'
import { LineParser } from '../shared/workerProtocol'
import { childSpawnOptions, terminateProcessTree, trackProcess } from './process'
import {
  cleanupStagedDeliveries,
  promoteStagedDeliveries,
  stagedDeliveryPath,
  type StagedDelivery
} from '../shared/atomicDeliveries'

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
interface ActiveJob {
  children: Set<ChildProcess>
  cancelled: boolean
  dir: string
  settled: Promise<void>
}

const active = new Map<string, ActiveJob>()

function appPlatform(): AppPlatform {
  return process.platform === 'darwin'
    ? 'mac'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux'
}

function productionWorkerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Public Windows binaries never enable the unlicensed checkpoint path.
    // Non-Windows builds retain upstream behavior, while allowing an explicit
    // source-user opt-out with STEMSTUDIO_ENABLE_UNLICENSED_ENGINES=0.
    STEMSTUDIO_ENABLE_UNLICENSED_ENGINES:
      process.platform === 'win32'
        ? '0'
        : (process.env.STEMSTUDIO_ENABLE_UNLICENSED_ENGINES ?? '1')
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  const rec = active.get(jobId)
  if (!rec) return
  rec.cancelled = true
  await Promise.all([...rec.children].map((child) => terminateProcessTree(child)))
  await rec.settled
}

export async function cancelAllJobs(): Promise<void> {
  await Promise.all([...active.keys()].map((jobId) => cancelJob(jobId)))
}

/**
 * Run a full separation job. Returns the JobResult on success; throws on
 * failure or cancellation.
 */
export async function runJob(
  jobId: string,
  opts: SeparateOptions,
  cb: RunCallbacks
): Promise<JobResult> {
  const jobDir = join(app.getPath('userData'), 'jobs', jobId)
  const stagedDeliveries: StagedDelivery[] = []
  let markSettled!: () => void
  const settled = new Promise<void>((resolve) => { markSettled = resolve })
  const rec: ActiveJob = {
    children: new Set(),
    cancelled: false,
    dir: jobDir,
    settled
  }
  active.set(jobId, rec)

  const processHooks = {
    onSpawn: (child: ChildProcess) => rec.children.add(child),
    onExit: (child: ChildProcess) => rec.children.delete(child),
    isCancelled: () => rec.cancelled
  }

  const checkCancel = () => {
    if (rec.cancelled) throw new Error('Cancelled')
  }

  try {
    await mkdir(jobDir, { recursive: true })
    checkCancel()

    cb.onProgress({ jobId, stage: 'extracting', percent: -1 })
    const info = await probe(opts.inputPath, processHooks)
    const base = basename(opts.inputPath, extname(opts.inputPath))
    const ffmpeg = await ffmpegPath()

    // 1) Extract/normalize to engine-rate stereo WAV.
    const inputWav = join(jobDir, 'input.wav')
    await runFfmpeg(ffmpeg, extractAudioArgs(opts.inputPath, inputWav), processHooks)
    checkCancel()

    // 2) Ensure a Python venv is ready (first-run setup if needed).
    let py = await findReadyPython()
    if (!py) {
      cb.onProgress({ jobId, stage: 'setup', percent: -1 })
      py = await setupUserVenv(
        (detail) => {
          cb.onSetup(detail)
          cb.onProgress({ jobId, stage: 'setup', percent: -1, detail })
        },
        processHooks
      )
    }
    checkCancel()

    // 3) Run the worker; stream its line-JSON progress.
    const workerOut = join(jobDir, 'stems')
    await mkdir(workerOut, { recursive: true })
    // Model weights cache lives under userData/models (persists across jobs).
    const cacheDir = join(app.getPath('userData'), 'models')
    await mkdir(cacheDir, { recursive: true })
    const quality = resolveQuality(opts)
    if (!productionQualitiesForPlatform(appPlatform()).includes(quality)) {
      throw new Error(`Quality "${quality}" is unavailable in this Windows distribution.`)
    }
    const args = workerArgs({
      inputWav,
      outDir: workerOut,
      engine: DEFAULT_ENGINE,
      quality,
      cacheDir,
      polishDialogue: opts.polishDialogue
    })
    const workerOutputs = await runWorker(jobId, py, args, rec, cb)
    checkCancel()

    // 4) Convert each stem to 48 kHz / 24-bit delivery WAV.
    cb.onProgress({ jobId, stage: 'writing', percent: 0 })
    await mkdir(opts.outputDir, { recursive: true })
    const stems = {} as Record<StemKind, string>
    const stagedStems = {} as Record<StemKind, string>
    let done = 0
    for (const workerKey of Object.keys(WORKER_TO_STEM)) {
      const kind = WORKER_TO_STEM[workerKey]!
      const src = workerOutputs[workerKey]
      if (!src) throw new Error(`Worker did not produce stem "${workerKey}"`)
      const dest = join(opts.outputDir, `${base}_${STEM_SUFFIX[kind]}.wav`)
      const staged = stagedDeliveryPath(dest, jobId)
      stagedDeliveries.push({ finalPath: dest, stagedPath: staged })
      await runFfmpeg(ffmpeg, convertStemArgs(src, staged), processHooks)
      stems[kind] = dest
      stagedStems[kind] = staged
      done++
      cb.onProgress({ jobId, stage: 'writing', percent: (done / 3) * 100 })
      checkCancel()
    }

    // 5) Married-mix export: the full original mix conformed to the same
    // delivery spec (48 kHz / 24-bit) so all four WAVs are format-identical and
    // sample-aligned. Built from the same extracted audio the stems derive from.
    const marriedMix = join(opts.outputDir, `${base}_${MARRIED_SUFFIX}.wav`)
    const stagedMarried = stagedDeliveryPath(marriedMix, jobId)
    stagedDeliveries.push({ finalPath: marriedMix, stagedPath: stagedMarried })
    await runFfmpeg(ffmpeg, marriedMixArgs(inputWav, stagedMarried), processHooks)
    checkCancel()

    // 6) Optional multitrack video remux (video inputs only). The .mov keeps
    // the 3 stems + video; the married WAV is the 4th standalone file.
    let multitrackVideo: string | undefined
    if (opts.multitrackVideo && info.hasVideo) {
      cb.onProgress({ jobId, stage: 'remuxing', percent: -1 })
      multitrackVideo = join(opts.outputDir, `${base}_STEMS.mov`)
      const stagedVideo = stagedDeliveryPath(multitrackVideo, jobId)
      stagedDeliveries.push({ finalPath: multitrackVideo, stagedPath: stagedVideo })
      await runFfmpeg(
        ffmpeg,
        remuxMultitrackArgs(opts.inputPath, stagedStems, stagedVideo),
        processHooks
      )
      checkCancel()
    }

    await promoteStagedDeliveries(stagedDeliveries, jobId, checkCancel)

    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    active.delete(jobId)
    markSettled()

    return { jobId, stems, marriedMix, multitrackVideo, outputDir: opts.outputDir }
  } catch (err) {
    await Promise.all([...rec.children].map((child) => terminateProcessTree(child)))
    await cleanupStagedDeliveries(stagedDeliveries).catch(() => {})
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    active.delete(jobId)
    markSettled()
    throw err
  }
}

/**
 * Run the worker's one-shot device probe (`--probe`) and return the parsed
 * {@link WorkerProbe}, or a cpu-fallback probe if the venv isn't ready or the
 * probe can't be parsed. Non-throwing: the app should still work if this fails.
 */
export async function probeWorker(): Promise<WorkerProbe> {
  const fallback: WorkerProbe = {
    device: 'cpu',
    cuda: false,
    mps: false,
    torch: null,
    engines: process.platform === 'win32' ? ['tiger'] : ['tiger', 'mvsep', 'stub'],
    qualities: [...productionQualitiesForPlatform(appPlatform())]
  }
  const py = await findReadyPython()
  if (!py) return fallback

  const cacheDir = join(app.getPath('userData'), 'models')
  return new Promise<WorkerProbe>((resolve) => {
    let stdout = ''
    const child = trackProcess(spawn(
      py,
      probeWorkerArgs(cacheDir),
      childSpawnOptions({
        cwd: workerRoot(),
        env: {
          ...productionWorkerEnv(),
          PYTHONPATH: workerRoot(),
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    ))
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString()))
    child.on('error', () => resolve(fallback))
    child.on('close', () => {
      // Take the last non-blank line as the JSON probe result.
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
      if (!line) return resolve(fallback)
      try {
        const obj = JSON.parse(line) as Partial<WorkerProbe>
        if (obj.device === 'cuda' || obj.device === 'mps' || obj.device === 'cpu') {
          resolve({
            device: obj.device,
            cuda: !!obj.cuda,
            mps: !!obj.mps,
            torch: typeof obj.torch === 'string' ? obj.torch : null,
            engines: Array.isArray(obj.engines) ? obj.engines : fallback.engines,
            qualities: Array.isArray(obj.qualities)
              ? obj.qualities.filter(
                  (quality): quality is QualityMode =>
                    quality === 'fast' || quality === 'high' || quality === 'max'
                )
              : fallback.qualities
          })
          return
        }
      } catch {
        /* fall through */
      }
      resolve(fallback)
    })
  })
}

/** Spawn the Python worker and resolve with its `done` outputs map. */
function runWorker(
  jobId: string,
  py: string,
  args: string[],
  rec: ActiveJob,
  cb: RunCallbacks
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = trackProcess(spawn(
      py,
      args,
      childSpawnOptions({
        cwd: workerRoot(),
        env: {
          ...productionWorkerEnv(),
          PYTHONPATH: workerRoot(),
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    ))
    rec.children.add(child)

    const parser = new LineParser()
    let stderr = ''
    let outputs: Record<string, string> | null = null
    let workerError: string | null = null

    child.stdout?.on('data', (buf: Buffer) => {
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
    child.stderr?.on('data', (b) => {
      stderr += b.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      rec.children.delete(child)
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
