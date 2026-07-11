// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * ffmpeg/ffprobe process helpers for the main process. Pure argv building
 * lives in ../shared/ffmpegArgs; this module resolves the binaries and runs
 * them. GUI apps launched from Finder don't inherit the shell PATH, so we
 * probe /opt/homebrew/bin first, then fall back to PATH.
 */

import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { probeArgs } from '../shared/ffmpegArgs'
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type ProbeResult
} from '../shared/types'
import { basename, extname } from 'path'
import { join } from 'path'
import { childSpawnOptions, trackProcess } from './process'

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

async function resolveTool(bin: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const override = bin === 'ffmpeg' ? process.env.STEMSTUDIO_FFMPEG : process.env.STEMSTUDIO_FFPROBE
  const executable = process.platform === 'win32' ? `${bin}.exe` : bin
  const packagedDirectory = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos-arm64'
      : null
  const packaged = app.isPackaged && packagedDirectory
    ? join(process.resourcesPath, 'runtime-bootstrap', packagedDirectory, executable)
    : null
  const found = await firstExisting([
    ...(override ? [override] : []),
    ...(packaged ? [packaged] : []),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`
  ])
  // Fall back to a bare name so PATH resolution still gets a chance.
  return found ?? bin
}

export async function ffmpegPath(): Promise<string> {
  return resolveTool('ffmpeg')
}
export async function ffprobePath(): Promise<string> {
  return resolveTool('ffprobe')
}

export interface ProcessHooks {
  onSpawn?(child: ChildProcess): void
  onExit?(child: ChildProcess): void
  isCancelled?(): boolean
}

/** Run ffmpeg with the given args; reject with stderr on non-zero exit. */
export function runFfmpeg(bin: string, args: string[], hooks: ProcessHooks = {}): Promise<void> {
  return new Promise((res, rej) => {
    const child = trackProcess(spawn(
      bin,
      args,
      childSpawnOptions({ stdio: ['ignore', 'ignore', 'pipe'] })
    ))
    hooks.onSpawn?.(child)
    let err = ''
    child.stderr?.on('data', (b) => {
      err += b.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => {
      hooks.onExit?.(child)
      if (hooks.isCancelled?.()) return rej(new Error('Cancelled'))
      if (code === 0) res()
      else rej(new Error(`Media encoder exited ${code}\n${err.slice(-4000)}`))
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

/** Probe an input file into a ProbeResult. */
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
    child.stdout?.on('data', (b) => (out += b.toString()))
    child.stderr?.on('data', (b) => (err += b.toString()))
    child.on('error', rej)
    child.on('close', (code) => {
      hooks.onExit?.(child)
      if (hooks.isCancelled?.()) return rej(new Error('Cancelled'))
      if (code !== 0) return rej(new Error(`ffprobe failed: ${err.slice(-2000)}`))
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

  const container = (json.format?.format_name ?? ext).split(',')[0] ?? ext
  const codec = audio?.codec_name ?? 'unknown'

  return {
    path: inputPath,
    name: basename(inputPath),
    ext,
    duration: Number(json.format?.duration ?? 0) || 0,
    sampleRate: Number(audio?.sample_rate ?? 0) || 0,
    channels: audio?.channels ?? 0,
    // "hasVideo" means a real video stream (not just album-art). Cover-art
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
