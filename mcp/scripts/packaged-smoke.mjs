#!/usr/bin/env node
/** Verify the bundled MCP entry from an isolated directory with no modules. */
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'stemstudio-packaged-mcp-'))
const project = resolve(import.meta.dirname, '..', '..')
const resources = join(root, 'resources')
const entryDir = join(resources, 'mcp')
const entry = join(entryDir, 'index.js')
await mkdir(entryDir, { recursive: true })
await mkdir(join(resources, 'python'), { recursive: true })
await copyFile(resolve(import.meta.dirname, '..', 'dist', 'index.js'), entry)
const userDataFolder = 'stem-studio-packaged-smoke'
await writeFile(
  join(resources, 'stem-studio-distribution.json'),
  `${JSON.stringify({ schemaVersion: 1, userDataFolder })}\n`
)

const platformDirectory = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin'
    ? 'macos-arm64'
    : null
const preparedRuntime = platformDirectory
  ? join(project, 'build', 'runtime', platformDirectory)
  : null
if (preparedRuntime && existsSync(preparedRuntime)) {
  await cp(preparedRuntime, join(resources, 'runtime-bootstrap', platformDirectory), {
    recursive: true
  })
}

const home = join(root, 'home')
const appData = join(root, 'appdata')
const xdgConfig = join(root, 'config')
const expectedUserData = process.platform === 'win32'
  ? join(appData, userDataFolder)
  : process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', userDataFolder)
    : join(xdgConfig, userDataFolder)
await mkdir(join(expectedUserData, 'models'), { recursive: true })

const env = {
  ...process.env,
  NODE_PATH: '',
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  XDG_CONFIG_HOME: xdgConfig
}
for (const key of Object.keys(env)) {
  if (key.startsWith('STEMSTUDIO_')) delete env[key]
}
const child = spawn(process.execPath, [entry], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
let buffer = ''
let stderr = ''
let id = 0
const pending = new Map()
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => (stderr += chunk))
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
    }
  }
})

function request(method, params) {
  const requestId = ++id
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}: ${stderr}`)), 15000)
    pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    })
  })
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'packaged-smoke', version: '1' }
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  const result = await request('tools/list', {})
  const separation = result.tools.find((tool) => tool.name === 'separate_stems')
  if (!separation) throw new Error('Packaged MCP did not register separate_stems')
  const engine = separation.inputSchema?.properties?.engine
  const quality = separation.inputSchema?.properties?.quality
  const engineSchema = JSON.stringify(engine)
  const qualitySchema = JSON.stringify(quality)
  if (process.platform === 'win32') {
    if (engineSchema.includes('stub') || engineSchema.includes('mvsep')) {
      throw new Error('Public Windows MCP schema exposes a disabled engine')
    }
    if (qualitySchema.includes('max')) {
      throw new Error('Public Windows MCP schema exposes disabled Max quality')
    }
  } else {
    for (const expected of ['stub', 'mvsep']) {
      if (!engineSchema.includes(expected)) {
        throw new Error(`Packaged ${process.platform} MCP lost legacy ${expected} support`)
      }
    }
    if (!qualitySchema.includes('max')) {
      throw new Error(`Packaged ${process.platform} MCP lost legacy Max quality`)
    }
  }
  const statusResult = await request('tools/call', {
    name: 'setup_status',
    arguments: {}
  })
  const status = JSON.parse(statusResult.content[0].text)
  const expectedPython = process.platform === 'win32'
    ? join(expectedUserData, 'runtime', 'v1', 'venv', 'Scripts', 'python.exe')
    : join(expectedUserData, 'venv', 'bin', 'python')
  if (status.pythonPath !== expectedPython || status.modelCacheDir !== join(expectedUserData, 'models')) {
    throw new Error(`Packaged MCP did not share app paths: ${JSON.stringify(status)}`)
  }

  if (preparedRuntime && existsSync(preparedRuntime)) {
    const ffmpeg = join(
      resources,
      'runtime-bootstrap',
      platformDirectory,
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    const fixture = join(root, "Packaged Probe '01' 场景.wav")
    const generated = spawnSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', fixture
    ], { windowsHide: true, stdio: 'ignore' })
    if (generated.status !== 0) throw new Error('Bundled FFmpeg fixture generation failed')
    const probeResult = await request('tools/call', {
      name: 'probe_media',
      arguments: { path: fixture }
    })
    if (probeResult.isError) throw new Error(`Bundled FFprobe failed: ${probeResult.content[0].text}`)
  }
  console.log(
    `Isolated packaged MCP initialized with ${result.tools.length} tools and shared app paths.`
  )
} finally {
  child.stdin.end()
  child.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}
