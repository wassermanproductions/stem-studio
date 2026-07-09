import React, { useState } from 'react'
import { openViaDialog, loadFromPath } from '../loadInput'
import logo from '../assets/logo.png'

export function DropView(): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    setError(null)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const path = window.stemstudio.pathForFile(file)
    const err = await loadFromPath(path)
    if (err) setError(err)
  }

  const onOpen = async () => {
    setError(null)
    const err = await openViaDialog()
    if (err) setError(err)
  }

  return (
    <div className="center-stage">
      <div className="hero">
        <img className="hero-logo" src={logo} alt="Stem Studio" />
        <div className="hero-tagline">
          Split any <span className="grad-text">married mix</span> into Dialogue, Music &amp; SFX
        </div>

        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void onOpen()
            }
          }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="dropzone-icon" aria-hidden>
            ⇩
          </div>
          <div className="dropzone-title">Drop a video or audio file</div>
          <div className="dropzone-sub">or click to browse — everything runs locally on your machine</div>
          <div className="dropzone-formats">
            MP4 · MOV · MKV · WEBM · WAV · MP3 · AAC · FLAC · M4A
          </div>
          {error && <div className="inline-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
