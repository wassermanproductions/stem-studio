import React, { useEffect } from 'react'
import { useStore } from './store'
import { loadProbe } from './loadInput'
import { DropView } from './views/DropView'
import { ReadyView } from './views/ReadyView'
import { ProgressView } from './views/ProgressView'
import { DoneView } from './views/DoneView'
import { ErrorView } from './views/ErrorView'

export function App(): React.JSX.Element {
  const status = useStore((s) => s.status)
  const applyProgress = useStore((s) => s.applyProgress)
  const appendSetup = useStore((s) => s.appendSetup)
  const finishDone = useStore((s) => s.finishDone)
  const finishError = useStore((s) => s.finishError)
  const finishCancelled = useStore((s) => s.finishCancelled)

  // Wire IPC event streams into the store once.
  useEffect(() => {
    const offs = [
      window.stemstudio.onProgress(applyProgress),
      window.stemstudio.onSetup(appendSetup),
      window.stemstudio.onDone(finishDone),
      window.stemstudio.onError(finishError),
      window.stemstudio.onCancelled(finishCancelled)
    ]
    return () => offs.forEach((off) => off())
  }, [applyProgress, appendSetup, finishDone, finishError, finishCancelled])

  // Probe the device once on startup to default the quality tier.
  useEffect(() => {
    void loadProbe()
  }, [])

  const inProgress =
    status === 'extracting' ||
    status === 'setup' ||
    status === 'separating' ||
    status === 'writing'

  return (
    <div className="app">
      <div className="titlebar">
        <span className="app-name">STEM STUDIO</span>
      </div>
      <main className="content">
        {status === 'idle' && <DropView />}
        {status === 'ready' && <ReadyView />}
        {inProgress && <ProgressView />}
        {status === 'done' && <DoneView />}
        {status === 'error' && <ErrorView />}
        {status === 'cancelled' && <ReadyView note="Separation cancelled." />}
      </main>
    </div>
  )
}
