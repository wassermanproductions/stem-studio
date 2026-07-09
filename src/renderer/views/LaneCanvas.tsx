import React, { useEffect, useRef } from 'react'
import type { Peaks } from '@shared/audioLanes'

/**
 * Draws a min/max peak waveform for one lane onto a canvas, devicePixelRatio-
 * aware so it stays crisp on Retina. Pure presentation — the peak data comes
 * from the tested {@link computePeaks}. `color` is the lane's stem colour.
 */
export function LaneCanvas({
  peaks,
  color
}: {
  peaks: Peaks | undefined
  color: string
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !peaks) return
    const parent = canvas.parentElement
    if (!parent) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const cssW = parent.clientWidth
      const cssH = parent.clientHeight
      canvas.width = Math.max(1, Math.floor(cssW * dpr))
      canvas.height = Math.max(1, Math.floor(cssH * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const mid = cssH / 2
      const n = peaks.max.length
      const step = cssW / n
      // faint centre line
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(cssW, mid)
      ctx.stroke()

      ctx.fillStyle = color
      ctx.globalAlpha = 0.9
      for (let i = 0; i < n; i++) {
        const x = i * step
        const top = mid - peaks.max[i]! * mid
        const bot = mid - peaks.min[i]! * mid
        const h = Math.max(1, bot - top)
        ctx.fillRect(x, top, Math.max(1, step - 0.4), h)
      }
      ctx.globalAlpha = 1
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [peaks, color])

  return <canvas className="lane-canvas" ref={ref} />
}
