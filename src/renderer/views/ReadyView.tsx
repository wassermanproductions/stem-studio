import React from 'react'
import { useStore, canSeparate } from '../store'
import { startSeparation, formatDuration } from '../loadInput'
import { defaultQualityForDevice, type QualityMode } from '@shared/types'

const QUALITY_OPTIONS: { value: QualityMode; label: string; desc: string }[] = [
  { value: 'fast', label: 'Fast', desc: 'Quick single pass.' },
  { value: 'high', label: 'High', desc: 'Multi-pass, better separation.' },
  { value: 'max', label: 'Max', desc: 'Dual-engine blend, best quality — slowest.' }
]

/** File card + options + Separate button. Also used after cancel. */
export function ReadyView({ note }: { note?: string }): React.JSX.Element {
  const input = useStore((s) => s.input)
  const outputDir = useStore((s) => s.outputDir)
  const multitrackVideo = useStore((s) => s.multitrackVideo)
  const quality = useStore((s) => s.quality)
  const polishDialogue = useStore((s) => s.polishDialogue)
  const probe = useStore((s) => s.probe)
  const status = useStore((s) => s.status)
  const setOutputDir = useStore((s) => s.setOutputDir)
  const setMultitrackVideo = useStore((s) => s.setMultitrackVideo)
  const setQuality = useStore((s) => s.setQuality)
  const setPolishDialogue = useStore((s) => s.setPolishDialogue)
  const reset = useStore((s) => s.reset)

  if (!input) return <div className="center-stage" />

  const pickFolder = async () => {
    const dir = await window.stemstudio.pickOutputFolder(outputDir ?? undefined)
    if (dir) setOutputDir(dir)
  }

  const ready = canSeparate(status, !!input, !!outputDir)
  const recommended = probe ? defaultQualityForDevice(probe.device) : null

  return (
    <div className="stage">
      {note && <div className="banner">{note}</div>}

      <section className="card file-card">
        <div className="file-card-main">
          <div className="file-badge">{input.hasVideo ? 'VIDEO' : 'AUDIO'}</div>
          <div className="file-meta">
            <div className="file-name" title={input.path}>
              {input.name}
            </div>
            <div className="file-facts">
              <span>{formatDuration(input.duration)}</span>
              <span>·</span>
              <span>{input.format}</span>
              {input.channels > 0 && (
                <>
                  <span>·</span>
                  <span>{input.channels === 1 ? 'mono' : `${input.channels} ch`}</span>
                </>
              )}
              {input.sampleRate > 0 && (
                <>
                  <span>·</span>
                  <span>{(input.sampleRate / 1000).toFixed(1)} kHz</span>
                </>
              )}
              {input.hasVideo && <span className="video-pill">HAS VIDEO</span>}
            </div>
          </div>
        </div>
        <button className="btn-ghost" onClick={reset}>
          Change
        </button>
      </section>

      <section className="card options-card">
        <div className="option-row">
          <label className="option-label">Output folder</label>
          <div className="folder-row">
            <div className="folder-path" title={outputDir ?? ''}>
              {outputDir ?? '—'}
            </div>
            <button className="btn-ghost" onClick={pickFolder}>
              Choose…
            </button>
          </div>
        </div>

        <div className="option-row">
          <label className={`checkbox${input.hasVideo ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={multitrackVideo && input.hasVideo}
              disabled={!input.hasVideo}
              onChange={(e) => setMultitrackVideo(e.target.checked)}
            />
            <span>Also export a multitrack video (.mov with 3 stem tracks) for your NLE</span>
          </label>
          {!input.hasVideo && <div className="hint">Audio input — no video to remux.</div>}
        </div>

        <div className="option-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={polishDialogue}
              onChange={(e) => setPolishDialogue(e.target.checked)}
            />
            <span>Polish dialogue</span>
          </label>
          <div className="hint">
            Cleans music &amp; effects bleed out of voices — best for
            dialogue-heavy footage.
          </div>
        </div>

        <div className="option-row">
          <label className="option-label">Quality</label>
          <div className="quality-grid" role="radiogroup" aria-label="Quality">
            {QUALITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={quality === opt.value}
                className={`quality-seg${quality === opt.value ? ' active' : ''}`}
                onClick={() => setQuality(opt.value)}
              >
                <span className="q-name">
                  {opt.label}
                  {recommended === opt.value && <span className="q-default-tag">Recommended</span>}
                </span>
                <span className="q-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
          {probe && (
            <div className="device-note">
              Detected compute device: <code>{probe.device.toUpperCase()}</code>. The recommended
              tier is picked for your hardware — you can change it any time.
            </div>
          )}
        </div>
      </section>

      <button
        className="btn-primary btn-lg"
        disabled={!ready}
        onClick={() => void startSeparation()}
      >
        Separate Stems
      </button>
    </div>
  )
}
