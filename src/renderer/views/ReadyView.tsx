import React from 'react'
import { useStore } from '../store'
import { canSeparate } from '../store'
import { startSeparation, formatDuration } from '../loadInput'
import { DEFAULT_ENGINE, ENGINE_LABEL, type QualityMode } from '@shared/types'

const QUALITY_OPTIONS: { value: QualityMode; label: string; hint: string }[] = [
  { value: 'fast', label: 'Fast', hint: 'Single pass. Quickest.' },
  {
    value: 'high',
    label: 'High',
    hint: 'TIGER with test-time augmentation — a few times slower for a small gain.'
  },
  {
    value: 'max',
    label: 'Max',
    hint: 'Blends TIGER (high) with the MVSEP-CDX23 model. Best quality; slowest — recommended on CUDA.'
  }
]

/** File card + options + Separate button. Also used after cancel. */
export function ReadyView({ note }: { note?: string }): React.JSX.Element {
  const input = useStore((s) => s.input)
  const outputDir = useStore((s) => s.outputDir)
  const multitrackVideo = useStore((s) => s.multitrackVideo)
  const quality = useStore((s) => s.quality)
  const probe = useStore((s) => s.probe)
  const status = useStore((s) => s.status)
  const setOutputDir = useStore((s) => s.setOutputDir)
  const setMultitrackVideo = useStore((s) => s.setMultitrackVideo)
  const setQuality = useStore((s) => s.setQuality)
  const reset = useStore((s) => s.reset)

  if (!input) return <div className="center-stage" />

  const pickFolder = async () => {
    const dir = await window.stemstudio.pickOutputFolder(outputDir ?? undefined)
    if (dir) setOutputDir(dir)
  }

  const ready = canSeparate(status, !!input, !!outputDir)

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
                  <span>{input.channels === 1 ? 'mono' : `${input.channels}ch`}</span>
                </>
              )}
              {input.sampleRate > 0 && (
                <>
                  <span>·</span>
                  <span>{(input.sampleRate / 1000).toFixed(1)} kHz</span>
                </>
              )}
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
            <span>Also export multitrack video (.mov with 3 stem tracks)</span>
          </label>
          {!input.hasVideo && <div className="hint">Audio input — no video to remux.</div>}
        </div>

        <div className="option-row">
          <label className="option-label">Quality</label>
          <div className="segmented" role="radiogroup" aria-label="Quality">
            {QUALITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={quality === opt.value}
                className={`segment${quality === opt.value ? ' active' : ''}`}
                onClick={() => setQuality(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="hint">
            {QUALITY_OPTIONS.find((o) => o.value === quality)?.hint}
            {probe && (
              <>
                {' '}
                Detected device: {probe.device.toUpperCase()}.
              </>
            )}
          </div>
        </div>
      </section>

      <button className="btn-primary btn-lg" disabled={!ready} onClick={() => void startSeparation()}>
        Separate Stems
      </button>

      <div className="engine-tag">Engine: {ENGINE_LABEL[DEFAULT_ENGINE]}</div>
    </div>
  )
}
