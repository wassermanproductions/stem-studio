/**
 * Environment / binary resolution. Headless (no Electron), so the resolution
 * rules from the app's ffmpeg.ts + pythonEnv.ts are re-expressed here in terms
 * of env vars and well-known paths:
 *
 *   ffmpeg/ffprobe : PATH + /opt/homebrew/bin + /usr/bin + /usr/local/bin
 *   repo root      : $STEMSTUDIO_ROOT else the package's own repo (mcp/..)
 *   python worker  : $STEMSTUDIO_PYTHON else <repo>/.venv/bin/python
 *   PYTHONPATH     : <repo>/python
 *   model cache    : $STEMSTUDIO_CACHE else ~/.stemstudio/models
 *
 * The pure list-builders are exported for unit tests; the async
 * `firstExisting` probe touches the filesystem and is exercised via the
 * higher-level resolvers.
 */

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Extra directories to search for ffmpeg/ffprobe, in priority order. */
export const FFMPEG_SEARCH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/bin',
  '/usr/local/bin'
] as const

/** Candidate absolute paths for an ffmpeg-family tool, in priority order. */
export function ffmpegToolCandidates(bin: 'ffmpeg' | 'ffprobe'): string[] {
  return FFMPEG_SEARCH_DIRS.map((d) => `${d}/${bin}`)
}

/** First path that exists and is executable, else null. */
export async function firstExisting(paths: string[]): Promise<string | null> {
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

/**
 * Resolve an ffmpeg-family binary. Tries the well-known dirs first, then falls
 * back to the bare name so PATH resolution still gets a chance at spawn time.
 */
export async function resolveFfmpegTool(
  bin: 'ffmpeg' | 'ffprobe'
): Promise<string> {
  const found = await firstExisting(ffmpegToolCandidates(bin))
  return found ?? bin
}

export const ffmpegPath = (): Promise<string> => resolveFfmpegTool('ffmpeg')
export const ffprobePath = (): Promise<string> => resolveFfmpegTool('ffprobe')

/**
 * Repo root: $STEMSTUDIO_ROOT if set, else the repo this package lives in.
 * When running from source, `src/` is one level under `mcp/`, so the repo is
 * two levels up; when running the built bundle, `dist/` is likewise one level
 * under `mcp/`. Both cases resolve to `mcp/..`.
 */
export function repoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STEMSTUDIO_ROOT
  if (override && override.trim()) return resolve(override)
  // HERE is <repo>/mcp/{src|dist}; repo root is two levels up.
  return resolve(HERE, '..', '..')
}

/** `<repo>/python` — the dir added to PYTHONPATH for the worker. */
export function workerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(repoRoot(env), 'python')
}

/** Default venv python path used when $STEMSTUDIO_PYTHON is unset. */
export function defaultVenvPython(env: NodeJS.ProcessEnv = process.env): string {
  const bin = process.platform === 'win32' ? 'python.exe' : 'python'
  const sub = process.platform === 'win32' ? 'Scripts' : 'bin'
  return join(repoRoot(env), '.venv', sub, bin)
}

/**
 * Resolve the worker python interpreter path (does NOT check it exists — that's
 * `setup_status`'s job). $STEMSTUDIO_PYTHON wins; otherwise the repo `.venv`.
 */
export function workerPythonPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STEMSTUDIO_PYTHON
  if (override && override.trim()) return resolve(override)
  return defaultVenvPython(env)
}

/** Model-weights cache dir: $STEMSTUDIO_CACHE else ~/.stemstudio/models. */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STEMSTUDIO_CACHE
  if (override && override.trim()) return resolve(override)
  return join(homedir(), '.stemstudio', 'models')
}

/** Candidate system python3 interpreters for bootstrapping a venv. */
export function systemPythonCandidates(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return [
    env.STEMSTUDIO_PYTHON,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ].filter((x): x is string => !!x && x.trim().length > 0)
}
