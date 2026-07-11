// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
import React, { useState } from 'react'
import { useStore } from '../store'

export function ErrorView(): React.JSX.Element {
  const error = useStore((s) => s.error)
  const input = useStore((s) => s.input)
  const reset = useStore((s) => s.reset)
  const setInput = useStore((s) => s.setInput)
  const outputDir = useStore((s) => s.outputDir)
  const [copied, setCopied] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  const detail = [error?.message, error?.detail].filter(Boolean).join('\n\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const tryAgain = () => {
    // Return to the ready screen with the same input, if we still have it.
    if (input && outputDir) setInput(input, outputDir)
    else reset()
  }

  const repairRuntime = async () => {
    setRepairing(true)
    setRepairError(null)
    const result = await window.stemstudio.repairRuntime()
    setRepairing(false)
    if (!result.ok) {
      setRepairError(result.error ?? 'Runtime repair failed.')
      return
    }
    tryAgain()
  }

  return (
    <div className="stage">
      <div className="error-header">
        <div className="error-mark" aria-hidden>
          !
        </div>
        <div className="error-title">Separation failed</div>
      </div>

      <section className="card error-card">
        <div className="error-message">{error?.message ?? 'Unknown error'}</div>
        {error?.detail && <pre className="error-detail">{error.detail}</pre>}
        {repairError && <div className="error-message">{repairError}</div>}
      </section>

      <div className="button-row">
        <button className="btn-ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy details'}
        </button>
        <button className="btn-secondary" onClick={reset}>
          Start over
        </button>
        <button className="btn-secondary" disabled={repairing} onClick={() => void repairRuntime()}>
          {repairing ? 'Repairing…' : 'Repair private runtime'}
        </button>
        <button className="btn-primary" onClick={tryAgain}>
          Try again
        </button>
      </div>
    </div>
  )
}
