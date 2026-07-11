// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * Environment / binary resolution. Headless (no Electron), so the resolution
 * rules from the app's ffmpeg.ts + pythonEnv.ts are re-expressed here in terms
 * of env vars and well-known paths:
 *
 *   ffmpeg/ffprobe : PATH + /opt/homebrew/bin + /usr/bin + /usr/local/bin
 *   repo root      : $STEMSTUDIO_ROOT else the package's own repo (mcp/..)
 *   python worker  : $STEMSTUDIO_PYTHON else <repo>/.venv/bin/python
 *   PYTHONPATH     : <repo>/python
 *   user data/cache: installed builds share Electron's per-distribution root;
 *                    source checkouts retain ~/.stemstudio
 *
 * The pure list-builders are exported for unit tests; the async
 * `firstExisting` probe touches the filesystem and is exercised via the
 * higher-level resolvers.
 */

import { access } from 'node:fs/promises'
import { constants, existsSync, readFileSync } from 'node:fs'
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

/** Packaged Electron resources root, when the MCP bundle runs from resources/mcp. */
export function resourcesRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.STEMSTUDIO_RESOURCES?.trim()) return resolve(env.STEMSTUDIO_RESOURCES)
  const candidate = resolve(HERE, '..')
  return existsSync(join(candidate, 'python')) ? candidate : null
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
  bin: 'ffmpeg' | 'ffprobe',
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const override = bin === 'ffmpeg' ? env.STEMSTUDIO_FFMPEG : env.STEMSTUDIO_FFPROBE
  const resources = resourcesRoot(env)
  const executable = process.platform === 'win32' ? `${bin}.exe` : bin
  const platformDirectory = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos-arm64'
      : null
  const bundled = resources && platformDirectory
    ? join(resources, 'runtime-bootstrap', platformDirectory, executable)
    : null
  const found = await firstExisting([
    ...(override?.trim() ? [resolve(override)] : []),
    ...(bundled ? [bundled] : []),
    ...ffmpegToolCandidates(bin)
  ])
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
  const resources = resourcesRoot(env)
  return resources ? join(resources, 'python') : join(repoRoot(env), 'python')
}

interface PackagedDistribution {
  schemaVersion?: number
  userDataFolder?: string
}

/**
 * Resolve a single safe application-data folder name from the explicit MCP
 * launcher override or the descriptor emitted by the packaging hook. The
 * bridge never infers product identity from installation paths.
 */
export function distributionUserDataFolder(
  env: NodeJS.ProcessEnv = process.env,
  resources: string | null = resourcesRoot(env)
): string {
  let folder = env.STEMSTUDIO_USER_DATA_FOLDER?.trim()
  if (!folder && resources) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(resources, 'stem-studio-distribution.json'), 'utf8')
      ) as PackagedDistribution
      if (metadata.schemaVersion === 1) folder = metadata.userDataFolder?.trim()
    } catch {
      // Older packages have no descriptor and use the generic data root.
    }
  }
  folder ||= 'stem-studio'
  if (
    folder === '.' ||
    folder === '..' ||
    folder.includes('/') ||
    folder.includes('\\') ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(folder)
  ) {
    throw new Error('Invalid STEMSTUDIO_USER_DATA_FOLDER distribution value')
  }
  return folder
}

/** Electron userData equivalent used by the installed headless bridge. */
export function userDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STEMSTUDIO_USER_DATA?.trim()) return resolve(env.STEMSTUDIO_USER_DATA)
  const packaged = resourcesRoot(env) !== null
  const folder = distributionUserDataFolder(env)
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
    return join(appData, folder)
  }
  if (packaged && process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', folder)
  }
  if (packaged) {
    return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), folder)
  }
  return join(homedir(), '.stemstudio')
}

/** Default venv python path used when $STEMSTUDIO_PYTHON is unset. */
export function defaultVenvPython(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return join(userDataRoot(env), 'runtime', 'v1', 'venv', 'Scripts', 'python.exe')
  }
  if (resourcesRoot(env)) return join(userDataRoot(env), 'venv', 'bin', 'python')
  return join(repoRoot(env), '.venv', 'bin', 'python')
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
  return join(userDataRoot(env), 'models')
}

export function uvPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STEMSTUDIO_UV?.trim()) return resolve(env.STEMSTUDIO_UV)
  const resources = resourcesRoot(env)
  return resources
    ? join(resources, 'runtime-bootstrap', 'windows', 'uv.exe')
    : 'uv'
}

export function windowsRequirementsPath(
  profile: 'cpu' | 'cuda',
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(workerRoot(env), `requirements-windows-${profile}.lock`)
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
