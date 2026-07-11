// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * Typed IPC bridge. The renderer sees exactly this surface as
 * window.stemstudio — nothing else from Node.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ProbeResult,
  SeparateOptions,
  JobProgress,
  JobResult,
  JobError,
  PythonEnvStatus,
  WorkerProbe,
  PlatformInfo
} from '../shared/types'
import { version as APP_VERSION } from '../../package.json'
import { stemPreviewUrl } from '../shared/paths'

type ProbeReply =
  | { ok: true; info: ProbeResult }
  | { ok: false; error?: string; cancelled?: boolean }

export interface StemStudioAPI {
  /** Probe a path (from drag-drop). */
  probe(path: string): Promise<ProbeReply>
  /** Open-file dialog + probe. */
  openFileDialog(): Promise<ProbeReply>
  /** Resolve a dropped File object to its absolute path (Electron 32+). */
  pathForFile(file: File): string
  pickOutputFolder(defaultPath?: string): Promise<string | null>
  defaultOutputFolder(inputPath: string): Promise<string>
  pythonStatus(): Promise<PythonEnvStatus>
  /** Probe the worker's torch/device stack (defaults the quality tier). */
  workerProbe(): Promise<WorkerProbe>
  separate(
    jobId: string,
    opts: SeparateOptions
  ): Promise<{ ok: boolean; jobId?: string; error?: string }>
  cancel(jobId: string): Promise<boolean>
  /** Stop tracked children and remove only the app-managed private runtime. */
  repairRuntime(): Promise<{ ok: boolean; error?: string }>
  revealInFinder(path: string): Promise<boolean>
  openFolder(path: string): Promise<boolean>
  /** Open an allowlisted https link in the system browser. */
  openExternal(url: string): Promise<boolean>
  versions(): Promise<{ app: string; electron: string; node: string }>
  platformInfo(): Promise<PlatformInfo>
  /** The app version (single source of truth: package.json via app.getVersion()). */
  appVersion: string

  /** Convert an absolute file path to a stem:// preview URL. */
  stemUrl(path: string): string

  onProgress(cb: (p: JobProgress) => void): () => void
  onSetup(cb: (detail: string) => void): () => void
  onDone(cb: (result: JobResult) => void): () => void
  onError(cb: (err: JobError) => void): () => void
  onCancelled(cb: (jobId: string) => void): () => void
  /** Fired when File → Open File… is chosen from the application menu. */
  onMenuOpenFile(cb: () => void): () => void
}

function on<T>(channel: string, cb: (arg: T) => void): () => void {
  const listener = (_e: unknown, arg: T) => cb(arg)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StemStudioAPI = {
  probe: (path) => ipcRenderer.invoke('probe', path),
  openFileDialog: () => ipcRenderer.invoke('openFileDialog'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickOutputFolder: (defaultPath) => ipcRenderer.invoke('pickOutputFolder', defaultPath),
  defaultOutputFolder: (inputPath) => ipcRenderer.invoke('defaultOutputFolder', inputPath),
  pythonStatus: () => ipcRenderer.invoke('pythonStatus'),
  workerProbe: () => ipcRenderer.invoke('workerProbe'),
  separate: (jobId, opts) => ipcRenderer.invoke('separate', jobId, opts),
  cancel: (jobId) => ipcRenderer.invoke('cancel', jobId),
  repairRuntime: () => ipcRenderer.invoke('repairRuntime'),
  revealInFinder: (path) => ipcRenderer.invoke('revealInFinder', path),
  openFolder: (path) => ipcRenderer.invoke('openFolder', path),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  versions: () => ipcRenderer.invoke('versions'),
  appVersion: APP_VERSION,
  platformInfo: () => ipcRenderer.invoke('platformInfo'),
  stemUrl: stemPreviewUrl,
  onProgress: (cb) => on('job:progress', cb),
  onSetup: (cb) => on('job:setup', cb),
  onDone: (cb) => on('job:done', cb),
  onError: (cb) => on('job:error', cb),
  onCancelled: (cb) => on('job:cancelled', cb),
  onMenuOpenFile: (cb) => on('menu:openFile', () => cb())
}

contextBridge.exposeInMainWorld('stemstudio', api)
