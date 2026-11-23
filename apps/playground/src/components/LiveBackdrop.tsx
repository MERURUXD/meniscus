import { useState, type ReactElement } from 'react'

const SWATCH_COLORS = [
  { label: '620nm', bg: 'linear-gradient(135deg, #f43f5e, #fb7185)' },
  { label: '590nm', bg: 'linear-gradient(135deg, #f59e0b, #fbbf24)' },
  { label: '530nm', bg: 'linear-gradient(135deg, #10b981, #34d399)' },
  { label: '485nm', bg: 'linear-gradient(135deg, #06b6d4, #38bdf8)' },
  { label: '450nm', bg: 'linear-gradient(135deg, #3b82f6, #6366f1)' },
  { label: '410nm', bg: 'linear-gradient(135deg, #8b5cf6, #ec4899)' },
] as const

export interface LiveBackdropProps {
  title: string
  caption: string
}

/**
 * Renders vibrant, high-contrast DOM typography, color swatches, grid lines, and a live
 * interactive counter behind glass layers to demonstrate authentic Live-DOM refraction.
 */
export function LiveBackdrop({ title, caption }: LiveBackdropProps): ReactElement {
  const [pulseCount, setPulseCount] = useState(1)

  return (
    <div className="pg-backdrop">
      <div className="pg-backdrop-grid" aria-hidden="true" />

      <div className="pg-backdrop-row">
        <div className="pg-backdrop-card">
          <div className="pg-backdrop-kicker">Live DOM Optical Substrate</div>
          <h2 className="pg-backdrop-heading">{title}</h2>
          <p className="pg-backdrop-copy">{caption}</p>
        </div>

        <div className="pg-backdrop-ticker">
          <span>Substrate pulses: {pulseCount}</span>
          <button
            type="button"
            className="pg-btn"
            onClick={() => setPulseCount((c) => c + 1)}
          >
            Mutate DOM
          </button>
        </div>
      </div>

      <div className="pg-backdrop-stripes">
        {SWATCH_COLORS.map((swatch) => (
          <div
            key={swatch.label}
            className="pg-stripe-swatch"
            style={{ background: swatch.bg }}
          >
            {swatch.label}
          </div>
        ))}
      </div>
    </div>
  )
}
