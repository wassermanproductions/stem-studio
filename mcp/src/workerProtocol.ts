/**
 * Parser for the Python worker's line-delimited JSON stdout. Mirrors the app's
 * `src/shared/workerProtocol.ts`: a stream-safe LineParser buffers partial
 * chunks; parseWorkerLine validates one line into a typed WorkerEvent (or null
 * for blank/non-JSON noise). Anything that is not a valid event is ignored, per
 * the worker-protocol contract.
 */

import type { WorkerEvent, WorkerStage } from './types.js'

const STAGES: WorkerStage[] = ['loading', 'separating', 'writing']

/** Validate + narrow a single already-split line into a WorkerEvent. */
export function parseWorkerLine(line: string): WorkerEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const rec = obj as Record<string, unknown>

  switch (rec.event) {
    case 'progress': {
      if (!STAGES.includes(rec.stage as WorkerStage)) return null
      const percent = Number(rec.percent)
      if (!Number.isFinite(percent)) return null
      return {
        event: 'progress',
        stage: rec.stage as WorkerStage,
        percent: Math.max(0, Math.min(100, percent))
      }
    }
    case 'done': {
      const outputs = rec.outputs
      if (typeof outputs !== 'object' || outputs === null) return null
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(outputs as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return { event: 'done', outputs: out }
    }
    case 'error': {
      const message =
        typeof rec.message === 'string' ? rec.message : 'Unknown worker error'
      return { event: 'error', message }
    }
    default:
      return null
  }
}

/**
 * Buffers raw stdout chunks and yields complete-line WorkerEvents. Retains any
 * trailing partial line until the next chunk completes it.
 */
export class LineParser {
  private buffer = ''

  /** Feed a chunk; returns every WorkerEvent completed by it. */
  push(chunk: string): WorkerEvent[] {
    this.buffer += chunk
    const events: WorkerEvent[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const ev = parseWorkerLine(line)
      if (ev) events.push(ev)
    }
    return events
  }

  /** Flush any trailing line without a newline (call on stream end). */
  flush(): WorkerEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const ev = parseWorkerLine(rest)
    return ev ? [ev] : []
  }
}
