import { useEffect, useState, type ReactElement } from 'react'
import type { ThemeMode } from '@meniscus/core'
import { detectSurfaceCapabilities, type SurfaceCapabilities } from '@meniscus/dom'
import { useReducedMotion } from '@meniscus/react'
import { DragMergeLab } from './labs/DragMergeLab.tsx'
import { OpticsLab } from './labs/OpticsLab.tsx'
import { PopoverMenuLab } from './labs/PopoverMenuLab.tsx'
import { SegmentedDockLab } from './labs/SegmentedDockLab.tsx'
import { LAB_TABS, type LabId } from './labDefaults.ts'
import './styles/theme.css'
import './styles/app.css'

function detectWebgl2Support(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2'))
  } catch {
    return false
  }
}

export function App(): ReactElement {
  const [activeLab, setActiveLab] = useState<LabId>('drag-merge')
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [forceReducedMotion, setForceReducedMotion] = useState<boolean | null>(null)
  const [capabilities] = useState<SurfaceCapabilities>(() => detectSurfaceCapabilities())
  const [hasWebgl2] = useState<boolean>(() => detectWebgl2Support())

  const systemReducedMotion = useReducedMotion()
  const effectiveReducedMotion = forceReducedMotion ?? systemReducedMotion

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  const renderMode = capabilities.svgBackdropRefraction ? 'refract' : 'frosted'
  const capabilityLabel = capabilities.svgBackdropRefraction
    ? 'Refract (Chromium Route B3)'
    : 'Frosted Fallback (Non-Chromium)'

  return (
    <div className="pg-shell" data-theme={theme}>
      <div className="pg-container">
        <header className="pg-header">
          <div className="pg-brand">
            <div className="pg-logo-mark" aria-hidden="true">
              M
            </div>
            <div>
              <h1 className="pg-title">Meniscus</h1>
              <p className="pg-subtitle">
                Live-DOM N-Primitive Continuous Glass Morphing Laboratory
              </p>
            </div>
          </div>

          <div className="pg-header-actions">
            <span
              className="pg-cap-pill"
              data-fallback={!capabilities.svgBackdropRefraction ? 'true' : 'false'}
            >
              {capabilityLabel} · {hasWebgl2 ? 'WebGL2' : 'Canvas 2D'}
            </span>

            <button
              type="button"
              className="pg-btn"
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
            >
              Theme: {theme === 'light' ? 'Light' : 'Dark'}
            </button>

            <button
              type="button"
              className="pg-btn"
              aria-pressed={effectiveReducedMotion}
              onClick={() =>
                setForceReducedMotion((prev) => !(prev ?? systemReducedMotion))
              }
            >
              Reduced Motion: {effectiveReducedMotion ? 'On' : 'Off'}
            </button>
          </div>
        </header>

        <nav className="pg-nav" role="tablist" aria-label="Meniscus Interactive Labs">
          {LAB_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="pg-nav-tab"
              aria-selected={activeLab === tab.id}
              onClick={() => setActiveLab(tab.id)}
            >
              <span className="pg-nav-tab-title">{tab.title}</span>
              <span className="pg-nav-tab-desc">{tab.description}</span>
            </button>
          ))}
        </nav>

        <main>
          {activeLab === 'drag-merge' ? (
            <DragMergeLab
              theme={theme}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'segmented-dock' ? (
            <SegmentedDockLab
              theme={theme}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'optics' ? (
            <OpticsLab theme={theme} reducedMotion={effectiveReducedMotion} />
          ) : null}
          {activeLab === 'popover-menu' ? (
            <PopoverMenuLab
              theme={theme}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}
