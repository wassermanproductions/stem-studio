/**
 * Renderer-side helpers for turning a probed input into store state, and for
 * kicking off a separation run.
 */

import { useStore } from './store'
import type { ProbeResult } from '@shared/types'

/** Load a probed input, resolving a default output folder (its own dir). */
export async function loadProbed(info: ProbeResult): Promise<void> {
  const outputDir = await window.stemstudio.defaultOutputFolder(info.path)
  useStore.getState().setInput(info, outputDir)
}

/** Open the file dialog and load the chosen input. Returns an error string. */
export async function openViaDialog(): Promise<string | null> {
  const reply = await window.stemstudio.openFileDialog()
  if (!reply.ok) return reply.cancelled ? null : (reply.error ?? 'Could not open file')
  await loadProbed(reply.info)
  return null
}

/** Probe a dropped file path and load it. Returns an error string or null. */
export async function loadFromPath(path: string): Promise<string | null> {
  const reply = await window.stemstudio.probe(path)
  if (!reply.ok) return reply.error ?? 'Unsupported file'
  await loadProbed(reply.info)
  return null
}

/** Start a separation run using the current store state. */
export async function startSeparation(): Promise<void> {
  const s = useStore.getState()
  if (!s.input || !s.outputDir) return
  const jobId = crypto.randomUUID()
  s.beginSeparate(jobId)
  const accepted = await window.stemstudio.separate(jobId, {
    inputPath: s.input.path,
    outputDir: s.outputDir,
    multitrackVideo: s.multitrackVideo && s.input.hasVideo,
    quality: s.quality,
    polishDialogue: s.polishDialogue
  })
  if (!accepted.ok && useStore.getState().currentJobId === jobId) {
    useStore.getState().finishError({
      jobId,
      message: accepted.error ?? 'Could not start separation.'
    })
  }
}

/** Probe the worker's device stack and store it (defaults the quality tier).
 * Safe to call on startup; never throws. */
export async function loadProbe(): Promise<void> {
  try {
    const probe = await window.stemstudio.workerProbe()
    useStore.getState().applyProbe(probe)
  } catch {
    /* leave the default quality in place */
  }
}

/** Human-readable duration mm:ss. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
