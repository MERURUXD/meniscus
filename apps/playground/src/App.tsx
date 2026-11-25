import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ThemeMode } from '@sessile/core'
import { detectSurfaceCapabilities, type SurfaceCapabilities, type SurfaceRenderMode } from '@sessile/dom'
import { useReducedMotion } from '@sessile/react'
import { SegmentedControl } from './components/ControlPanel.tsx'
import { detectInitialLocale, getMessages, persistLocale, type Locale } from './i18n.ts'
import { DragMergeLab } from './labs/DragMergeLab.tsx'
import { GlobalMaterialPanel, OpticsCompareStage } from './labs/OpticsLab.tsx'
import { PopoverMenuLab } from './labs/PopoverMenuLab.tsx'
import { SegmentedDockLab } from './labs/SegmentedDockLab.tsx'
import {
  DEFAULT_OPTICS_LAB_CONFIG,
  LAB_IDS,
  OPTICS_PRESETS,
  buildOpticsLabMaterial,
  type GlobalGlassMaterial,
  type LabId,
  type OpticsLabConfig,
  type OpticsPresetId,
} from './labDefaults.ts'
import {
  BackdropContext,
  type BackdropKind,
} from './components/backdropSettings.ts'
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
  { id: 'en', label: 'EN' },
  { id: 'zh', label: '中文' },
]

const SWATCH_ORDER: readonly BackdropKind[] = [
  'prism',
  'folds',
  'lava',
  'contours',
  'aurora',
  'bokeh',
  'mesh',
  'chart',
]

