#!/usr/bin/env node
/**
 * Integration smoke test: build must have run first (dist/index.js exists).
 * Spawns the server over stdio, speaks raw MCP JSON-RPC 2.0 (newline-delimited),
 * and drives:
 *   initialize -> tools/list -> probe_media -> separate_stems(engine:stub)
 * on a freshly generated test WAV, then asserts the 4 delivery WAVs exist
 * (DIALOGUE, MUSIC, SFX, MARRIED).
 *
 * Env used for resolution (so the worktree can borrow the shared .venv):
 *   STEMSTUDIO_ROOT   repo root that contains python/
 *   STEMSTUDIO_PYTHON venv python with the stub engine's deps
 *   STEMSTUDIO_CACHE  scratch model cache dir
 *
 * Exits 0 on success, non-zero on any failure, printing a transcript summary.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MCP_DIR = resolve(HERE, '..')
const SERVER = process.env.STEMSTUDIO_MCP_ENTRY
  ? resolve(process.env.STEMSTUDIO_MCP_ENTRY)
  : join(MCP_DIR, 'dist', 'index.js')
const PACKAGED_RESOLUTION = process.env.SMOKE_PACKAGED_RESOLUTION === '1'

// Repo root: STEMSTUDIO_ROOT wins, else this worktree (mcp/..).
const REPO = process.env.STEMSTUDIO_ROOT
  ? resolve(process.env.STEMSTUDIO_ROOT)
  : resolve(MCP_DIR, '..')
// Python: STEMSTUDIO_PYTHON wins, else <repo>/.venv.
const PY =
  process.env.SMOKE_CLIENT_PYTHON ||
  process.env.STEMSTUDIO_PYTHON ||
  firstExistingSync([join(REPO, '.venv', 'bin', 'python')])

import { existsSync } from 'node:fs'
function firstExistingSync(paths) {
  for (const p of paths) if (existsSync(p)) return p
  return paths[0]
}

async function fileExists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Minimal JSON-RPC-over-stdio client for the server child. */
class Client {
  constructor(child) {
    this.child = child
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
  }
  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        if (process.env.SMOKE_DEBUG) console.error('[non-json]', line.slice(0, 120))
        continue
      }
      if (process.env.SMOKE_DEBUG)
        console.error('[recv]', line.slice(0, 160))
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
      } else if (msg.method) {
        this.notifications.push(msg)
      }
    }
  }
  request(method, params, timeoutMs = 300000) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    this.child.stdin.write(JSON.stringify(payload) + '\n')
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          rej(new Error(`timeout waiting for ${method}`))
        },
        timeoutMs
      )
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rej(e)
        }
      })
    })
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
}

/** Parse the JSON text a tool returns in content[0].text. */
function toolJson(result) {
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('tool returned no text content')
  return JSON.parse(text)
}

