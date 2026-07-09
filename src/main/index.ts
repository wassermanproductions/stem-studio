/**
 * Electron main process: window lifecycle, the safe `stem://` media protocol,
 * file dialogs, ffprobe probing, and separation-job orchestration. All
 * filesystem and process access lives here; the renderer talks through the
 * typed IPC surface in src/preload.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } from 'electron'
import { join, dirname, extname } from 'path'
import { pathToFileURL } from 'url'

import { probe, isSupportedInput } from './ffmpeg'
import { runJob, cancelJob, probeWorker } from './job'
import { findReadyPython } from './pythonEnv'
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type SeparateOptions,
  type PythonEnvStatus,
  type WorkerProbe
} from '../shared/types'
import { version as APP_VERSION } from '../../package.json'

const isDev = !!process.env.ELECTRON_RENDERER_URL

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
    width: 900,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'Stem Studio',
    backgroundColor: '#111113',
    titleBarStyle: 'hiddenInset',
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

app.whenReady().then(() => {
  // `stem://host/<url-encoded-abs-path>` -> file on disk. We decode the path
  // from the URL pathname; the host segment is ignored.
  protocol.handle('stem', (request) => {
    const url = new URL(request.url)
    const abs = decodeURIComponent(url.pathname)
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

// Device/engine probe — the renderer uses this to default the quality tier
// (cuda→max, mps→high, cpu→fast). Non-throwing; returns a cpu fallback if the
// worker isn't ready yet.
ipcMain.handle('workerProbe', async (): Promise<WorkerProbe> => {
  return probeWorker()
})

// Start a separation job. Progress/result/error are pushed over events keyed
// by jobId.
ipcMain.handle('separate', async (_e, opts: SeparateOptions) => {
  try {
    const result = await runJob(opts, {
      onProgress: (p) => send('job:progress', p),
      onSetup: (detail) => send('job:setup', detail)
    })
    send('job:done', result)
    return { ok: true, jobId: result.jobId }
  } catch (err) {
    const message = (err as Error).message
    if (message === 'Cancelled') {
      send('job:cancelled')
      return { ok: false, cancelled: true }
    }
    send('job:error', { message, detail: (err as Error).stack })
    return { ok: false, error: message }
  }
})

ipcMain.handle('cancel', (_e, jobId: string) => {
  cancelJob(jobId)
  return true
})

// Reveal a file/folder in Finder.
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
