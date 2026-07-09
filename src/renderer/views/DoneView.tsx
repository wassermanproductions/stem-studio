import React, { useRef, useState } from 'react'
import { useStore } from '../store'
import { STEMS, STEM_LABELS, type StemKind } from '@shared/types'

function StemRow({ kind, path }: { kind: StemKind; path: string }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
    } else {
      // Pause any other playing preview by pausing then playing this one.
      void el.play()
    }
  }

  return (
    <div className="stem-row">
      <button className={`play-btn${playing ? ' playing' : ''}`} onClick={toggle} aria-label="Play preview">
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="stem-name">{STEM_LABELS[kind]}</div>
      <div className="stem-path" title={path}>
        {path.split('/').pop()}
      </div>
      <button className="btn-ghost" onClick={() => window.stemstudio.revealInFinder(path)}>
        Reveal
      </button>
      <audio
        ref={audioRef}
        src={window.stemstudio.stemUrl(path)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  )
}

export function DoneView(): React.JSX.Element {
  const result = useStore((s) => s.result)
  const reset = useStore((s) => s.reset)

  if (!result) return <div className="center-stage" />

  return (
    <div className="stage">
      <div className="done-header">
        <div className="done-check" aria-hidden>
          ✓
        </div>
        <div className="done-title">Stems ready</div>
      </div>

      <section className="card stems-card">
        {STEMS.map((kind) => (
          <StemRow key={kind} kind={kind} path={result.stems[kind]} />
        ))}

        {result.multitrackVideo && (
          <div className="stem-row multitrack">
            <div className="play-btn placeholder" aria-hidden>
              ▤
            </div>
            <div className="stem-name">Multitrack video</div>
            <div className="stem-path" title={result.multitrackVideo}>
              {result.multitrackVideo.split('/').pop()}
            </div>
            <button
              className="btn-ghost"
              onClick={() => window.stemstudio.revealInFinder(result.multitrackVideo!)}
            >
              Reveal
            </button>
          </div>
        )}
      </section>

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
