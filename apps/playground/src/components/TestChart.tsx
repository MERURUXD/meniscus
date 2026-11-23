import { useContext, useEffect, useRef, type ReactElement } from 'react'
import type { PlaygroundMessages } from '../i18n.ts'
import { BackdropContext } from './backdropSettings.ts'
import { Wallpaper } from './Wallpaper.tsx'

const STAR_SPOKES = 36
const STAR_RADIUS = 100

/**
 * Siemens star wedges: radial edges cross the glass rim at every angle, so displacement
 * reads in all directions instead of only where a rule happens to be perpendicular to the bezel.
 */
const STAR_PATH = (() => {
  const step = (Math.PI * 2) / (STAR_SPOKES * 2)
  let d = ''
  for (let i = 0; i < STAR_SPOKES; i++) {
    const a0 = i * 2 * step
    const a1 = a0 + step
    const x0 = (STAR_RADIUS * Math.cos(a0)).toFixed(3)
    const y0 = (STAR_RADIUS * Math.sin(a0)).toFixed(3)
    const x1 = (STAR_RADIUS * Math.cos(a1)).toFixed(3)
    const y1 = (STAR_RADIUS * Math.sin(a1)).toFixed(3)
    d += `M0 0L${x0} ${y0}A${STAR_RADIUS} ${STAR_RADIUS} 0 0 1 ${x1} ${y1}Z`
  }
  return d
})()

const SPECTRUM_TICKS = [450, 500, 550, 600, 650] as const
const SPECTRUM_MIN_NM = 400
const SPECTRUM_MAX_NM = 700

export interface TestChartProps {
  title: string
  caption: string
  messages: PlaygroundMessages['chart']
  /** Large brand wordmark; split panes omit it to leave room for both lenses. */
  wordmark?: boolean
}

/**
 * Live backdrop rendered beneath glass: either the procedural fold wallpaper or a selectable
 * DOM test target (grid drift, star rotation, specimen scroll). Both keep moving so refraction
 * is visibly continuous even while the glass itself is at rest.
 *
 * Animations use `transform` only and none of these elements wrap the glass, so the
 * chart never becomes a CSS Backdrop Root that would cut the glass off from what it bends.
 */
export function TestChart({
  title,
  caption,
  messages,
  wordmark = true,
}: TestChartProps): ReactElement {
  const clockRef = useRef<HTMLSpanElement | null>(null)
  const { kind, theme, reducedMotion } = useContext(BackdropContext)
  const isChart = kind === 'chart'

  useEffect(() => {
    const el = clockRef.current
    if (!el) return
    const start = performance.now()
    // 10 Hz keeps the readout legibly alive without per-frame text layout.
    const id = window.setInterval(() => {
      el.textContent = `${((performance.now() - start) / 1000).toFixed(1)} s`
    }, 100)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="chart" data-backdrop={kind}>
      {isChart ? (
        <>
          <div className="chart-grid chart-anim" aria-hidden="true" />
          <svg className="chart-star" viewBox="-100 -100 200 200" aria-hidden="true">
            <g className="chart-star-spin chart-anim">
              <path d={STAR_PATH} />
            </g>
            <circle r="3.2" className="chart-star-hub" />
          </svg>
        </>
      ) : (
        <Wallpaper theme={theme} reducedMotion={reducedMotion} />
      )}

      <header className="chart-head">
        {wordmark ? <p className="chart-wordmark">Meniscus</p> : null}
        <h2 className="chart-title">{title}</h2>
        <p className="chart-caption">{caption}</p>
      </header>

      {isChart ? (
        <div className="chart-specimen">
          <div className="chart-specimen-track chart-anim">
            <span>{messages.specimen}</span>
            <span aria-hidden="true">{messages.specimen}</span>
          </div>
        </div>
      ) : null}

      <footer className="chart-foot">
        {isChart ? (
          <figure className="chart-spectrum">
            <div className="chart-spectrum-band" aria-hidden="true" />
            <div className="chart-spectrum-ticks" aria-hidden="true">
              {SPECTRUM_TICKS.map((nm) => (
                <span
                  key={nm}
                  style={{
                    left: `${((nm - SPECTRUM_MIN_NM) / (SPECTRUM_MAX_NM - SPECTRUM_MIN_NM)) * 100}%`,
                  }}
                >
                  {nm}
                </span>
              ))}
            </div>
            <figcaption>{messages.spectrumCaption}</figcaption>
          </figure>
        ) : null}
        <p className="chart-clock">
          {messages.clockLabel} <span ref={clockRef}>0.0 s</span>
        </p>
      </footer>
    </div>
  )
}
