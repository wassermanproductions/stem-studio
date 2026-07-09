import React, { useEffect, useState } from 'react'
import { useStore } from './store'
import { loadProbe, openViaDialog } from './loadInput'
import { DropView } from './views/DropView'
import { ReadyView } from './views/ReadyView'
import { ProgressView } from './views/ProgressView'
import { DoneView } from './views/DoneView'
import { ErrorView } from './views/ErrorView'
import { CreditLine, AboutPanel } from './views/About'
import logo from './assets/logo.png'

const APP_VERSION = window.stemstudio.appVersion

export function App(): React.JSX.Element {
  const status = useStore((s) => s.status)
  const probe = useStore((s) => s.probe)
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

  const [aboutOpen, setAboutOpen] = useState(false)

  // Probe the device once on startup to default the quality tier.
  useEffect(() => {
    void loadProbe()
  }, [])

  // File → Open File… from the application menu triggers the open dialog.
  useEffect(() => window.stemstudio.onMenuOpenFile(() => void openViaDialog()), [])

  const inProgress =
    status === 'extracting' ||
    status === 'setup' ||
    status === 'separating' ||
    status === 'writing'

  return (
    <div className="app">
      <header className="titlebar">
        <img className="titlebar-logo" src={logo} alt="" aria-hidden />
        <span className="app-name">Stem Studio</span>
        <div className="titlebar-spacer" />
        {probe && (
          <span className="titlebar-status" title="Compute device the engines will run on">
            <span className="dot" />
            {probe.device}
          </span>
        )}
      </header>

      <main className="content">
        {status === 'idle' && <DropView />}
        {status === 'ready' && <ReadyView />}
        {inProgress && <ProgressView />}
        {status === 'done' && <DoneView />}
        {status === 'error' && <ErrorView />}
        {status === 'cancelled' && <ReadyView note="Separation cancelled." />}
      </main>

      <footer className="footer">
        <CreditLine />
        <span className="footer-sep">·</span>
        <button
          type="button"
          className="footer-version"
          onClick={() => setAboutOpen(true)}
          title="About Stem Studio"
        >
          v{APP_VERSION}
        </button>
      </footer>

      {aboutOpen && <AboutPanel version={APP_VERSION} onClose={() => setAboutOpen(false)} />}
    </div>
  )
}
