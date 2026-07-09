import React, { useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { LANE_KINDS, LANE_LABELS, seekTimeFromX, playheadX, formatClock, type LaneKind } from '@shared/audioLanes'
import { useLaneAudio, type LaneSource } from './useLaneAudio'
import { LaneCanvas } from './LaneCanvas'

const LANE_COLOR: Record<LaneKind, string> = {
  married: 'var(--stem-married)',
  dialogue: 'var(--stem-dialogue)',
  music: 'var(--stem-music)',
  sfx: 'var(--stem-sfx)'
}

// keys 1..4 map to the four lanes in display order for quick solo.
const SOLO_KEYS: Record<string, LaneKind> = {
  '1': 'married',
  '2': 'dialogue',
  '3': 'music',
  '4': 'sfx'
}

export function DoneView(): React.JSX.Element {
  const result = useStore((s) => s.result)
  const reset = useStore((s) => s.reset)

  const sources: LaneSource[] = useMemo(() => {
    if (!result) return []
    return [
      { kind: 'married', label: LANE_LABELS.married, path: result.marriedMix },
      { kind: 'dialogue', label: LANE_LABELS.dialogue, path: result.stems.dialogue },
      { kind: 'music', label: LANE_LABELS.music, path: result.stems.music },
      { kind: 'sfx', label: LANE_LABELS.sfx, path: result.stems.sfx }
    ]
  }, [result])

  const { state, toggle, seek, toggleSolo, toggleMute } = useLaneAudio(sources)

  // Global keyboard transport: space = play/pause, S/M toggle solo/mute on the
  // focused lane (via data-lane on the active element), 1–4 solo by position.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (typing) return
      if (e.key === ' ') {
        e.preventDefault()
        toggle()
        return
      }
      const focusedLane = el?.closest?.('[data-lane]')?.getAttribute('data-lane') as
        | LaneKind
        | undefined
      const k = e.key.toLowerCase()
      if (k === 's' && focusedLane) {
        e.preventDefault()
        toggleSolo(focusedLane)
      } else if (k === 'm' && focusedLane) {
        e.preventDefault()
        toggleMute(focusedLane)
      } else if (SOLO_KEYS[e.key]) {
        e.preventDefault()
        toggleSolo(SOLO_KEYS[e.key]!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, toggleSolo, toggleMute])

  if (!result) return <div className="center-stage" />

  const anySolo = state.solo.size > 0

  return (
    <div className="stage">
      <div className="done-header">
        <div className="done-check" aria-hidden>
          ✓
        </div>
        <div>
          <div className="done-title">Stems ready</div>
          <div className="done-sub">
            Four sample-aligned WAVs — the three stems sum back to the married mix exactly.
          </div>
        </div>
      </div>

      <div className="transport">
        <button className="transport-play" onClick={toggle} aria-label={state.playing ? 'Pause' : 'Play'}>
          {state.playing ? '❚❚' : '▶'}
        </button>
        <div className="transport-clock">
          <span className="cur">{formatClock(state.time)}</span> / {formatClock(state.duration)}
        </div>
        <div className="transport-hint">
          <kbd>space</kbd> play · <kbd>S</kbd> solo · <kbd>M</kbd> mute · <kbd>1–4</kbd> solo lane
        </div>
      </div>

      <div className="lanes">
        {LANE_KINDS.map((kind) => {
          const src = sources.find((s) => s.kind === kind)!
          const soloed = state.solo.has(kind)
          const muted = state.mute.has(kind)
          const audible = anySolo ? soloed : !muted
          const peaks = state.peaks[kind]
          return (
            <div
              key={kind}
              className={`lane ${kind}${audible ? '' : ' muted'}`}
              data-lane={kind}
              tabIndex={0}
            >
              <div className="lane-head">
                <div className="lane-name">
                  <span className="lane-swatch" />
                  {src.label}
                </div>
                <div className="lane-file" title={src.path}>
                  {src.path.split('/').pop()}
                </div>
              </div>

              <div
                className={`lane-canvas-wrap${peaks ? '' : ' no-wave'}`}
                onClick={(e) => {
                  if (!peaks) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  seek(seekTimeFromX(e.clientX - rect.left, rect.width, state.duration))
                }}
              >
                {peaks ? (
                  <>
                    <LaneCanvas peaks={peaks} color={LANE_COLOR[kind]} />
                    {state.duration > 0 && (
                      <div
                        className="lane-playhead"
                        style={{
                          left: `${(playheadX(state.time, 1000, state.duration) / 1000) * 100}%`
                        }}
                      />
                    )}
                  </>
                ) : (
                  'no preview'
                )}
              </div>

              <div className="lane-controls">
                <button
                  className={`lane-btn${soloed ? ' on' : ''}`}
                  onClick={() => toggleSolo(kind)}
                  aria-pressed={soloed}
                  title="Solo (S)"
                >
                  S
                </button>
                <button
                  className={`lane-btn${muted ? ' on' : ''}`}
                  onClick={() => toggleMute(kind)}
                  aria-pressed={muted}
                  title="Mute (M)"
                >
                  M
                </button>
                <button
                  className="lane-btn reveal"
                  onClick={() => window.stemstudio.revealInFinder(src.path)}
                  title="Reveal in Finder"
                >
                  Reveal
                </button>
              </div>
            </div>
          )
        })}

        {result.multitrackVideo && (
          <div className="aux-row">
            <div className="lane-head">
              <div className="lane-name">
                <span className="aux-icon" />
                Multitrack video
              </div>
              <div className="lane-file" title={result.multitrackVideo}>
                {result.multitrackVideo.split('/').pop()}
              </div>
            </div>
            <div className="hint">Original picture + the three stems as labelled tracks — ready for your NLE.</div>
            <div className="lane-controls">
              <button
                className="lane-btn reveal"
                onClick={() => window.stemstudio.revealInFinder(result.multitrackVideo!)}
              >
                Reveal
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="button-row">
        <button className="btn-secondary" onClick={() => window.stemstudio.openFolder(result.outputDir)}>
          Open Output Folder
        </button>
        <button className="btn-primary" onClick={reset}>
          New File
        </button>
      </div>
    </div>
  )
}
