import React, { useMemo } from 'react'

/**
 * Progress-view showpiece: one incoming waveform on the left that fans out into
 * three colour-coded streams (Dialogue = cyan, Music = blue, SFX = violet),
 * mirroring the app logo. Pure SVG + CSS: the only animation is a couple of
 * `stroke-dashoffset` marching-dash flows and a soft glow pulse, both GPU-cheap
 * and disabled under `prefers-reduced-motion` (handled globally in styles.css).
 *
 * `active` toggles the flow animation on/off so it only marches while the
 * worker is actually separating.
 */
export function Splitter({ active }: { active: boolean }): React.JSX.Element {
  // A deterministic left-hand waveform (bars of varying height around a centre
  // line). Memoised so it doesn't jitter on re-render.
  const bars = useMemo(() => {
    const heights = [10, 20, 34, 46, 30, 52, 24, 40, 16, 44, 28, 12]
    return heights
  }, [])

  const cx = 118 // where the bundle leaves the "file"
  const midY = 105
  // three fan-out endpoints
  const ends = [
    { y: 40, color: 'var(--stem-dialogue)', label: 'Dialogue' },
    { y: 105, color: 'var(--stem-music)', label: 'Music' },
    { y: 170, color: 'var(--stem-sfx)', label: 'SFX' }
  ]

  return (
    <svg
      className={`splitter${active ? ' active' : ''}`}
      viewBox="0 0 460 210"
      role="img"
      aria-label="Waveform splitting into Dialogue, Music and SFX streams"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="sp-in" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--cyan)" />
          <stop offset="1" stopColor="var(--blue)" />
        </linearGradient>
      </defs>

      {/* incoming waveform bars, inside a rounded "file" frame */}
      <rect x="26" y="55" width="70" height="100" rx="10" fill="none"
        stroke="var(--border-strong)" strokeWidth="1.5" />
      {bars.map((h, i) => {
        const x = 36 + i * 4.7
        return (
          <line
            key={i}
            x1={x}
            x2={x}
            y1={midY - h / 2}
            y2={midY + h / 2}
            stroke="url(#sp-in)"
            strokeWidth="2.4"
            strokeLinecap="round"
            className="sp-bar"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        )
      })}

      {/* the three fan-out streams */}
      {ends.map((e, i) => {
        const d = `M ${cx} ${midY} C ${cx + 70} ${midY}, ${cx + 90} ${e.y}, ${430} ${e.y}`
        return (
          <g key={i}>
            <path
              d={d}
              fill="none"
              stroke={e.color}
              strokeWidth="2.4"
              strokeLinecap="round"
              className="sp-flow"
              style={{ '--flow-delay': `${i * 260}ms` } as React.CSSProperties}
            />
            <circle cx={430} cy={e.y} r="5" fill={e.color} className="sp-node" />
          </g>
        )
      })}
    </svg>
  )
}
