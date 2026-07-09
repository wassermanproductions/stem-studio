/**
 * Python environment management. The app owns a venv it builds under
 * userData/venv on first run. For dev/testing, a repo-local .venv is used if
 * present (so the pipeline is runnable without a setup screen).
 *
 * Setup progress is streamed back through the provided callback so the
 * renderer can show a first-run setup screen.
 */

import { app } from 'electron'
import { spawn } from 'child_process'
import { access, mkdir } from 'fs/promises'
import { constants } from 'fs'
import { join, resolve } from 'path'

/** Where the Python worker package lives (source dir). */
export function workerRoot(): string {
  // Packaged: extraResources copies python/ next to the app resources.
  // Dev: repo-local python/ dir.
  const packaged = join(process.resourcesPath ?? '', 'python')
  const dev = resolve(__dirname, '../../python')
  return app.isPackaged ? packaged : dev
}

/** Repo-local dev venv, used if present. */
function repoVenv(): string {
  return resolve(__dirname, '../../.venv')
}

/** App-managed venv under userData. */
function userVenv(): string {
  return join(app.getPath('userData'), 'venv')
}

/** Path to the python executable inside a venv (posix/win aware). */
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

/** Verify a venv python can import the worker's runtime deps (incl. the TIGER
 * engine stack: torch + huggingface_hub). */
async function venvHasDeps(py: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn(
      py,
      ['-c', 'import numpy, scipy, soundfile, torch, huggingface_hub, safetensors'],
      { stdio: 'ignore' }
    )
    child.on('error', () => res(false))
    child.on('close', (code) => res(code === 0))
  })
}

/**
 * Return a ready-to-use venv python path, or null if none is ready yet.
 * Prefers the repo-local .venv (dev), then the app-managed venv.
 */
export async function findReadyPython(): Promise<string | null> {
  for (const venv of [repoVenv(), userVenv()]) {
    const py = venvPython(venv)
    if ((await exists(py)) && (await venvHasDeps(py))) return py
  }
  return null
}

/** Detect a system python3 >= 3.10 to bootstrap the venv from. */
export async function detectSystemPython(): Promise<string | null> {
  const candidates = [
    process.env.STEMSTUDIO_PYTHON,
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ].filter(Boolean) as string[]

  for (const cand of candidates) {
    const ok = await new Promise<boolean>((res) => {
      const child = spawn(
        cand,
        ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
        { stdio: 'ignore' }
      )
      child.on('error', () => res(false))
      child.on('close', (code) => res(code === 0))
    })
    if (ok) return cand
  }
  return null
}

export type SetupProgress = (detail: string) => void

/**
 * Create the app-managed venv and install requirements. Streams pip/venv
 * output lines to `onProgress`. Resolves to the venv python path.
 * Throws with a readable message on failure.
 */
export async function setupUserVenv(onProgress: SetupProgress): Promise<string> {
  const sysPython = await detectSystemPython()
  if (!sysPython) {
    throw new Error(
      'No suitable Python found. Install Python 3.10+ (e.g. `brew install python`) and relaunch.'
    )
  }

  const venvDir = userVenv()
  await mkdir(app.getPath('userData'), { recursive: true })

  const py = venvPython(venvDir)

  if (!(await exists(py))) {
    onProgress('Creating Python environment…')
    await runStreaming(sysPython, ['-m', 'venv', venvDir], onProgress)
  }

  onProgress('Upgrading pip…')
  await runStreaming(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], onProgress)

  onProgress(
    'Installing libraries (numpy, scipy, soundfile, and PyTorch — a ~2 GB ' +
      'download; this can take a few minutes on first run)…'
  )
  const req = join(workerRoot(), 'requirements.txt')
  await runStreaming(py, ['-m', 'pip', 'install', '-r', req], onProgress)

  if (!(await venvHasDeps(py))) {
    throw new Error('Python setup finished but required libraries are missing.')
  }
  return py
}

/** Spawn a command, forwarding each stdout/stderr line to onLine. */
function runStreaming(
  cmd: string,
  args: string[],
  onLine: SetupProgress
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const forward = (buf: Buffer) => {
      const text = buf.toString()
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', rej)
    child.on('close', (code) => {
      if (code === 0) res()
      else rej(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}
