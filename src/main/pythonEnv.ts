/**
 * Private Python runtime management. Windows is prerequisite-free: packaged uv
 * installs pinned CPython and synchronizes a hashed dependency lock entirely
 * below userData. macOS/Linux retain the existing system-Python bootstrap.
 */

import { app } from 'electron'
import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { constants } from 'fs'
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile
} from 'fs/promises'
import { join, resolve } from 'path'
import { childSpawnOptions, trackProcess } from './process'
import { assertScopedRuntimePath, privateRuntimeRoot } from './runtimePaths'

export const WINDOWS_PYTHON_VERSION = '3.12.10'
export const WINDOWS_UV_VERSION = '0.11.28'
export const WINDOWS_RUNTIME_SCHEMA = 1
export const WINDOWS_MIN_FREE_BYTES = 6 * 1024 ** 3

type WindowsProfile = 'cpu' | 'cuda'

interface RuntimeManifest {
  schema: number
  pythonVersion: string
  uvVersion: string
  profile: WindowsProfile
  requirementsSha256: string
  readyAt: string
}

export interface SetupControl {
  onSpawn?(child: ChildProcess): void
  onExit?(child: ChildProcess): void
  isCancelled?(): boolean
}

/** Where the bundled Python worker source lives. */
export function workerRoot(): string {
  const packaged = join(process.resourcesPath ?? '', 'python')
  const dev = resolve(__dirname, '../../python')
  return app.isPackaged ? packaged : dev
}

function repoVenv(): string {
  return resolve(__dirname, '../../.venv')
}

export function runtimeRoot(): string {
  return privateRuntimeRoot(app.getPath('userData'), 'win32')
}

/** Remove only the app-managed runtime so setup can rebuild it from pins. */
export async function repairPrivateRuntime(): Promise<void> {
  const userData = app.getPath('userData')
  const target = privateRuntimeRoot(userData, process.platform)
  assertScopedRuntimePath(userData, target)
  await rm(target, { recursive: true, force: true })
}

function userVenv(): string {
  return process.platform === 'win32'
    ? join(runtimeRoot(), 'venv')
    : join(app.getPath('userData'), 'venv')
}

function readinessPath(): string {
  return join(runtimeRoot(), 'ready.json')
}

export function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function spawnQuiet(
  cmd: string,
  args: string[],
  control: SetupControl = {}
): Promise<boolean> {
  return new Promise((res) => {
    const child = trackProcess(spawn(cmd, args, childSpawnOptions({ stdio: 'ignore' })))
    control.onSpawn?.(child)
    child.on('error', () => res(false))
    child.on('close', (code) => {
      control.onExit?.(child)
      res(!control.isCancelled?.() && code === 0)
    })
  })
}

async function venvHasDeps(py: string, control: SetupControl = {}): Promise<boolean> {
  return spawnQuiet(
    py,
    ['-c', 'import numpy, scipy, soundfile, torch, huggingface_hub, safetensors'],
    control
  )
}

function requestedWindowsProfile(): WindowsProfile {
  return process.env.STEMSTUDIO_WINDOWS_PROFILE?.toLowerCase() === 'cuda' ? 'cuda' : 'cpu'
}

function requirementsPath(profile: WindowsProfile): string {
  return join(workerRoot(), `requirements-windows-${profile}.lock`)
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function validWindowsManifest(py: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(readinessPath(), 'utf8')) as RuntimeManifest
    if (
      manifest.schema !== WINDOWS_RUNTIME_SCHEMA ||
      manifest.pythonVersion !== WINDOWS_PYTHON_VERSION ||
      manifest.uvVersion !== WINDOWS_UV_VERSION ||
      !['cpu', 'cuda'].includes(manifest.profile)
    ) return false
    if (manifest.requirementsSha256 !== await fileSha256(requirementsPath(manifest.profile))) {
      return false
    }
    return (await exists(py)) && (await venvHasDeps(py))
  } catch {
    return false
  }
}