async function main() {
  if (!(await fileExists(SERVER))) {
    throw new Error(`server not built: ${SERVER} (run npm run build first)`)
  }

  const requestedRoot = process.env.STEMSTUDIO_SMOKE_ROOT
  const base = requestedRoot
    ? resolve(requestedRoot)
    : await mkdtemp(join(tmpdir(), 'stemstudio-smoke-'))
  const work = join(base, 'OneDrive - Studio', "Director's Cut", '场景 Assets')
  await mkdir(work, { recursive: true })
  const cache = join(work, 'cache')
  const inputWav = join(work, "Married Mix '01' 场景.wav")
  const inputVideo = join(work, "Picture Lock '01' 场景.mov")
  const outDir = join(work, "Output Stems 'Final' 场景")
  const engine = process.env.SMOKE_ENGINE || 'stub'
  const separationTimeoutMs = timeoutFromEnv(
    'SMOKE_SEPARATION_TIMEOUT_MS',
    engine === 'tiger' ? 1_200_000 : 300_000
  )
  const makeVideo = process.env.SMOKE_VIDEO === '1'
  const ffmpeg = process.env.STEMSTUDIO_FFMPEG || 'ffmpeg'
  const ffprobe = process.env.STEMSTUDIO_FFPROBE || 'ffprobe'
  const transcript = []

  // 1) Generate a test WAV via the repo's helper script (uses the venv).
  await runToCompletion(PY, [join(REPO, 'scripts', 'make_test_tone.py'), inputWav], {
    PYTHONPATH: join(REPO, 'python')
  })
  transcript.push(`generated test wav: ${inputWav}`)
  if (makeVideo) {
    await runToCompletion(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=5',
      '-i', inputWav,
      '-shortest',
      '-c:v', 'mpeg4',
      // AAC introduces codec padding; using the extracted 44.1 kHz working mix
      // for MARRIED is what keeps all four delivery WAVs sample-aligned.
      '-c:a', 'aac',
      inputVideo
    ])
    transcript.push(`generated video fixture: ${inputVideo}`)
  }
  const inputPath = makeVideo ? inputVideo : inputWav

  // 2) Launch the server.
  const launcher = process.env.STEMSTUDIO_MCP_LAUNCHER
    ? resolve(process.env.STEMSTUDIO_MCP_LAUNCHER)
    : null
  const command = launcher || process.execPath
  const commandArgs = launcher ? [] : [SERVER]
  const serverEnv = { ...process.env }
  if (PACKAGED_RESOLUTION) {
    for (const key of [
      'STEMSTUDIO_ROOT',
      'STEMSTUDIO_PYTHON',
      'STEMSTUDIO_FFMPEG',
      'STEMSTUDIO_FFPROBE',
      'STEMSTUDIO_CACHE',
      'STEMSTUDIO_RESOURCES',
      'STEMSTUDIO_USER_DATA',
      'STEMSTUDIO_USER_DATA_FOLDER'
    ]) delete serverEnv[key]
  } else {
    serverEnv.STEMSTUDIO_ROOT = REPO
    serverEnv.STEMSTUDIO_PYTHON = PY
    serverEnv.STEMSTUDIO_CACHE = cache
  }
  serverEnv.STEMSTUDIO_ENABLE_TEST_ENGINES = engine === 'stub' ? '1' : '0'
  const child = spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: serverEnv,
    windowsHide: true,
    // The packaged Windows bridge is a trusted generated .cmd file. Let Node
    // serialize its path through cmd.exe; manually nesting quotes breaks paths
    // containing spaces, apostrophes, and Unicode.
    shell: !!launcher && process.platform === 'win32'
  })
  let serverStderr = ''
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (d) => (serverStderr += d))
  const client = new Client(child)

  try {
    // initialize
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' }
    })
    transcript.push(`initialize -> serverInfo ${JSON.stringify(init.serverInfo)}`)
    client.notify('notifications/initialized', {})

    // tools/list
    const list = await client.request('tools/list', {})
    const names = list.tools.map((t) => t.name).sort()
    transcript.push(`tools/list -> ${names.join(', ')}`)
    const expected = [
      'cancel_job',
      'check_job',
      'probe_media',
      'separate_stems',
      'setup_environment',
      'setup_status'
    ]
    for (const t of expected) {
      if (!names.includes(t)) throw new Error(`tools/list missing ${t}`)
    }

    // probe_media
    const probeRes = await client.request('tools/call', {
      name: 'probe_media',
      arguments: { path: inputPath }
    })
    const probe = toolJson(probeRes)
    transcript.push(
      `probe_media -> duration=${probe.duration}s sr=${probe.sample_rate} ch=${probe.channels} has_video=${probe.has_video} format=${probe.format}`
    )
    if (probe.has_video !== makeVideo) throw new Error(`probe: unexpected has_video=${probe.has_video}`)
    if (probe.channels !== 2) throw new Error('probe: expected 2 channels')

    // separate_stems (stub engine, wait:true)
    const sepRes = await client.request(
      'tools/call',
      {
        name: 'separate_stems',
        arguments: {
          input_path: inputPath,
          output_dir: outDir,
          engine,
          multitrack_video: makeVideo,
          wait: true
        },
        _meta: { progressToken: 'smoke-1' }
      },
      separationTimeoutMs
    )
    if (sepRes.isError) throw new Error(`separate_stems failed: ${sepRes.content?.[0]?.text}`)
    const sep = toolJson(sepRes)
    transcript.push(`separate_stems -> status=${sep.status} output_dir=${sep.output_dir}`)
    const progressNotes = client.notifications.filter(
      (n) => n.method === 'notifications/progress'
    )
    transcript.push(`progress notifications received: ${progressNotes.length}`)

    // Assert the 4 delivery WAVs exist.
    const deliveries = [
      sep.stems.dialogue,
      sep.stems.music,
      sep.stems.sfx,
      sep.married
    ]
    for (const p of deliveries) {
      if (!p || !(await fileExists(p))) throw new Error(`missing delivery file: ${p}`)
    }
    await runToCompletion(PY, [
      join(REPO, 'python', 'verify_deliveries.py'),
      sep.married,
      sep.stems.dialogue,
      sep.stems.music,
      sep.stems.sfx
    ])
    transcript.push('sample alignment and mixture consistency verified')

    if (makeVideo) {
      if (!sep.multitrack_video || !(await fileExists(sep.multitrack_video))) {
        throw new Error(`missing multitrack delivery: ${sep.multitrack_video}`)
      }
      const metadata = JSON.parse(await captureToCompletion(ffprobe, [
        '-v', 'error', '-show_streams', '-of', 'json', sep.multitrack_video
      ]))
      const titles = metadata.streams
        .filter((stream) => stream.codec_type === 'audio')
        .map((stream) =>
          stream.tags?.handler_name || stream.tags?.title || stream.tags?.name
        )
      for (const expected of ['Dialogue', 'Music', 'SFX']) {
        if (!titles.includes(expected)) throw new Error(`multitrack labels missing ${expected}: ${titles}`)
      }
      transcript.push(`multitrack labels verified: ${titles.join(', ')}`)
    }
    transcript.push(`delivery WAVs verified (4):`)
    for (const p of deliveries) transcript.push(`  - ${p}`)

    console.log('\n=== SMOKE TRANSCRIPT ===')
    for (const line of transcript) console.log(line)
    console.log('=== SMOKE PASS ===\n')
  } finally {
    await stopServerChild(child)
    if (serverStderr.trim()) {
      console.error('--- server stderr ---\n' + serverStderr.trim())
    }
    if (process.env.SMOKE_KEEP_OUTPUT !== '1') {
      await rm(requestedRoot ? base : work, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function timeoutFromEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error(`${name} must be an integer from 1000 to 3600000 milliseconds`)
  }
  return value
}

async function stopServerChild(child) {
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

function captureToCompletion(cmd, args, extraEnv = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...extraEnv
      },
      windowsHide: true
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (data) => (out += data))
    child.stderr.on('data', (data) => (err += data))
    child.on('error', rej)
    child.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error(`${cmd} exited ${code}: ${err.slice(-1000)}`))
    )
  })
}

function runToCompletion(cmd, args, extraEnv = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...extraEnv
      }
    })
    let err = ''
    c.stderr.on('data', (d) => (err += d))
    c.on('error', rej)
    c.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.slice(-1000)}`))
    )
  })
}

main().catch((e) => {
  console.error('=== SMOKE FAIL ===')
  console.error(e.stack || String(e))
  process.exit(1)
})