const LAB_ICONS: Readonly<Record<LabId, ReactElement>> = {
  'drag-merge': (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.8" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10.4" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  'segmented-dock': (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4.5" width="13" height="7" rx="3.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3.2" y="6.2" width="5" height="3.6" rx="1.8" fill="currentColor" />
    </svg>
  ),
  'popover-menu': (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="1.8" fill="currentColor" />
      <rect x="5" y="5.5" width="9" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
}

type SheetTab = 'material' | 'scene'

export function App(): ReactElement {
  const [activeLab, setActiveLab] = useState<LabId>('drag-merge')
  const [theme, setTheme] = useState<ThemeMode>(() => detectInitialTheme())
  const [locale, setLocale] = useState<Locale>(() => detectInitialLocale())
  const [backdrop, setBackdrop] = useState<BackdropKind>('prism')
  const [forceReducedMotion, setForceReducedMotion] = useState<boolean | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [sheetTab, setSheetTab] = useState<SheetTab>('material')
  const [opticsConfig, setOpticsConfig] = useState<OpticsLabConfig>(DEFAULT_OPTICS_LAB_CONFIG)
  const [activePreset, setActivePreset] = useState<OpticsPresetId | null>('crown')
  const [capabilities, setCapabilities] = useState<SurfaceCapabilities>(() =>
    detectSurfaceCapabilities(),
  )
  const [hasWebgl2] = useState<boolean>(() => detectWebgl2Support())

  const compareGapReadoutRef = useRef<HTMLElement | null>(null)
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

  const selectScene = useCallback((id: LabId) => {
    setActiveLab(id)
    setOpticsConfig((prev) =>
      prev.renderView === 'split' ? { ...prev, renderView: 'refract' } : prev,
    )
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        const nextLab = LAB_IDS[Number(e.key) - 1]
        if (nextLab) selectScene(nextLab)
      } else if (e.key === 'i' || e.key === 'I') {
        setInspectorOpen((open) => !open)
      } else if (e.key === 'm' || e.key === 'M') {
        setSheetTab('material')
        setInspectorOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectScene])

  const updateOpticsConfig = useCallback(
    <K extends keyof OpticsLabConfig>(key: K, value: OpticsLabConfig[K]) => {
      if (key !== 'renderView' && key !== 'showWireframe' && key !== 'oscillateGap' && key !== 'gapPx') {
        setActivePreset(null)
      }
      setOpticsConfig((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const applyPreset = useCallback((presetId: OpticsPresetId) => {
    setActivePreset(presetId)
    setOpticsConfig((prev) => ({ ...prev, ...OPTICS_PRESETS[presetId] }))
  }, [])

  const resetOptics = useCallback(() => {
    setActivePreset('crown')
    setOpticsConfig((prev) => ({
      ...DEFAULT_OPTICS_LAB_CONFIG,
      renderView: prev.renderView === 'split' ? 'split' : DEFAULT_OPTICS_LAB_CONFIG.renderView,
    }))
  }, [])

  const handleSheetTabChange = useCallback((nextTab: SheetTab) => {
    setSheetTab(nextTab)
    if (nextTab === 'scene') {
      setOpticsConfig((prev) =>
        prev.renderView === 'split' ? { ...prev, renderView: 'refract' } : prev,
      )
    }
  }, [])

  const isSplitView = opticsConfig.renderView === 'split'
  const requestedMode: SurfaceRenderMode =
    opticsConfig.renderView === 'split' ? 'refract' : opticsConfig.renderView

  const globalGlass = useMemo<GlobalGlassMaterial>(() => {
    const effectiveTier =
      requestedMode === 'refract' && !capabilities.svgBackdropRefraction ? 'frosted' : 'refract'
    const resolvedMaterialTier = requestedMode === 'frosted' ? 'frosted' : effectiveTier
    return {
      config: opticsConfig,
      renderMode: requestedMode,
      material: buildOpticsLabMaterial(theme, opticsConfig, resolvedMaterialTier),
      fallbackMaterial: buildOpticsLabMaterial(theme, opticsConfig, 'frosted'),
      refraction: {
        bezel: opticsConfig.bevelPx,
        strength: opticsConfig.refractionStrength,
        dispersion: opticsConfig.dispersionPx,
        profile: opticsConfig.refractionProfile,
        ior: opticsConfig.ior,
        caustics: opticsConfig.caustics,
      },
      styleMix: opticsConfig.rimMode === 'soft' ? 1 : 0,
    }
  }, [opticsConfig, requestedMode, theme, capabilities.svgBackdropRefraction])

  const backdropSettings = useMemo(
    () => ({ kind: backdrop, theme, reducedMotion }),
    [backdrop, theme, reducedMotion],
  )

  const statusRefractText = capabilities.svgBackdropRefraction
    ? t.shell.statusCompactRefract
    : t.shell.statusCompactFrosted
  const statusRimText = hasWebgl2 ? t.shell.statusCompactWebgl2 : t.shell.statusCompactCanvas2d

  const sheetSwitcher = (
    <SegmentedControl
      ariaLabel={t.shell.sheetTabsAria}
      value={isSplitView ? 'material' : sheetTab}
      size="sm"
      onChange={handleSheetTabChange}
      options={[
        { value: 'material', label: t.shell.sheetMaterial },
        { value: 'scene', label: t.shell.sheetScene },
      ]}
    />
  )

  const showMaterialPanel = isSplitView || sheetTab === 'material'
  const showScenePanel = !isSplitView && sheetTab === 'scene'

  return (
    <BackdropContext value={backdropSettings}>
      <div className="bench" data-inspector={inspectorOpen ? 'open' : 'closed'}>
        <div className="bench-lab">
          {isSplitView ? (
            <OpticsCompareStage
              theme={theme}
              locale={locale}
              reducedMotion={reducedMotion}
              glass={globalGlass}
              gapReadoutRef={compareGapReadoutRef}
              onGapChange={(gapPx) => updateOpticsConfig('gapPx', gapPx)}
              onStopOscillate={() => updateOpticsConfig('oscillateGap', false)}
              onCapabilitiesChange={(caps) => setCapabilities(caps)}
            />
          ) : (
            <>
              {activeLab === 'drag-merge' ? (
                <DragMergeLab
                  theme={theme}
                  locale={locale}
                  reducedMotion={reducedMotion}
                  glass={globalGlass}
                  showScenePanel={showScenePanel}
                  panelHeaderSlot={sheetSwitcher}
                />
              ) : null}
              {activeLab === 'segmented-dock' ? (
                <SegmentedDockLab
                  theme={theme}
                  locale={locale}
                  reducedMotion={reducedMotion}
                  glass={globalGlass}
                  showScenePanel={showScenePanel}
                  panelHeaderSlot={sheetSwitcher}
                />
              ) : null}
              {activeLab === 'popover-menu' ? (
                <PopoverMenuLab
                  theme={theme}
                  locale={locale}
                  reducedMotion={reducedMotion}
                  glass={globalGlass}
                  inspectorOpen={inspectorOpen}
                  showScenePanel={showScenePanel}
                  panelHeaderSlot={sheetSwitcher}
                />
              ) : null}
            </>
          )}

          {showMaterialPanel ? (
            <GlobalMaterialPanel
              locale={locale}
              reducedMotion={reducedMotion}
              config={opticsConfig}
              activePreset={activePreset}
              svgRefractionSupported={capabilities.svgBackdropRefraction}
              gapReadoutRef={compareGapReadoutRef}
              wireframeSupported={isSplitView || activeLab === 'drag-merge'}
              headerSlot={sheetSwitcher}
              onUpdateConfig={updateOpticsConfig}
              onApplyPreset={applyPreset}
              onReset={resetOptics}
            />
          ) : null}
        </div>

        <div className="hud-top-bar">
          <div className="hud-plate hud-identity">
            <h1 className="hud-wordmark">Sessile</h1>
            <span className="hud-hairline" aria-hidden="true" />
            <p
              className="hud-capability"
              title={`${capabilities.svgBackdropRefraction ? t.shell.statusRefract : t.shell.statusFrosted} ${hasWebgl2 ? t.shell.statusRimWebgl2 : t.shell.statusRimCanvas2d}`}
            >
              <span>{statusRefractText}</span>
              <span className="hud-cap-dot" aria-hidden="true" />
              <span>{statusRimText}</span>
            </p>
          </div>

          <div className="hud-plate hud-env">
            <div className="hud-seg" role="radiogroup" aria-label={t.shell.themeGroupAria}>
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={theme === mode}
                  className="hud-seg-btn"
                  onClick={() => setTheme(mode)}
                >
                  {mode === 'light' ? t.shell.themeLight : t.shell.themeDark}
                </button>
              ))}
            </div>

            <div className="hud-seg" role="radiogroup" aria-label={t.shell.localeGroupAria}>
              {LOCALES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={locale === option.id}
                  className="hud-seg-btn"
                  lang={option.id === 'zh' ? 'zh-CN' : 'en'}
                  onClick={() => setLocale(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="hud-util-btn"
              aria-pressed={reducedMotion}
              onClick={() => setForceReducedMotion(!reducedMotion)}
            >
              {t.shell.reduceMotion}
            </button>
          </div>
        </div>

        <nav className="hud-plate hud-console" aria-label={t.shell.labsNavAria}>
          <div className="hud-tabs" role="tablist" aria-label={t.shell.labsNavAria}>
            {LAB_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="hud-tab"
                aria-selected={!isSplitView && activeLab === id}
                onClick={() => selectScene(id)}
              >
                {LAB_ICONS[id]}
                <span>{t.tabs[id].title}</span>
              </button>
            ))}
          </div>

          <span className="hud-console-sep" aria-hidden="true" />

          <div className="hud-swatches-wrap">
            <div className="hud-swatches" role="radiogroup" aria-label={t.shell.backdropLabel}>
              {SWATCH_ORDER.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={backdrop === kind}
                  aria-label={t.shell.backdrops[kind]}
                  title={t.shell.backdrops[kind]}
                  className="hud-swatch"
                  data-scene={kind}
                  onClick={() => setBackdrop(kind)}
                >
                  <span className="hud-swatch-fill" aria-hidden="true" />
                </button>
              ))}
            </div>
            <span className="hud-swatch-label">{t.shell.backdrops[backdrop]}</span>
          </div>

          <span className="hud-console-sep hud-tune-sep" aria-hidden="true" />

          <button
            type="button"
            className="hud-tune-btn"
            aria-expanded={inspectorOpen}
            aria-label={inspectorOpen ? t.shell.inspectorHide : t.shell.inspectorShow}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <line x1="2" y1="5" x2="14" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <line x1="2" y1="11" x2="14" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="6" cy="5" r="2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="10.5" cy="11" r="2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span>{t.shell.tuneButton}</span>
          </button>
        </nav>
      </div>
    </BackdropContext>
  )
}
