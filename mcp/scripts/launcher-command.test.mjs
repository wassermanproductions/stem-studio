import assert from 'node:assert/strict'
import test from 'node:test'

import { launcherCommand } from './launcher-command.mjs'

test('Windows batch launchers use COMSPEC argv without shell string parsing', () => {
  const launcher = "C:\\OneDrive - Studio\\Director's Cut\\场景 App\\stem-studio-mcp.cmd"
  assert.deepEqual(
    launcherCommand({
      launcher,
      server: 'unused',
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      execPath: 'node.exe'
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', launcher]
    }
  )
})

test('POSIX launchers remain direct executable spawns', () => {
  assert.deepEqual(
    launcherCommand({
      launcher: "/Applications/Director's Cut/场景/stem-studio-mcp",
      server: 'unused',
      platform: 'darwin',
      env: {},
      execPath: '/usr/bin/node'
    }),
    {
      command: "/Applications/Director's Cut/场景/stem-studio-mcp",
      args: []
    }
  )
})

test('source runs continue to use the current Node executable', () => {
  assert.deepEqual(
    launcherCommand({
      launcher: null,
      server: '/repo/mcp/dist/index.js',
      platform: 'linux',
      env: {},
      execPath: '/usr/bin/node'
    }),
    {
      command: '/usr/bin/node',
      args: ['/repo/mcp/dist/index.js']
    }
  )
})
