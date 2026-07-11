import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

const liveChildren = new Set<ChildProcess>()
const closedChildren = new WeakSet<ChildProcess>()
const TASKKILL_TIMEOUT_MS = 5_000

/** GUI-safe spawn defaults. POSIX gets a process group; Windows uses taskkill. */
export function childSpawnOptions(extra: SpawnOptions = {}): SpawnOptions {
  return {
    windowsHide: true,
    detached: process.platform !== 'win32',
    ...extra
  }
}

/** Register every long-lived app child for quit-time cleanup. */
export function trackProcess(child: ChildProcess): ChildProcess {
  liveChildren.add(child)
  child.once('close', () => {
    closedChildren.add(child)
    liveChildren.delete(child)
  })
  return child
}

/** Resolve only after `close` (stdio released), even if `exit` already fired. */
export function waitForExit(child: ChildProcess): Promise<void> {
  if (closedChildren.has(child)) return Promise.resolve()
  return new Promise((resolve) => child.once('close', () => resolve()))
}

async function taskkillTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL') } catch { /* already gone */ }
      finish(false)
    }, TASKKILL_TIMEOUT_MS)
    killer.once('error', () => finish(false))
    killer.once('close', (code) => finish(code === 0))
  })
}

/** Terminate a child and descendants, then wait for handles to be released. */
export async function terminateProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child || closedChildren.has(child)) return
  const exited = waitForExit(child)
  if (child.exitCode === null && child.signalCode === null && process.platform === 'win32') {
    const killed = await taskkillTree(child)
    if (!killed) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  await exited
}

/** Stop every tracked child before Electron exits. */
export async function terminateAllProcesses(): Promise<void> {
  await Promise.all([...liveChildren].map((child) => terminateProcessTree(child)))
}
