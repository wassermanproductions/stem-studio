import React from 'react'
import { useStore, STAGE_ORDER, STAGE_LABELS, stageProgress } from '../store'
import type { PipelineStage } from '@shared/types'
import { Splitter } from './Splitter'

export function ProgressView(): React.JSX.Element {
  const input = useStore((s) => s.input)
  const stage = useStore((s) => s.stage)
  const stagePercent = useStore((s) => s.stagePercent)
  const setupLog = useStore((s) => s.setupLog)
  const currentJobId = useStore((s) => s.currentJobId)

  // Drop the remux stage from the shown pipeline unless this input has video.
  const stages: PipelineStage[] = STAGE_ORDER.filter(
    (s) => s !== 'remuxing' || input?.hasVideo
  )

  const overall = stage ? Math.round(stageProgress(stage, stagePercent, stages) * 100) : 0
  const currentIdx = stage ? stages.indexOf(stage) : -1
  const separating = stage === 'separating' || stage === 'loading'

  const cancel = () => {
    if (currentJobId) void window.stemstudio.cancel(currentJobId)
    // Also flip UI immediately; main confirms via job:cancelled.
    useStore.getState().finishCancelled()
  }

  return (
    <div className="stage">
      <div className="progress-header">
        <div className="progress-title">Separating “{input?.name}”</div>
        <div className="progress-pct">{overall}%</div>
      </div>

      <Splitter active={separating} />

      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${overall}%` }} />
      </div>

      <ol className="stage-list">
        {stages.map((s, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending'
          return (
            <li key={s} className={`stage-item ${state}`}>
              <span className="stage-dot" />
              <span className="stage-name">{STAGE_LABELS[s]}</span>
              {i === currentIdx && stagePercent >= 0 && (
                <span className="stage-local">{Math.round(stagePercent)}%</span>
              )}
            </li>
          )
        })}
      </ol>

      {stage === 'setup' && setupLog.length > 0 && (
        <div className="setup-log">
          <div className="setup-log-title">
            First-run setup — preparing the local environment
          </div>
          <pre>{setupLog.slice(-8).join('\n')}</pre>
        </div>
      )}

      <button className="btn-ghost btn-danger" onClick={cancel}>
        Cancel
      </button>
    </div>
  )
}
