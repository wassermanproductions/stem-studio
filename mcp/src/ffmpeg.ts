/**
 * ffmpeg/ffprobe process helpers. Pure argv building lives in ./ffmpegArgs;
 * binary resolution in ./resolve. This module only spawns. Mirrors the app's
 * `src/main/ffmpeg.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname } from 'node:path'
import { probeArgs } from './ffmpegArgs.js'
import { ffmpegPath, ffprobePath } from './resolve.js'
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type ProbeResult
} from './types.js'
import { childSpawnOptions, trackProcess } from './process.js'

export interface ProcessHooks {
  onSpawn?(child: ChildProcess): void
  onExit?(child: ChildProcess): void
  isCancelled?(): boolean
}

/** Run ffmpeg with the given args; reject with stderr tail on non-zero exit. */
export function runFfmpeg(bin: string, args: string[], hooks: ProcessHooks = {}): Promise<void> {
  return new Promise((res, rej) => {
    const child = trackProcess(
      spawn(bin, args, childSpawnOptions({ stdio: ['ignore', 'ignore', 'pipe'] }))
    )
    hooks.onSpawn?.(child)
    let err = ''
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => {
      hooks.onExit?.(child)
      if (hooks.isCancelled?.()) return rej(new Error('Cancelled'))
      if (code === 0) res()
      else rej(new Error(`ffmpeg exited ${code}\n${err.slice(-4000)}`))
    })
  })
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  sample_rate?: string
  channels?: number
}
interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string }
}

/**
 * Probe an input file into a ProbeResult. Throws a clear error if the file is
 * missing / unreadable or ffprobe can't parse it.
 */
export async function probe(inputPath: string, hooks: ProcessHooks = {}): Promise<ProbeResult> {
  const bin = await ffprobePath()
  const json = await new Promise<FfprobeJson>((res, rej) => {
    const child = trackProcess(spawn(
      bin,
      probeArgs(inputPath),
      childSpawnOptions({ stdio: ['ignore', 'pipe', 'pipe'] })
    ))
    hooks.onSpawn?.(child)
    let out = ''
    let err = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', (e) =>
      rej(
        new Error(
          `Could not run the bundled media probe (${bin}): ${(e as Error).message}.`
        )
      )
    )
    child.on('close', (code) => {
      hooks.onExit?.(child)
      if (hooks.isCancelled?.()) return rej(new Error('Cancelled'))
      if (code !== 0)
        return rej(
          new Error(`ffprobe failed for "${inputPath}": ${err.slice(-2000) || `exit ${code}`}`)
        )
      try {
        res(JSON.parse(out) as FfprobeJson)
      } catch (e) {
        rej(new Error(`ffprobe returned invalid JSON: ${(e as Error).message}`))
      }
    })
  })

  const streams = json.streams ?? []
  const audio = streams.find((s) => s.codec_type === 'audio')
  const video = streams.find((s) => s.codec_type === 'video')
  const ext = extname(inputPath).slice(1).toLowerCase()

  if (!audio) {
    throw new Error(
      `No audio stream found in "${inputPath}". Stem Studio needs a file with an audio track.`
    )
  }

  const container = (json.format?.format_name ?? ext).split(',')[0] ?? ext
  const codec = audio.codec_name ?? 'unknown'

  return {
    path: inputPath,
    name: basename(inputPath),
    ext,
    duration: Number(json.format?.duration ?? 0) || 0,
    sampleRate: Number(audio.sample_rate ?? 0) || 0,
    channels: audio.channels ?? 0,
    // "hasVideo" means a real video stream (not just album art). Cover-art
    // streams are typically mjpeg/png attached-pic; treat known video
    // containers with a non-image codec as video.
    hasVideo:
      !!video &&
      video.codec_name !== 'mjpeg' &&
      video.codec_name !== 'png' &&
      VIDEO_EXTENSIONS.includes(ext as (typeof VIDEO_EXTENSIONS)[number]),
    format: `${container} / ${codec}`
  }
}

/** True if the extension is a supported input (video or audio). */
export function isSupportedInput(ext: string): boolean {
  const e = ext.toLowerCase()
  return (
    VIDEO_EXTENSIONS.includes(e as (typeof VIDEO_EXTENSIONS)[number]) ||
    AUDIO_EXTENSIONS.includes(e as (typeof AUDIO_EXTENSIONS)[number])
  )
}
