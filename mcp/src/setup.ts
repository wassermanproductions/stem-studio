/**
 * Python-environment readiness (`setup_status`) and provisioning
 * (`setup_environment`). Headless equivalent of the app's `src/main/pythonEnv.ts`:
 * the venv lives at the env-resolved python path (see resolve.ts), not under
 * Electron userData.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  workerPythonPath,
  workerRoot,
  modelCacheDir,
  systemPythonCandidates,
  defaultVenvPython,
  userDataRoot,
  uvPath,
  windowsRequirementsPath
} from './resolve.js'
import { workerProbeArgs } from './workerArgs.js'
import { childSpawnOptions, killTree, trackProcess } from './process.js'

const WINDOWS_PYTHON_VERSION = '3.12.10'
const WINDOWS_UV_VERSION = '0.11.28'
const WINDOWS_MIN_FREE_BYTES = 6 * 1024 ** 3

interface ProcessControl {
  onSpawn?(child: ChildProcess): void
  onExit?(child: ChildProcess): void
  isCancelled?(): boolean
}

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
  env: NodeJS.ProcessEnv = process.env,
  control: ProcessControl = {}
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = trackProcess(spawn(cmd, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }))
      control.onSpawn?.(child)
    } catch (e) {
      return resolve({ code: -1, out: '', err: (e as Error).message })
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    child.on('close', (code) => {
      control.onExit?.(child)
      resolve({ code: control.isCancelled?.() ? -1 : code, out, err })
    })
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

  if (process.platform === 'win32' && !env.STEMSTUDIO_PYTHON?.trim()) {
    try {
      const manifest = JSON.parse(
        await readFile(join(userDataRoot(env), 'runtime', 'v1', 'ready.json'), 'utf8')
      ) as {
        schema?: number
        pythonVersion?: string
        uvVersion?: string
        profile?: 'cpu' | 'cuda'
        requirementsSha256?: string
      }
      if (
        manifest.schema !== 1 ||
        manifest.pythonVersion !== WINDOWS_PYTHON_VERSION ||
        manifest.uvVersion !== WINDOWS_UV_VERSION ||
        !manifest.profile
      ) throw new Error('invalid manifest')
      const actual = createHash('sha256')
        .update(await readFile(windowsRequirementsPath(manifest.profile, env)))
        .digest('hex')
      if (actual !== manifest.requirementsSha256) throw new Error('dependency lock changed')
    } catch {
      return {
        ready: false,
        pythonPath: py,
        pythonExists: true,
        depsImportable: false,
        modelCacheDir: cache,
        modelCachePresent,
        deviceSource: 'unavailable',
        message: 'The private runtime is incomplete or stale. Run setup_environment to repair it.'
      }
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
  cancel(): Promise<void>
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
  control: ProcessControl
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = trackProcess(spawn(
      cmd,
      args,
      childSpawnOptions({ env, stdio: ['ignore', 'pipe', 'pipe'] })
    ))
    control.onSpawn?.(child)
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
      control.onExit?.(child)
      if (control.isCancelled?.()) reject(new Error('Cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

/** Detect a system python3 >= 3.10 to bootstrap the venv from. */
async function detectSystemPython(
  env: NodeJS.ProcessEnv,
  control: ProcessControl = {}
): Promise<string | null> {
  for (const cand of systemPythonCandidates(env)) {
    const ok = await capture(
      cand,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
      env,
      control
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
  const children = new Set<ChildProcess>()
  const control: ProcessControl = {
    onSpawn: (child) => children.add(child),
    onExit: (child) => children.delete(child),
    isCancelled: () => cancelled
  }
  let result!: Promise<{ pythonPath: string }>
  const cancel = async () => {
    cancelled = true
    await Promise.all([...children].map((child) => killTree(child)))
    await result.catch(() => {})
  }
  const checkCancel = () => {
    if (cancelled) throw new Error('Cancelled')
  }
  const emit = (d: string) => cb.onProgress?.(d)

  result = (async (): Promise<{ pythonPath: string }> => {
    if (process.platform === 'win32') {
      return setupWindowsEnvironment(env, emit, control, checkCancel)
    }
    const sysPython = await detectSystemPython(env, control)
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
    const venvDir = dirname(dirname(targetPy))

    if (!(await fileExists(targetPy))) {
      emit('Creating Python environment…')
      await runStreaming(sysPython, ['-m', 'venv', venvDir], env, emit, control)
    }
    checkCancel()

    emit('Upgrading pip…')
    await runStreaming(
      targetPy,
      ['-m', 'pip', 'install', '--upgrade', 'pip'],
      env,
      emit,
      control
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
      control
    )
    checkCancel()

    const verify = await capture(
      targetPy,
      ['-c', 'import torch, numpy, soundfile'],
      env,
      control
    )
    checkCancel()
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

async function setupWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  emit: (detail: string) => void,
  control: ProcessControl,
  checkCancel: () => void
): Promise<{ pythonPath: string }> {
  const dataRoot = userDataRoot(env)
  await mkdir(dataRoot, { recursive: true })
  const disk = await statfs(dataRoot, { bigint: true })
  const free = disk.bavail * disk.bsize
  if (free < BigInt(WINDOWS_MIN_FREE_BYTES)) {
    throw new Error(
      `Stem Studio needs 6 GB free for its private runtime; ${Number(free / BigInt(1024 ** 3))} GB is available.`
    )
  }

  const runtime = join(dataRoot, 'runtime', 'v1')
  const targetPy = defaultVenvPython(env)
  const venvDir = dirname(dirname(targetPy))
  const ready = join(runtime, 'ready.json')
  const uv = uvPath(env)
  const uvEnv: NodeJS.ProcessEnv = {
    ...env,
    UV_PYTHON_INSTALL_DIR: join(runtime, 'python'),
    UV_CACHE_DIR: join(runtime, 'uv-cache'),
    UV_NO_MODIFY_PATH: '1',
    UV_MANAGED_PYTHON: '1'
  }
  await mkdir(runtime, { recursive: true })

  const requested = env.STEMSTUDIO_WINDOWS_PROFILE?.toLowerCase() === 'cuda'
    ? 'cuda'
    : 'cpu'

  const install = async (profile: 'cpu' | 'cuda'): Promise<void> => {
    const requirements = windowsRequirementsPath(profile, env)
    await rm(ready, { force: true })
    emit(`Installing private CPython ${WINDOWS_PYTHON_VERSION} with uv ${WINDOWS_UV_VERSION}…`)
    await runStreaming(
      uv,
      ['python', 'install', WINDOWS_PYTHON_VERSION],
      uvEnv,
      emit,
      control
    )
    checkCancel()
    emit(`Creating the private ${profile.toUpperCase()} environment…`)
    await runStreaming(
      uv,
      ['venv', '--clear', '--managed-python', '--python', WINDOWS_PYTHON_VERSION, venvDir],
      uvEnv,
      emit,
      control
    )
    checkCancel()
    await runStreaming(
      uv,
      [
        'pip',
        'sync',
        '--python',
        targetPy,
        '--require-hashes',
        '--torch-backend',
        profile === 'cuda' ? 'cu128' : 'cpu',
        requirements
      ],
      uvEnv,
      emit,
      control
    )
    checkCancel()
    const verify = await capture(
      targetPy,
      [
        '-c',
        profile === 'cuda'
          ? 'import torch,numpy,soundfile,sys; sys.exit(0 if torch.cuda.is_available() else 1)'
          : 'import torch,numpy,soundfile'
      ],
      env,
      control
    )
    checkCancel()
    if (verify.code !== 0) throw new Error(verify.err || `${profile} runtime verification failed`)

    const requirementsSha256 = createHash('sha256')
      .update(await readFile(requirements))
      .digest('hex')
    const temporary = `${ready}.tmp-${process.pid}`
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({
          schema: 1,
          pythonVersion: WINDOWS_PYTHON_VERSION,
          uvVersion: WINDOWS_UV_VERSION,
          profile,
          requirementsSha256,
          readyAt: new Date().toISOString()
        }, null, 2)}\n`
      )
      checkCancel()
      await rename(temporary, ready)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  if (requested === 'cuda') {
    try {
      await install('cuda')
    } catch (error) {
      checkCancel()
      emit(`CUDA setup unavailable (${(error as Error).message}); falling back to CPU.`)
      await rm(venvDir, { recursive: true, force: true })
      await install('cpu')
    }
  } else {
    await install('cpu')
  }
  await mkdir(modelCacheDir(env), { recursive: true })
  return { pythonPath: targetPy }
}
