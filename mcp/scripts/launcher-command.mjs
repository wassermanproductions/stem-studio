import { spawn } from 'node:child_process'

/**
 * Build a shell-free spawn contract for either the bundled launcher or the
 * source MCP entry. Windows batch files are not PE executables, so invoke the
 * configured command processor explicitly. Passing the launcher as its own
 * argv element lets Node quote spaces, apostrophes, and Unicode exactly once;
 * `shell: true` would concatenate and re-parse the path as an unquoted command.
 */
export function launcherCommand({
  launcher,
  server,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath
}) {
  if (!launcher) return { command: execPath, args: [server] }
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', launcher]
    }
  }
  return { command: launcher, args: [] }
}

/** Close stdio first, then terminate the whole tree only if it does not exit. */
export async function stopServerChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolvePromise) => child.once('close', () => resolvePromise(true)))
  try { child.stdin.end() } catch {}
  if (await Promise.race([closed, delay(15_000, false)])) return

  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', resolvePromise)
      killer.once('close', resolvePromise)
    })
  } else {
    try { child.kill('SIGKILL') } catch {}
  }
  await Promise.race([closed, delay(5_000, false)])
}

function delay(ms, value) {
  return new Promise((resolvePromise) => setTimeout(() => resolvePromise(value), ms))
}
