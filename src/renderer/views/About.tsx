import React from 'react'
import logo from '../assets/logo.png'
import type { PlatformInfo } from '@shared/types'

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
  platformInfo,
  onClose
}: {
  version: string
  platformInfo: PlatformInfo | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="about-backdrop" onClick={onClose} role="presentation">
      <div
        className="about-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`About ${platformInfo?.appName ?? 'Stem Studio'}`}
      >
        <button className="about-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <img className="about-logo" src={logo} alt="" aria-hidden />
        <div className="about-name">{platformInfo?.appName ?? 'Stem Studio'}</div>
        <div className="about-version">Version {version}</div>
        <p className="about-desc">
          Separate a married film soundtrack into Dialogue, Music, and SFX stems — locally on your
          machine.
        </p>
        <div className="about-credit">
          <CreditLine />
        </div>
        {platformInfo?.maintainerCredit && (
          <div className="about-license">{platformInfo.maintainerCredit}</div>
        )}
        <div className="about-license">
          © 2026 Sam Wasserman. App source is Apache-2.0. FFmpeg/FFprobe, when bundled, are
          separate GPL-3.0-or-later components; see Third-Party Notices.
        </div>
      </div>
    </div>
  )
}
