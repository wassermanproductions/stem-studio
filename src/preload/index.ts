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
  WorkerProbe
} from '../shared/types'

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
    opts: SeparateOptions
  ): Promise<{ ok: boolean; jobId?: string; error?: string; cancelled?: boolean }>
  cancel(jobId: string): Promise<boolean>
  revealInFinder(path: string): Promise<boolean>
  openFolder(path: string): Promise<boolean>
  versions(): Promise<{ app: string; electron: string; node: string }>

  /** Convert an absolute file path to a stem:// preview URL. */
  stemUrl(path: string): string

  onProgress(cb: (p: JobProgress) => void): () => void
  onSetup(cb: (detail: string) => void): () => void
  onDone(cb: (result: JobResult) => void): () => void
  onError(cb: (err: JobError) => void): () => void
  onCancelled(cb: () => void): () => void
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
  separate: (opts) => ipcRenderer.invoke('separate', opts),
  cancel: (jobId) => ipcRenderer.invoke('cancel', jobId),
  revealInFinder: (path) => ipcRenderer.invoke('revealInFinder', path),
  openFolder: (path) => ipcRenderer.invoke('openFolder', path),
  versions: () => ipcRenderer.invoke('versions'),
  // Encode the absolute path into the URL path so the main-process handler can
  // decode it back. A fixed host keeps it a valid standard URL.
  stemUrl: (path) => `stem://local/${encodeURIComponent(path)}`,
  onProgress: (cb) => on('job:progress', cb),
  onSetup: (cb) => on('job:setup', cb),
  onDone: (cb) => on('job:done', cb),
  onError: (cb) => on('job:error', cb),
  onCancelled: (cb) => on('job:cancelled', () => cb())
}

contextBridge.exposeInMainWorld('stemstudio', api)
