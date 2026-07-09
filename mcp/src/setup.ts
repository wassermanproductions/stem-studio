/**
 * Python-environment readiness (`setup_status`) and provisioning
 * (`setup_environment`). Headless equivalent of the app's `src/main/pythonEnv.ts`:
 * the venv lives at the env-resolved python path (see resolve.ts), not under
 * Electron userData.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  workerPythonPath,
  workerRoot,
  modelCacheDir,
  systemPythonCandidates,
  defaultVenvPython
} from './resolve.js'
import { workerProbeArgs } from './workerArgs.js'

/** Structured readiness report returned by setup_status. */
export interface SetupStatus {
  ready: boolean
  pythonPath: string
  pythonExists: boolean
  /** True if `import torch, numpy, soundfile` succeeds. */
  depsImportable: boolean
  /** Missing/first failing import detail, if deps are not importable. */
  depsDetail?: string
  /** Compute device the engine would use (from worker --probe or torch inline). */
  device?: string
  /** Where the device info came from. */
  deviceSource?: 'worker-probe' | 'torch-inline' | 'unavailable'
  modelCacheDir: string
  modelCachePresent: boolean
  /** Human summary of what to do next if not ready. */
  message: string
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Run a command capturing stdout/stderr; resolve with {code, out, err}. */
function capture(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      return resolve({ code: -1, out: '', err: (e as Error).message })
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** Probe the compute device: prefer the worker's --probe, else torch inline. */
async function probeDevice(
  py: string,
  env: NodeJS.ProcessEnv
): Promise<{ device?: string; source: SetupStatus['deviceSource'] }> {
  const root = workerRoot(env)
  const withPath: NodeJS.ProcessEnv = { ...env, PYTHONPATH: root }

  // Try the worker's own --probe flag (may not exist in this snapshot).
  const probed = await capture(py, workerProbeArgs(), withPath)
  if (probed.code === 0 && probed.out.trim()) {
    // The worker prints line-JSON or a bare device string; take a best-effort read.
    const line = probed.out.trim().split('\n').pop() ?? ''
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const dev = obj.device ?? obj.data ?? obj.result
      if (typeof dev === 'string') return { device: dev, source: 'worker-probe' }
    } catch {
      // Not JSON — treat the trimmed output as the device name.
      return { device: probed.out.trim(), source: 'worker-probe' }
    }
  }

  // Degrade to inline torch device detection.
  const inline = await capture(
    py,
    [
      '-c',
      'import torch,sys;'
      + 'd="mps" if getattr(torch.backends,"mps",None) and torch.backends.mps.is_available() '
      + 'else ("cuda" if torch.cuda.is_available() else "cpu");'
      + 'sys.stdout.write(d)'
    ],
    withPath
  )
  if (inline.code === 0 && inline.out.trim()) {
    return { device: inline.out.trim(), source: 'torch-inline' }
  }
  return { device: undefined, source: 'unavailable' }
}

/** Assess Python environment readiness. Never throws — reports structurally. */
export async function setupStatus(
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupStatus> {
  const py = workerPythonPath(env)
  const pythonExists = await fileExists(py)
  const cache = modelCacheDir(env)
  const modelCachePresent = existsSync(cache)

  if (!pythonExists) {
    return {
      ready: false,
      pythonPath: py,
      pythonExists: false,
      depsImportable: false,
      modelCacheDir: cache,
      modelCachePresent,
      deviceSource: 'unavailable',
      message:
        `No venv python at ${py}. Run setup_environment (or set STEMSTUDIO_PYTHON ` +
        `to an existing venv python).`
    }
  }

  const imp = await capture(
    py,
    ['-c', 'import torch, numpy, soundfile'],
    env
  )
  const depsImportable = imp.code === 0
  const device = depsImportable ? await probeDevice(py, env) : undefined

  return {
    ready: depsImportable,
    pythonPath: py,
    pythonExists: true,
    depsImportable,
    depsDetail: depsImportable ? undefined : imp.err.slice(-2000).trim(),
    device: device?.device,
    deviceSource: device?.source ?? 'unavailable',
    modelCacheDir: cache,
    modelCachePresent,
    message: depsImportable
      ? 'Environment ready.'
      : 'Python found but required libraries (torch/numpy/soundfile) are missing. ' +
        'Run setup_environment.'
  }
}

/** A running setup that can be cancelled. */
export interface SetupHandle {
  result: Promise<{ pythonPath: string }>
  cancel(): void
}

export interface SetupCallbacks {
  onProgress?(detail: string): void
}

/** Spawn a command, forwarding each stdout/stderr line to onLine. Cancellable. */
function runStreaming(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  register: (child: ChildProcess) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    register(child)
    const forward = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim()
        if (t) onLine(t)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

/** Detect a system python3 >= 3.10 to bootstrap the venv from. */
async function detectSystemPython(
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  for (const cand of systemPythonCandidates(env)) {
    const ok = await capture(
      cand,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
      env
    )
    if (ok.code === 0) return cand
  }
  return null
}

/**
 * Create the venv (at the env-resolved python's venv dir) and pip-install
 * requirements. Streams progress. Returns a handle; caller awaits result or
 * registers it for check_job.
 */
export function startSetup(
  env: NodeJS.ProcessEnv = process.env,
  cb: SetupCallbacks = {}
): SetupHandle {
  let cancelled = false
  let child: ChildProcess | undefined
  const register = (c: ChildProcess) => {
    child = c
  }
  const cancel = () => {
    cancelled = true
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  }
  const checkCancel = () => {
    if (cancelled) throw new Error('Cancelled')
  }
  const emit = (d: string) => cb.onProgress?.(d)

  const result = (async (): Promise<{ pythonPath: string }> => {
    const sysPython = await detectSystemPython(env)
    if (!sysPython) {
      throw new Error(
        'No suitable Python found. Install Python 3.10+ (e.g. `brew install python`).'
      )
    }
    checkCancel()

    // The target venv is the directory containing the resolved worker python.
    // When STEMSTUDIO_PYTHON points at an existing python we still (re)create
    // that venv dir; normally this is <repo>/.venv.
    const targetPy = defaultVenvPython(env)
    const venvDir = join(targetPy, '..', '..') // <venv>/bin/python -> <venv>

    if (!(await fileExists(targetPy))) {
      emit('Creating Python environment…')
      await runStreaming(sysPython, ['-m', 'venv', venvDir], env, emit, register)
    }
    checkCancel()

    emit('Upgrading pip…')
    await runStreaming(
      targetPy,
      ['-m', 'pip', 'install', '--upgrade', 'pip'],
      env,
      emit,
      register
    )
    checkCancel()

    emit(
      'Installing libraries (numpy, scipy, soundfile, and PyTorch — a large ' +
        'download; this can take several minutes on first run)…'
    )
    const req = join(workerRoot(env), 'requirements.txt')
    await runStreaming(
      targetPy,
      ['-m', 'pip', 'install', '-r', req],
      env,
      emit,
      register
    )
    checkCancel()

    const verify = await capture(
      targetPy,
      ['-c', 'import torch, numpy, soundfile'],
      env
    )
    if (verify.code !== 0) {
      throw new Error(
        'Setup finished but required libraries are still missing:\n' +
          verify.err.slice(-2000)
      )
    }
    // Ensure the model cache dir exists so first separation can populate it.
    await mkdir(modelCacheDir(env), { recursive: true }).catch(() => {})
    return { pythonPath: targetPy }
  })()

  return { result, cancel }
}