/** Return a ready interpreter, preferring a dev venv when unpackaged. */
export async function findReadyPython(): Promise<string | null> {
  if (!app.isPackaged) {
    const devPy = venvPython(repoVenv())
    if ((await exists(devPy)) && (await venvHasDeps(devPy))) return devPy
  }
  const managed = venvPython(userVenv())
  if (process.platform === 'win32') {
    return (await validWindowsManifest(managed)) ? managed : null
  }
  return (await exists(managed)) && (await venvHasDeps(managed)) ? managed : null
}

export async function detectSystemPython(control: SetupControl = {}): Promise<string | null> {
  const candidates = [
    process.env.STEMSTUDIO_PYTHON,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (await spawnQuiet(
      candidate,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
      control
    )) return candidate
  }
  return null
}

export type SetupProgress = (detail: string) => void

function throwIfCancelled(control: SetupControl): void {
  if (control.isCancelled?.()) throw new Error('Cancelled')
}

async function ensureWindowsDiskSpace(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const disk = await statfs(app.getPath('userData'), { bigint: true })
  const available = disk.bavail * disk.bsize
  if (available < BigInt(WINDOWS_MIN_FREE_BYTES)) {
    const availableGiB = Number(available / BigInt(1024 ** 3))
    throw new Error(
      `Stem Studio needs at least 6 GB free for its private runtime; only ${availableGiB} GB is available.`
    )
  }
}

function uvPath(): string {
  if (process.env.STEMSTUDIO_UV) return process.env.STEMSTUDIO_UV
  if (app.isPackaged) {
    return join(process.resourcesPath, 'runtime-bootstrap', 'windows', 'uv.exe')
  }
  return 'uv'
}

async function writeReadyManifest(
  profile: WindowsProfile,
  control: SetupControl
): Promise<void> {
  throwIfCancelled(control)
  const manifest: RuntimeManifest = {
    schema: WINDOWS_RUNTIME_SCHEMA,
    pythonVersion: WINDOWS_PYTHON_VERSION,
    uvVersion: WINDOWS_UV_VERSION,
    profile,
    requirementsSha256: await fileSha256(requirementsPath(profile)),
    readyAt: new Date().toISOString()
  }
  const temporary = `${readinessPath()}.tmp-${process.pid}`
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
    throwIfCancelled(control)
    await rename(temporary, readinessPath())
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function setupWindowsProfile(
  profile: WindowsProfile,
  onProgress: SetupProgress,
  control: SetupControl
): Promise<string> {
  const root = runtimeRoot()
  const venv = userVenv()
  const py = venvPython(venv)
  const uv = uvPath()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_CACHE_DIR: join(root, 'uv-cache'),
    UV_NO_MODIFY_PATH: '1',
    UV_MANAGED_PYTHON: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }

  await rm(readinessPath(), { force: true })
  await mkdir(root, { recursive: true })
  throwIfCancelled(control)

  onProgress(`Installing private CPython ${WINDOWS_PYTHON_VERSION} with uv ${WINDOWS_UV_VERSION}…`)
  await runStreaming(
    uv,
    ['python', 'install', WINDOWS_PYTHON_VERSION],
    onProgress,
    control,
    env
  )
  throwIfCancelled(control)

  onProgress(`Creating the private ${profile.toUpperCase()} environment…`)
  await runStreaming(
    uv,
    ['venv', '--clear', '--managed-python', '--python', WINDOWS_PYTHON_VERSION, venv],
    onProgress,
    control,
    env
  )
  throwIfCancelled(control)

  onProgress(`Synchronizing the pinned ${profile.toUpperCase()} dependency profile…`)
  await runStreaming(
    uv,
    [
      'pip',
      'sync',
      '--python',
      py,
      '--require-hashes',
      '--torch-backend',
      profile === 'cuda' ? 'cu128' : 'cpu',
      requirementsPath(profile)
    ],
    onProgress,
    control,
    env
  )
  throwIfCancelled(control)

  if (!(await venvHasDeps(py, control))) {
    throw new Error('Private Python setup finished but required libraries are missing.')
  }
  throwIfCancelled(control)
  if (profile === 'cuda' && !(await torchSeesCuda(py, control))) {
    throw new Error('The experimental CUDA profile installed, but PyTorch cannot use this GPU.')
  }
  throwIfCancelled(control)
  await writeReadyManifest(profile, control)
  return py
}

