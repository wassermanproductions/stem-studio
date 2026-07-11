/**
 * Electron main process: window lifecycle, the safe `stem://` media protocol,
 * file dialogs, ffprobe probing, and separation-job orchestration. All
 * filesystem and process access lives here; the renderer talks through the
 * typed IPC surface in src/preload.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join, dirname, extname, isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'

import { probe, isSupportedInput, ffmpegPath, ffprobePath } from './ffmpeg'
import { runJob, cancelJob, cancelAllJobs, probeWorker } from './job'
import { findReadyPython, repairPrivateRuntime, setupUserVenv } from './pythonEnv'
import { terminateAllProcesses } from './process'
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type SeparateOptions,
  type PythonEnvStatus,
  type WorkerProbe
} from '../shared/types'
import { version as APP_VERSION } from '../../package.json'

const isDev = !!process.env.ELECTRON_RENDERER_URL

interface BuildMetadata {
  isCommunityBuild?: boolean
  displayName?: string
  userDataFolder?: string
  appId?: string
  maintainer?: string
}

function packagedBuildMetadata(): BuildMetadata {
  if (!app.isPackaged) return {}
  try {
    const pkg = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    ) as { distribution?: BuildMetadata }
    return pkg.distribution ?? {}
  } catch {
    return {}
  }
}

// Generic builds contain no downstream branding. The community overlay injects
// identity/data/credit metadata into the packaged package.json.
const buildMetadata = packagedBuildMetadata()
const isCommunityBuild = buildMetadata.isCommunityBuild === true
const displayName = buildMetadata.displayName ?? 'Stem Studio'
const dataFolder = buildMetadata.userDataFolder ?? 'stem-studio'
const userDataOverride = process.env.STEMSTUDIO_USER_DATA?.trim()
if (userDataOverride && !isAbsolute(userDataOverride)) {
  throw new Error('STEMSTUDIO_USER_DATA must be an absolute path.')
}
app.setPath('userData', userDataOverride ?? join(app.getPath('appData'), dataFolder))
app.setName(displayName)
if (process.platform === 'win32') {
  app.setAppUserModelId(
    buildMetadata.appId ?? 'com.wassermanproductions.stemstudio'
  )
}

let mainWindow: BrowserWindow | null = null

// Register `stem://` as a privileged, stream-capable scheme so <audio> can
// preview stem files without exposing the whole filesystem via file://.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stem',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    title: displayName,
    backgroundColor: '#08090c',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // Linux has no packaged app icon by default; point it at build/icon.png.
    // (macOS/Windows use the icons wired in electron-builder.yml.)
    ...(process.platform === 'linux'
      ? { icon: join(__dirname, '../../build/icon.png') }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// External links only open in the system browser if their host is on this
// allowlist and they are https — the credit footer and Help menu route through
// it via shell:openExternal. Mirrors the Blockout suite convention.
const EXTERNAL_LINK_ALLOWLIST = new Set(['wassermanproductions.com', 'wasserman.ai', 'github.com'])

async function openExternal(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (parsed.protocol !== 'https:' || !EXTERNAL_LINK_ALLOWLIST.has(host)) return false
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
}

const REPO_URL = 'https://github.com/wassermanproductions/stem-studio'

/** Build the macOS application menu (app name, standard Edit/View roles, Help). */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:openFile')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    {
      role: 'help',
      submenu: [
        {
          label: 'Stem Studio on GitHub',
          click: () => void openExternal(REPO_URL)
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  if (process.argv.includes('--setup-runtime-smoke')) {
    try {
      const python = await setupUserVenv((detail) => process.stdout.write(`${detail}\n`))
      process.stdout.write(`${JSON.stringify({ ok: true, python })}\n`)
      app.exit(0)
    } catch (error) {
      process.stderr.write(`Managed runtime smoke failed: ${(error as Error).message}\n`)
      app.exit(1)
    }
    return
  }
  if (process.argv.includes('--smoke-runtime')) {
    try {
      const tools: Array<[string, string, string[]]> = [
        ['ffmpeg', await ffmpegPath(), ['-version']],
        ['ffprobe', await ffprobePath(), ['-version']]
      ]
      if (process.platform === 'win32') {
        tools.push([
          'uv',
          join(process.resourcesPath, 'runtime-bootstrap', 'windows', 'uv.exe'),
          ['--version']
        ])
      }
      for (const [name, executable, args] of tools) {
        const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8' })
        if (result.status !== 0) {
          throw new Error(`${name} runtime smoke failed (${executable}): ${result.stderr}`)
        }
      }
      process.stdout.write(`${JSON.stringify({ ok: true, tools: tools.map(([, path]) => path) })}\n`)
      app.exit(0)
    } catch (error) {
      process.stderr.write(`Runtime smoke failed: ${(error as Error).message}\n`)
      app.exit(1)
    }
    return
  }

  // macOS "About Stem Studio" panel — identity, version, credit.
  app.setAboutPanelOptions({
    applicationName: displayName,
    applicationVersion: app.getVersion(),
    version: '',
    copyright: '© 2026 Sam Wasserman',
    credits: [
      'Created by Sam Wasserman — wassermanproductions.com · wasserman.ai',
      buildMetadata.maintainer
    ].filter(Boolean).join('\n')
  })

  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  else buildAppMenu()

  // Query encoding preserves drive letters and UNC prefixes. The pathname
  // fallback keeps preview URLs generated by older builds working.
  protocol.handle('stem', (request) => {
    const url = new URL(request.url)
    const abs = url.searchParams.get('path') ?? decodeURIComponent(url.pathname)
    if (!isAbsolute(abs)) return new Response('Invalid media path', { status: 400 })
    return net.fetch(pathToFileURL(abs).toString())
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitCleanupStarted = false
let quitCleanupComplete = false
app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  void (async () => {
    try {
      await cancelAllJobs()
      await terminateAllProcesses()
    } finally {
      quitCleanupComplete = true
      app.quit()
    }
  })()
})

/* -------------------------------- IPC ---------------------------------- */

function send(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

// Probe a file path (from drag-drop or dialog) and return input info.
ipcMain.handle('probe', async (_e, path: string) => {
  const ext = extname(path).slice(1).toLowerCase()
  if (!isSupportedInput(ext)) {
    return { ok: false, error: `Unsupported file type: .${ext}` }
  }
  try {
    const info = await probe(path)
    return { ok: true, info }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

// Open-file dialog; returns a probed input or null if cancelled.
ipcMain.handle('openFileDialog', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio / Video',
        extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]
      }
    ]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false, cancelled: true }
  try {
    const info = await probe(res.filePaths[0])
    return { ok: true, info }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

// Pick an output folder.
ipcMain.handle('pickOutputFolder', async (_e, defaultPath?: string) => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath
  })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
})

// Default output folder for an input: the folder the input lives in.
ipcMain.handle('defaultOutputFolder', (_e, inputPath: string) => {
  return dirname(inputPath)
})

// Python env status (for the setup screen).
ipcMain.handle('pythonStatus', async (): Promise<PythonEnvStatus> => {
  const py = await findReadyPython()
  return py ? { ready: true, venvPath: py } : { ready: false }
})

// Device/engine probe — the renderer defaults GPU devices to high and CPU to
// fast. Non-throwing; returns a cpu fallback if the
// worker isn't ready yet.
ipcMain.handle('workerProbe', async (): Promise<WorkerProbe> => {
  return probeWorker()
})

// Start a separation job. The renderer allocates the id before showing the
// progress screen, so even an immediate Cancel targets real work.
ipcMain.handle('separate', (_e, jobId: string, opts: SeparateOptions) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return { ok: false, error: 'Invalid job identifier.' }
  }
  const result = runJob(jobId, opts, {
      onProgress: (p) => send('job:progress', p),
      onSetup: (detail) => send('job:setup', detail)
    })
  void result.then((completed) => {
    send('job:done', completed)
  }).catch((err: unknown) => {
    const message = (err as Error).message
    if (message === 'Cancelled') {
      send('job:cancelled', jobId)
    } else {
      send('job:error', { jobId, message, detail: (err as Error).stack })
    }
  })
  return { ok: true, jobId }
})

ipcMain.handle('cancel', async (_e, jobId: string) => {
  await cancelJob(jobId)
  return true
})

ipcMain.handle('repairRuntime', async () => {
  try {
    await cancelAllJobs()
    await repairPrivateRuntime()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
})

// Reveal a file/folder in Finder or File Explorer.
ipcMain.handle('revealInFinder', (_e, path: string) => {
  shell.showItemInFolder(path)
  return true
})

ipcMain.handle('openFolder', (_e, path: string) => {
  void shell.openPath(path)
  return true
})

ipcMain.handle('versions', () => ({
  app: APP_VERSION,
  electron: process.versions.electron,
  node: process.versions.node
}))

ipcMain.handle('platformInfo', () => ({
  platform:
    process.platform === 'darwin'
      ? 'mac'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux',
  appName: displayName,
  showInFolderLabel: process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder',
  isCommunityBuild,
  maintainerCredit: buildMetadata.maintainer
}))

// Open an allowlisted external link (credit footer, About panel) in the system
// browser. Returns false for anything not https + on the allowlist.
ipcMain.handle('shell:openExternal', (_e, url: string) => openExternal(url))
