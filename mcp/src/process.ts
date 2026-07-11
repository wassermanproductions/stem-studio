import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const closedChildren = new WeakSet<ChildProcess>()
const TASKKILL_TIMEOUT_MS = 5_000

export function childSpawnOptions(extra: SpawnOptions = {}): SpawnOptions {
  return { windowsHide: true, detached: process.platform !== 'win32', ...extra }
}

export function trackProcess(child: ChildProcess): ChildProcess {
  child.once('close', () => closedChildren.add(child))
  return child
}

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

export async function killTree(child: ChildProcess | undefined): Promise<void> {
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
