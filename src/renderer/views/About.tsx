import React from 'react'
import logo from '../assets/logo.png'

/** An allowlisted link that opens in the system browser (never in-app). */
function ExternalLink({ url, children }: { url: string; children: string }): React.JSX.Element {
  return (
    <a
      href="#"
      className="ext-link"
      onClick={(e) => {
        e.preventDefault()
        void window.stemstudio.openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

/**
 * The credit line shown in the footer and About panel. Both domains open in the
 * system browser via the allowlisted opener. Matches the Blockout suite
 * convention.
 */
export function CreditLine(): React.JSX.Element {
  return (
    <span className="credit">
      Created by <strong>Sam Wasserman</strong>
      {' · '}
      <ExternalLink url="https://wassermanproductions.com">wassermanproductions.com</ExternalLink>
      {' · '}
      <ExternalLink url="https://wasserman.ai">wasserman.ai</ExternalLink>
    </span>
  )
}

/** Modal "About Stem Studio" panel. */
export function AboutPanel({
  version,
  onClose
}: {
  version: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="about-backdrop" onClick={onClose} role="presentation">
      <div
        className="about-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="About Stem Studio"
      >
        <button className="about-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <img className="about-logo" src={logo} alt="" aria-hidden />
        <div className="about-name">Stem Studio</div>
        <div className="about-version">Version {version}</div>
        <p className="about-desc">
          Separate a married film soundtrack into Dialogue, Music, and SFX stems — locally on your
          machine.
        </p>
        <div className="about-credit">
          <CreditLine />
        </div>
        <div className="about-license">
          © 2026 Sam Wasserman. Open source under Apache-2.0 — keep this credit when using or
          forking.
        </div>
      </div>
    </div>
  )
}
