import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const [packageRootArgument] = process.argv.slice(2)
if (!packageRootArgument) {
  throw new Error('Usage: packaged-waveform-smoke.mjs <unpacked-package-root>')
}

const packageRoot = resolve(packageRootArgument)
const packageEntries = await readdir(packageRoot, { withFileTypes: true })
let appExe
if (process.platform === 'win32') {
  const entry = packageEntries.find((candidate) =>
    candidate.isFile() && candidate.name.endsWith('.exe') && !candidate.name.startsWith('Uninstall')
  )
  if (entry) appExe = join(packageRoot, entry.name)
} else if (process.platform === 'darwin') {
  const entry = packageEntries.find((candidate) => candidate.isDirectory() && candidate.name.endsWith('.app'))
  if (entry) {
    const appName = entry.name.slice(0, -4)
    appExe = join(packageRoot, entry.name, 'Contents', 'MacOS', appName)
  }
} else {
  const entry = packageEntries.find((candidate) => candidate.isFile())
  if (entry) appExe = join(packageRoot, entry.name)
}
if (!appExe) throw new Error(`Packaged executable missing below ${packageRoot}`)

const root = await mkdtemp(join(tmpdir(), 'stem-waveform-'))
const scene = join(root, 'OneDrive - Studio', "Director's Cut", '场景 Waveform')
const input = join(scene, 'UI Married 场景.wav')
const outputDir = join(scene, 'Delivered Stems')
const userData = join(scene, 'User Data')
await mkdir(outputDir, { recursive: true })

function pcmWave({ frequency, seconds = 1, sampleRate = 48_000 }) {
  const frameCount = Math.round(seconds * sampleRate)
  const dataBytes = frameCount * 2
  const output = Buffer.alloc(44 + dataBytes)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataBytes, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((frame * frequency * Math.PI * 2) / sampleRate) * 12_000)
    output.writeInt16LE(sample, 44 + frame * 2)
  }
  return output
}

const paths = {
  married: join(outputDir, 'UI Married 场景_MARRIED.wav'),
  dialogue: join(outputDir, 'UI Married 场景_DIALOGUE.wav'),
  music: join(outputDir, 'UI Married 场景_MUSIC.wav'),
  sfx: join(outputDir, 'UI Married 场景_SFX.wav')
}
await writeFile(input, pcmWave({ frequency: 220 }))
await Promise.all([
  writeFile(paths.married, pcmWave({ frequency: 220 })),
  writeFile(paths.dialogue, pcmWave({ frequency: 330 })),
  writeFile(paths.music, pcmWave({ frequency: 440 })),
  writeFile(paths.sfx, pcmWave({ frequency: 550 }))
])

const result = {
  jobId: '00000000-0000-4000-8000-000000000000',
  stems: { dialogue: paths.dialogue, music: paths.music, sfx: paths.sfx },
  marriedMix: paths.married,
  outputDir
}

let application
try {
  application = await electron.launch({
    executablePath: appExe,
    env: { ...process.env, STEMSTUDIO_USER_DATA: userData, STEMSTUDIO_DEVICE: 'cpu' },
    timeout: 60_000
  })
  await application.evaluate(
    ({ BrowserWindow, ipcMain, shell }, { input, outputDir, result }) => {
      ipcMain.removeHandler('openFileDialog')
      ipcMain.handle('openFileDialog', () => ({
        ok: true,
        info: {
          path: input,
          name: input.split(/[\\/]/).at(-1),
          ext: 'wav',
          duration: 1,
          sampleRate: 48_000,
          channels: 1,
          hasVideo: false,
          format: 'wav / pcm_s16le'
        }
      }))
      ipcMain.removeHandler('pickOutputFolder')
      ipcMain.handle('pickOutputFolder', () => outputDir)
      ipcMain.removeHandler('separate')
      ipcMain.handle('separate', (_event, jobId) => {
        setTimeout(() => {
          BrowserWindow.getAllWindows()[0]?.webContents.send('job:done', { ...result, jobId })
        }, 50)
        return { ok: true, jobId }
      })
      globalThis.__stemWaveformShownPath = null
      shell.showItemInFolder = (path) => {
        globalThis.__stemWaveformShownPath = path
      }
    },
    { input, outputDir, result }
  )

  const page = await application.firstWindow({ timeout: 60_000 })
  const rendererErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  await page.waitForSelector('.dropzone', { state: 'visible', timeout: 60_000 })
  await page.click('.dropzone')
  await page.waitForSelector('.file-card', { state: 'visible', timeout: 60_000 })
  await page.click('.folder-row .btn-ghost')
  await page.waitForFunction(
    (expected) => document.querySelector('.folder-path')?.getAttribute('title') === expected,
    outputDir,
    { timeout: 60_000 }
  )
  await page.click('.btn-primary.btn-lg')
  await page.waitForSelector('.done-header', { state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => {
    const canvases = Array.from(document.querySelectorAll('canvas.lane-canvas'))
    if (document.querySelectorAll('.lane').length !== 4 || canvases.length !== 4) return false
    return canvases.every((canvas) => {
      const context = canvas.getContext('2d')
      if (!context || !canvas.width || !canvas.height) return false
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] !== 0) return true
      }
      return false
    })
  }, undefined, { timeout: 60_000 })

  const protocol = await page.evaluate(async (paths) => {
    const checks = []
    for (const path of paths) {
      const response = await fetch(window.stemstudio.stemUrl(path))
      const bytes = await response.arrayBuffer()
      const context = new AudioContext()
      const buffer = await context.decodeAudioData(bytes.slice(0))
      checks.push({
        path,
        status: response.status,
        cors: response.headers.get('access-control-allow-origin'),
        contentType: response.headers.get('content-type'),
        bytes: bytes.byteLength,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels
      })
      await context.close()
    }
    return checks
  }, Object.values(paths))

  const reveal = page.locator('.lane.married .lane-btn.reveal')
  const revealLabel = (await reveal.innerText()).trim()
  await reveal.click()
  const shownPath = await application.evaluate(() => globalThis.__stemWaveformShownPath)
  if (revealLabel !== (process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder')) {
    throw new Error(`Unexpected reveal label: ${revealLabel}`)
  }
  if (shownPath !== paths.married) {
    throw new Error(`Reveal routed ${shownPath}; expected ${paths.married}`)
  }
  if (protocol.some((check) => check.status !== 200 || check.cors !== '*' || check.duration <= 0)) {
    throw new Error(`Packaged protocol verification failed: ${JSON.stringify(protocol)}`)
  }
  if (rendererErrors.some((message) => message.includes('stem://') || message.includes('CORS'))) {
    throw new Error(`Renderer logged preview errors: ${rendererErrors.join('\n')}`)
  }

  const sizes = {}
  for (const path of Object.values(paths)) sizes[basename(path)] = (await stat(path)).size
  console.log(JSON.stringify({
    passed: true,
    appExe,
    nestedPath: scene,
    waveforms: 4,
    nonTransparentCanvases: 4,
    protocol,
    revealLabel,
    shownPath,
    sizes
  }, null, 2))
} finally {
  await application?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
