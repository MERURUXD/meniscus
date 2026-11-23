import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ThemeMode } from '@meniscus/core'
import { detectSurfaceCapabilities, type SurfaceCapabilities } from '@meniscus/dom'
import { useReducedMotion } from '@meniscus/react'
import { detectInitialLocale, getMessages, persistLocale, type Locale } from './i18n.ts'
import { DragMergeLab } from './labs/DragMergeLab.tsx'
import { OpticsLab } from './labs/OpticsLab.tsx'
import { PopoverMenuLab } from './labs/PopoverMenuLab.tsx'
import { SegmentedDockLab } from './labs/SegmentedDockLab.tsx'
import { LAB_IDS, type LabId } from './labDefaults.ts'
import { BackdropContext, type BackdropKind } from './components/backdropSettings.ts'
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

function detectInitialTheme(): ThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
]

export function App(): ReactElement {
  const [activeLab, setActiveLab] = useState<LabId>('drag-merge')
  const [theme, setTheme] = useState<ThemeMode>(() => detectInitialTheme())
  const [locale, setLocale] = useState<Locale>(() => detectInitialLocale())
  const [backdrop, setBackdrop] = useState<BackdropKind>('wallpaper')
  const [forceReducedMotion, setForceReducedMotion] = useState<boolean | null>(null)
  const [capabilities] = useState<SurfaceCapabilities>(() => detectSurfaceCapabilities())
  const [hasWebgl2] = useState<boolean>(() => detectWebgl2Support())

  const systemReducedMotion = useReducedMotion()
  const reducedMotion = forceReducedMotion ?? systemReducedMotion
  const t = getMessages(locale)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-motion', reducedMotion ? 'reduced' : 'full')
  }, [theme, reducedMotion])

  useEffect(() => {
    persistLocale(locale)
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = t.documentTitle
  }, [locale, t.documentTitle])

  const renderMode = capabilities.svgBackdropRefraction ? 'refract' : 'frosted'
  const backdropSettings = useMemo(
    () => ({ kind: backdrop, theme, reducedMotion }),
    [backdrop, theme, reducedMotion],
  )

  return (
    <BackdropContext value={backdropSettings}>
      <div className="bench">
        <nav className="bench-nav" aria-label={t.shell.labsNavAria}>
          <p className="bench-brand">
            Meniscus
            <span>{t.shell.tagline}</span>
          </p>
          <div className="bench-labs" role="tablist" aria-label={t.shell.labsNavAria}>
            {LAB_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="bench-lab-tab"
                aria-selected={activeLab === id}
                onClick={() => setActiveLab(id)}
              >
                <span className="bench-lab-title">{t.tabs[id].title}</span>
                <span className="bench-lab-desc">{t.tabs[id].description}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="bench-lab">
          {activeLab === 'drag-merge' ? (
            <DragMergeLab
              theme={theme}
              locale={locale}
              reducedMotion={reducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'segmented-dock' ? (
            <SegmentedDockLab
              theme={theme}
              locale={locale}
              reducedMotion={reducedMotion}
              renderMode={renderMode}
            />
          ) : null}
          {activeLab === 'optics' ? (
            <OpticsLab theme={theme} locale={locale} reducedMotion={reducedMotion} />
          ) : null}
          {activeLab === 'popover-menu' ? (
            <PopoverMenuLab
              theme={theme}
              locale={locale}
              reducedMotion={reducedMotion}
              renderMode={renderMode}
            />
          ) : null}
        </div>

        <footer className="bench-meta">
          <p className="bench-status">
            <strong>
              {capabilities.svgBackdropRefraction ? t.shell.statusRefract : t.shell.statusFrosted}
            </strong>{' '}
            {hasWebgl2 ? t.shell.statusRimWebgl2 : t.shell.statusRimCanvas2d}
          </p>
          <div className="bench-prefs">
            <div className="pg-btn-group" role="group" aria-label={t.shell.backdropGroupAria}>
              {(['wallpaper', 'chart'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="pg-btn"
                  aria-pressed={backdrop === kind}
                  onClick={() => setBackdrop(kind)}
                >
                  {kind === 'wallpaper' ? t.shell.backdropWallpaper : t.shell.backdropChart}
                </button>
              ))}
            </div>
            <div className="pg-btn-group" role="group" aria-label={t.shell.themeGroupAria}>
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="pg-btn"
                  aria-pressed={theme === mode}
                  onClick={() => setTheme(mode)}
                >
                  {mode === 'light' ? t.shell.themeLight : t.shell.themeDark}
                </button>
              ))}
            </div>
            <div className="pg-btn-group" role="group" aria-label={t.shell.localeGroupAria}>
              {LOCALES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="pg-btn"
                  lang={option.id === 'zh' ? 'zh-CN' : 'en'}
                  aria-pressed={locale === option.id}
                  onClick={() => setLocale(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="pg-btn"
              aria-pressed={reducedMotion}
              onClick={() => setForceReducedMotion(!reducedMotion)}
            >
              {t.shell.reduceMotion}
            </button>
          </div>
        </footer>
      </div>
    </BackdropContext>
  )
}
