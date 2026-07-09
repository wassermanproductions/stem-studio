import { useCallback, useEffect, useRef, useState } from 'react'
import {
  computePeaks,
  mixToMono,
  resolveGains,
  toggleInSet,
  type LaneKind,
  type Peaks
} from '@shared/audioLanes'

export interface LaneSource {
  kind: LaneKind
  label: string
  path: string
}

interface LaneNode {
  buffer: AudioBuffer
  gain: GainNode
  source?: AudioBufferSourceNode
}

export interface LaneAudioState {
  /** Decoded peak data per lane (for canvas rendering), keyed by lane kind. */
  peaks: Partial<Record<LaneKind, Peaks>>
  duration: number
  playing: boolean
  /** Current transport time in seconds (updated via rAF while playing). */
  time: number
  solo: Set<LaneKind>
  mute: Set<LaneKind>
  ready: boolean
}

/** Peak buckets to compute per lane — enough detail without huge arrays. */
const BUCKETS = 1400

/**
 * Owns a single AudioContext and one GainNode per delivered stem, all started
 * from the same clock so the four lanes stay sample-synced. Exposes a transport
 * (play/pause/seek) plus per-lane solo/mute that resolve to gains via the pure
 * {@link resolveGains} helper. Decoding uses `AudioContext.decodeAudioData`
 * against the `stem://` preview URLs.
 */
export function useLaneAudio(sources: LaneSource[]) {
  const ctxRef = useRef<AudioContext | null>(null)
  const nodesRef = useRef<Partial<Record<LaneKind, LaneNode>>>({})
  const rafRef = useRef<number | null>(null)
  // Transport bookkeeping on the AudioContext clock.
  const startedAtRef = useRef(0) // ctx.currentTime when playback (re)started
  const offsetRef = useRef(0) // playback position (s) at the last (re)start

  const [state, setState] = useState<LaneAudioState>({
    peaks: {},
    duration: 0,
    playing: false,
    time: 0,
    solo: new Set(),
    mute: new Set(),
    ready: false
  })

  const laneKinds = sources.map((s) => s.kind)

  // ---- decode all sources once ----
  useEffect(() => {
    let cancelled = false
    const ctx = new AudioContext()
    ctxRef.current = ctx

    async function load() {
      const peaks: Partial<Record<LaneKind, Peaks>> = {}
      let duration = 0
      for (const src of sources) {
        try {
          const res = await fetch(window.stemstudio.stemUrl(src.path))
          const bytes = await res.arrayBuffer()
          const buffer = await ctx.decodeAudioData(bytes)
          if (cancelled) return
          const gain = ctx.createGain()
          gain.connect(ctx.destination)
          nodesRef.current[src.kind] = { buffer, gain }
          duration = Math.max(duration, buffer.duration)
          const chans: Float32Array[] = []
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            chans.push(buffer.getChannelData(c))
          }
          peaks[src.kind] = computePeaks(mixToMono(chans), BUCKETS, buffer.duration)
        } catch {
          /* a lane that fails to decode simply renders no waveform */
        }
      }
      if (cancelled) return
      setState((s) => ({ ...s, peaks, duration, ready: true }))
    }
    void load()

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void ctx.close()
      ctxRef.current = null
      nodesRef.current = {}
    }
  }, [sources.map((s) => s.path).join('|')])

  // ---- apply solo/mute to gains whenever they change ----
  const applyGains = useCallback(
    (solo: Set<LaneKind>, mute: Set<LaneKind>) => {
      const ctx = ctxRef.current
      if (!ctx) return
      const gains = resolveGains(laneKinds, solo, mute)
      for (const kind of laneKinds) {
        const node = nodesRef.current[kind]
        if (node) node.gain.gain.setTargetAtTime(gains[kind], ctx.currentTime, 0.01)
      }
    },
    [laneKinds.join('|')]
  )

  const stopSources = useCallback(() => {
    for (const kind of laneKinds) {
      const node = nodesRef.current[kind]
      if (node?.source) {
        try {
          node.source.stop()
        } catch {
          /* already stopped */
        }
        node.source.disconnect()
        node.source = undefined
      }
    }
  }, [laneKinds.join('|')])

  const tick = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const t = offsetRef.current + (ctx.currentTime - startedAtRef.current)
    setState((s) => {
      if (t >= s.duration) {
        // reached the end — stop and reset to 0
        stopSources()
        offsetRef.current = 0
        return { ...s, playing: false, time: s.duration }
      }
      return { ...s, time: t }
    })
    rafRef.current = requestAnimationFrame(tick)
  }, [stopSources])

  const startAt = useCallback(
    (offset: number) => {
      const ctx = ctxRef.current
      if (!ctx) return
      void ctx.resume()
      stopSources()
      const when = ctx.currentTime
      for (const kind of laneKinds) {
        const node = nodesRef.current[kind]
        if (!node) continue
        const src = ctx.createBufferSource()
        src.buffer = node.buffer
        src.connect(node.gain)
        src.start(when, Math.min(offset, node.buffer.duration))
        node.source = src
      }
      startedAtRef.current = when
      offsetRef.current = offset
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    },
    [laneKinds.join('|'), stopSources, tick]
  )

  const play = useCallback(() => {
    setState((s) => {
      const from = s.time >= s.duration ? 0 : s.time
      startAt(from)
      return { ...s, playing: true }
    })
  }, [startAt])

  const pause = useCallback(() => {
    const ctx = ctxRef.current
    if (ctx) offsetRef.current += ctx.currentTime - startedAtRef.current
    stopSources()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setState((s) => ({ ...s, playing: false, time: offsetRef.current }))
  }, [stopSources])

  const toggle = useCallback(() => {
    setState((s) => {
      if (s.playing) {
        const ctx = ctxRef.current
        if (ctx) offsetRef.current += ctx.currentTime - startedAtRef.current
        stopSources()
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        return { ...s, playing: false, time: offsetRef.current }
      } else {
        const from = s.time >= s.duration ? 0 : s.time
        startAt(from)
        return { ...s, playing: true }
      }
    })
  }, [startAt, stopSources])

  const seek = useCallback(
    (t: number) => {
      setState((s) => {
        const clamped = Math.max(0, Math.min(t, s.duration))
        if (s.playing) startAt(clamped)
        else offsetRef.current = clamped
        return { ...s, time: clamped }
      })
    },
    [startAt]
  )

  const toggleSolo = useCallback(
    (kind: LaneKind) => {
      setState((s) => {
        const solo = toggleInSet(s.solo, kind)
        applyGains(solo, s.mute)
        return { ...s, solo }
      })
    },
    [applyGains]
  )

  const toggleMute = useCallback(
    (kind: LaneKind) => {
      setState((s) => {
        const mute = toggleInSet(s.mute, kind)
        applyGains(s.solo, mute)
        return { ...s, mute }
      })
    },
    [applyGains]
  )

  return { state, toggle, play, pause, seek, toggleSolo, toggleMute }
}