async function setupWindowsRuntime(
  onProgress: SetupProgress,
  control: SetupControl
): Promise<string> {
  await ensureWindowsDiskSpace()
  const requested = requestedWindowsProfile()
  if (requested === 'cuda') {
    try {
      return await setupWindowsProfile('cuda', onProgress, control)
    } catch (error) {
      throwIfCancelled(control)
      onProgress(`CUDA setup was unavailable (${(error as Error).message}); falling back to CPU.`)
      await rm(userVenv(), { recursive: true, force: true })
    }
  }
  return setupWindowsProfile('cpu', onProgress, control)
}

/** Provision a private environment and return its interpreter. */
export async function setupUserVenv(
  onProgress: SetupProgress,
  control: SetupControl = {}
): Promise<string> {
  if (process.platform === 'win32') return setupWindowsRuntime(onProgress, control)

  const sysPython = await detectSystemPython(control)
  if (!sysPython) {
    throw new Error('No suitable Python found. Install Python 3.10+ and relaunch Stem Studio.')
  }
  const venvDir = userVenv()
  await mkdir(app.getPath('userData'), { recursive: true })
  const py = venvPython(venvDir)
  if (!(await exists(py))) {
    onProgress('Creating Python environment…')
    await runStreaming(sysPython, ['-m', 'venv', venvDir], onProgress, control)
  }
  throwIfCancelled(control)
  onProgress('Upgrading pip…')
  await runStreaming(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], onProgress, control)
  onProgress('Installing separation libraries…')
  await runStreaming(
    py,
    ['-m', 'pip', 'install', '-r', join(workerRoot(), 'requirements.txt')],
    onProgress,
    control
  )
  if (
    process.platform === 'linux' &&
    (await hasNvidiaGpu(control)) &&
    !(await torchSeesCuda(py, control))
  ) {
    onProgress('CUDA GPU detected; installing the CUDA PyTorch profile…')
    await runStreaming(
      py,
      ['-m', 'pip', 'install', '--upgrade', '--index-url', CUDA_WHEEL_INDEX, 'torch', 'torchaudio'],
      onProgress,
      control
    )
  }
  throwIfCancelled(control)
  if (!(await venvHasDeps(py, control))) {
    throw new Error('Python setup finished but required libraries are missing.')
  }
  return py
}

const CUDA_WHEEL_INDEX = 'https://download.pytorch.org/whl/cu128'

function hasNvidiaGpu(control: SetupControl = {}): Promise<boolean> {
  return spawnQuiet('nvidia-smi', ['-L'], control)
}

function torchSeesCuda(py: string, control: SetupControl = {}): Promise<boolean> {
  return spawnQuiet(
    py,
    ['-c', 'import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)'],
    control
  )
}

function runStreaming(
  cmd: string,
  args: string[],
  onLine: SetupProgress,
  control: SetupControl,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  return new Promise((res, rej) => {
    const child = trackProcess(spawn(
      cmd,
      args,
      childSpawnOptions({ env, stdio: ['ignore', 'pipe', 'pipe'] })
    ))
    control.onSpawn?.(child)
    const forward = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const text = line.trim()
        if (text) onLine(text)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('error', rej)
    child.on('close', (code) => {
      control.onExit?.(child)
      if (control.isCancelled?.()) return rej(new Error('Cancelled'))
      if (code === 0) res()
      else rej(new Error(`${cmd} exited with code ${code}`))
    })
  })
}
