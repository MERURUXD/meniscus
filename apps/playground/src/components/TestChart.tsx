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
const PRISM_BANDS = [1, 2, 3, 4, 5] as const

export interface TestChartProps {
  messages: PlaygroundMessages['chart']
  /** Split comparison panes hide oversized specimen text to keep small panes legible. */
  compact?: boolean
}

/**
 * Live backdrop rendered beneath glass: either the Swiss Optical Calibration Plate
 * (drifting vernier grid, monumental Bodoni display specimen, chromatic prism bands,
 * Siemens resolution star, specimen ribbon, spectrum bar) or a procedural WebGL2 shader.
 *
 * Animations use `transform` only and none of these elements wrap the glass, so the
 * substrate never becomes a CSS Backdrop Root that would cut the glass off from what it bends.
 */
export function TestChart({ messages, compact = false }: TestChartProps): ReactElement {
  const clockRef = useRef<HTMLSpanElement | null>(null)
  const { kind, theme, reducedMotion } = useContext(BackdropContext)
  const isChart = kind === 'chart'

  useEffect(() => {
    if (!isChart) return
    const el = clockRef.current
    if (!el) return
    const start = performance.now()
    // 10 Hz keeps the readout legibly alive without per-frame text layout.
    const id = window.setInterval(() => {
      el.textContent = `${((performance.now() - start) / 1000).toFixed(1)} s`
    }, 100)
    return () => window.clearInterval(id)
  }, [isChart])

  return (
    <div className="chart" data-backdrop={kind} data-compact={compact ? 'true' : 'false'}>
      {isChart ? (
        <>
          <div className="chart-grid chart-anim" aria-hidden="true" />

          <svg className="chart-star" viewBox="-100 -100 200 200" aria-hidden="true">
            <g className="chart-star-spin chart-anim">
              <path d={STAR_PATH} />
            </g>
            <circle r="3.2" className="chart-star-hub" />
          </svg>

          {!compact ? (
            <div className="chart-monument" aria-hidden="true">
              <span className="chart-monument-title">Sessile</span>
              <span className="chart-monument-index">n = 1.50</span>
            </div>
          ) : null}

          <div className="chart-prism" aria-hidden="true">
            {PRISM_BANDS.map((band) => (
              <span key={band} className={`chart-prism-band chart-prism-${band}`} />
            ))}
          </div>

          <div className="chart-specimen" aria-hidden="true">
            <div className="chart-specimen-track chart-anim">
              <span>{messages.specimen}</span>
              <span aria-hidden="true">{messages.specimen}</span>
            </div>
          </div>

          {!compact ? (
            <footer className="chart-foot">
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
              <p className="chart-clock">
                {messages.clockLabel} <span ref={clockRef}>0.0 s</span>
              </p>
            </footer>
          ) : null}
        </>
      ) : (
        <Wallpaper scene={kind} theme={theme} reducedMotion={reducedMotion} />
      )}
    </div>
  )
}
