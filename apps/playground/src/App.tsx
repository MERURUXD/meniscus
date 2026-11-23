import { useEffect, useState, type ReactElement } from 'react'
import type { ThemeMode } from '@meniscus/core'
import { detectSurfaceCapabilities, type SurfaceCapabilities } from '@meniscus/dom'
import { useReducedMotion } from '@meniscus/react'
import {
  detectInitialLocale,
  getMessages,
  persistLocale,
  type Locale,
} from './i18n.ts'
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
  const [locale, setLocale] = useState<Locale>(() => detectInitialLocale())
  const [forceReducedMotion, setForceReducedMotion] = useState<boolean | null>(null)
  const [capabilities] = useState<SurfaceCapabilities>(() => detectSurfaceCapabilities())
  const [hasWebgl2] = useState<boolean>(() => detectWebgl2Support())

  const systemReducedMotion = useReducedMotion()
  const effectiveReducedMotion = forceReducedMotion ?? systemReducedMotion
  const t = getMessages(locale)

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  useEffect(() => {
    persistLocale(locale)
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
      document.title = t.documentTitle
    }
  }, [locale, t.documentTitle])

  const renderMode = capabilities.svgBackdropRefraction ? 'refract' : 'frosted'
  const capabilityLabel = capabilities.svgBackdropRefraction
    ? t.header.refractSupported
    : t.header.frostedFallback

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
              <p className="pg-subtitle">{t.header.subtitle}</p>
            </div>
          </div>

          <div className="pg-header-actions">
            <span
              className="pg-cap-pill"
              data-fallback={!capabilities.svgBackdropRefraction ? 'true' : 'false'}
            >
              {capabilityLabel} ·{' '}
              {hasWebgl2 ? t.header.overlayWebgl2 : t.header.overlayCanvas2d}
            </span>

            <button
              type="button"
              className="pg-btn"
              aria-label={t.header.langToggleAria}
              onClick={() => setLocale((prev) => (prev === 'en' ? 'zh' : 'en'))}
            >
              {t.header.langToggleLabel}
            </button>

            <button
              type="button"
              className="pg-btn"
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
            >
              {theme === 'light' ? t.header.themeLight : t.header.themeDark}
            </button>

            <button
              type="button"
              className="pg-btn"
              aria-pressed={effectiveReducedMotion}
              onClick={() =>
                setForceReducedMotion((prev) => !(prev ?? systemReducedMotion))
              }
            >
              {effectiveReducedMotion
                ? t.header.reducedMotionOn
                : t.header.reducedMotionOff}
            </button>
          </div>
        </header>

        <nav className="pg-nav" role="tablist" aria-label={t.header.labsNavAria}>
          {LAB_TABS.map((tab) => {
            const tabCopy = t.tabs[tab.id]
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="pg-nav-tab"
                aria-selected={activeLab === tab.id}
                onClick={() => setActiveLab(tab.id)}
              >
                <span className="pg-nav-tab-title">{tabCopy.title}</span>
                <span className="pg-nav-tab-desc">{tabCopy.description}</span>
              </button>
            )
          })}
        </nav>

        <main>
          {activeLab === 'drag-merge' ? (
            <DragMergeLab
              theme={theme}
              locale={locale}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'segmented-dock' ? (
            <SegmentedDockLab
              theme={theme}
              locale={locale}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'optics' ? (
            <OpticsLab
              theme={theme}
              locale={locale}
              reducedMotion={effectiveReducedMotion}
            />
          ) : null}
          {activeLab === 'popover-menu' ? (
            <PopoverMenuLab
              theme={theme}
              locale={locale}
              reducedMotion={effectiveReducedMotion}
              renderMode={renderMode}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}
