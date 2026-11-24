import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import {
  extractFieldContourPath,
  type GlassFieldState,
  type GlassPrimitive,
  type RefractionProfileName,
  type RimMode,
  type Size,
  type ThemeMode,
} from '@sessile/core'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type GlassSurfaceCapabilities,
  type RefractFilterConfig,
  type SurfaceRenderMode,
} from '@sessile/dom'
import { GlassField } from '@sessile/react'
import { ControlPanel, SliderControl } from '../components/ControlPanel.tsx'
import { TestChart } from '../components/TestChart.tsx'
import { getMessages, type Locale, type PlaygroundMessages } from '../i18n.ts'
import {
  DEFAULT_OPTICS_LAB_CONFIG,
  buildOpticsLabMaterial,
  buildOpticsLabPrimitives,
  type OpticsLabConfig,
  type OpticsViewMode,
} from '../labDefaults.ts'

export interface OpticsLabProps {
  theme: ThemeMode
  locale: Locale
  reducedMotion: boolean
}

type TierLabelKey = keyof PlaygroundMessages['optics']['tierLabels']

const DEFAULT_SINGLE_STAGE: Size = { width: 760, height: 520 }
const DEFAULT_SPLIT_STAGE: Size = { width: 374, height: 520 }

interface SdfWireframeOverlayProps {
  field: GlassFieldState
  pathRef?: (el: SVGPathElement | null) => void
  primRefs?: (index: number, el: SVGRectElement | null) => void
}

function SdfWireframeOverlay({
  field,
  pathRef,
  primRefs,
}: SdfWireframeOverlayProps): ReactElement {
  const contourPath = useMemo(
    () => extractFieldContourPath(field, { x: 0, y: 0 }) ?? '',
    [field],
  )

  return (
    <svg className="pg-wireframe-svg" aria-hidden="true">
      {field.primitives.map((p: GlassPrimitive, idx: number) => (
        <rect
          key={p.id ?? idx}
          ref={(el) => primRefs?.(idx, el)}
          x={p.center.x - p.size.width * 0.5}
          y={p.center.y - p.size.height * 0.5}
          width={p.size.width}
          height={p.size.height}
          rx={p.radius}
          className="pg-wire-prim"
        />
      ))}
      <path
        ref={pathRef}
        d={contourPath}
        className="pg-wire-contour"
      />
    </svg>
  )
}

export function OpticsLab({ theme, locale, reducedMotion }: OpticsLabProps): ReactElement {
  const t = getMessages(locale)
  const op = t.optics

  const [config, setConfig] = useState<OpticsLabConfig>(DEFAULT_OPTICS_LAB_CONFIG)
  const [stageSize, setStageSize] = useState<Size>(DEFAULT_SINGLE_STAGE)
  const [splitSize, setSplitSize] = useState<Size>(DEFAULT_SPLIT_STAGE)
  const [tierKey, setTierKey] = useState<TierLabelKey>('refract')

  const singleStageRef = useRef<HTMLDivElement | null>(null)
  const splitLeftRef = useRef<HTMLDivElement | null>(null)

  const primarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const secondarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const gapReadoutRef = useRef<HTMLSpanElement | null>(null)
  const primaryWirePathRef = useRef<SVGPathElement | null>(null)
  const secondaryWirePathRef = useRef<SVGPathElement | null>(null)
  const primaryRectRefs = useRef<Array<SVGRectElement | null>>([])
  const secondaryRectRefs = useRef<Array<SVGRectElement | null>>([])

  // The primary surface shows the frosted tier whenever it cannot refract, so its material
  // must carry the fallback blur too; the split view's right pane is always the fallback.
  const primaryTier =
    config.renderView === 'frosted' ||
    tierKey === 'refractDowngraded' ||
    tierKey === 'splitDowngraded'
      ? 'frosted'
      : 'refract'
  const material = useMemo(
    () => buildOpticsLabMaterial(theme, config, primaryTier),
    [theme, config, primaryTier],
  )
  const fallbackMaterial = useMemo(
    () => buildOpticsLabMaterial(theme, config, 'frosted'),
    [theme, config],
  )
  const refraction = useMemo<Partial<RefractFilterConfig>>(
    () => ({
      bezel: config.bevelPx,
      strength: config.refractionStrength,
      dispersion: config.dispersionPx,
      profile: config.refractionProfile,
      ior: config.ior,
      caustics: config.caustics,
    }),
    [
      config.bevelPx,
      config.refractionStrength,
      config.dispersionPx,
      config.refractionProfile,
      config.ior,
      config.caustics,
    ],
  )

  const activeSinglePrimitives = useMemo(
    () => buildOpticsLabPrimitives(stageSize, config.gapPx),
    [stageSize, config.gapPx],
  )
  const activeSplitPrimitives = useMemo(
    () => buildOpticsLabPrimitives(splitSize, config.gapPx),
    [splitSize, config.gapPx],
  )

  const configRef = useRef(config)
  const materialRef = useRef(material)
  const fallbackMaterialRef = useRef(fallbackMaterial)
  const refractionRef = useRef(refraction)
  const themeRef = useRef(theme)
  const liveSuffixRef = useRef(op.liveSuffix)
  const sizeRef = useRef({ single: stageSize, split: splitSize })

  useEffect(() => {
    configRef.current = config
    materialRef.current = material
    fallbackMaterialRef.current = fallbackMaterial
    refractionRef.current = refraction
    themeRef.current = theme
    liveSuffixRef.current = op.liveSuffix
    sizeRef.current = { single: stageSize, split: splitSize }
  }, [config, material, fallbackMaterial, refraction, theme, op.liveSuffix, stageSize, splitSize])

  useEffect(() => {
    const el = singleStageRef.current
    if (!el || config.renderView === 'split') return
    return observeElementResize(
      el,
      (next) => {
        if (next.width > 0 && next.height > 0) {
          setStageSize(next)
        }
      },
      { emitInitial: true },
    )
  }, [config.renderView])

  useEffect(() => {
    const el = splitLeftRef.current
    if (!el || config.renderView !== 'split') return
    return observeElementResize(
      el,
      (next) => {
        if (next.width > 0 && next.height > 0) {
          setSplitSize(next)
        }
      },
      { emitInitial: true },
    )
  }, [config.renderView])

  useEffect(() => {
    const ctrl = primarySurfaceRef.current
    if (!ctrl) return
    const effective = ctrl.getEffectiveMode()
    if (config.renderView === 'split') {
      setTierKey(effective === 'refract' ? 'split' : 'splitDowngraded')
    } else if (config.renderView === 'refract' && effective !== 'refract') {
      setTierKey('refractDowngraded')
    } else {
      setTierKey(effective)
    }
  }, [config.renderView])

  const updateWireframeDom = (
    field: GlassFieldState,
    pathEl: SVGPathElement | null,
    rectEls: Array<SVGRectElement | null>,
  ) => {
    if (pathEl) {
      pathEl.setAttribute('d', extractFieldContourPath(field, { x: 0, y: 0 }) ?? '')
    }
    for (let i = 0; i < field.primitives.length; i++) {
      const p = field.primitives[i]!
      const rectEl = rectEls[i]
      if (!rectEl) continue
      rectEl.setAttribute('x', String(p.center.x - p.size.width * 0.5))
      rectEl.setAttribute('y', String(p.center.y - p.size.height * 0.5))
      rectEl.setAttribute('width', String(p.size.width))
      rectEl.setAttribute('height', String(p.size.height))
      rectEl.setAttribute('rx', String(p.radius))
    }
  }

  useEffect(() => {
    const syncBenchGap = (gapPx: number) => {
      const cfg = configRef.current
      const activeTheme = themeRef.current
      const activeMat = materialRef.current
      const activeRefract = refractionRef.current
      const activeSize = cfg.renderView === 'split' ? sizeRef.current.split : sizeRef.current.single
      const field: GlassFieldState = {
        primitives: buildOpticsLabPrimitives(activeSize, gapPx),
        blendK: cfg.blendK,
        rimOpacity: 1,
        styleMix: cfg.rimMode === 'soft' ? 1 : 0,
      }
      primarySurfaceRef.current?.render({
        field,
        material: activeMat,
        refraction: activeRefract,
        theme: activeTheme,
      })
      if (cfg.renderView === 'split') {
        secondarySurfaceRef.current?.render({
          field,
          material: fallbackMaterialRef.current,
          refraction: activeRefract,
          theme: activeTheme,
        })
      }
      if (cfg.showWireframe) {
        updateWireframeDom(field, primaryWirePathRef.current, primaryRectRefs.current)
        if (cfg.renderView === 'split') {
          updateWireframeDom(field, secondaryWirePathRef.current, secondaryRectRefs.current)
        }
      }
    }

    if (!config.oscillateGap || reducedMotion) {
      if (gapReadoutRef.current) {
        gapReadoutRef.current.textContent = `${config.gapPx.toFixed(1)}px`
      }
      syncBenchGap(config.gapPx)
      return
    }
    let phase = 0
    const loop = createFrameLoop((dtSec) => {
      phase += dtSec * 1.45
      if (!configRef.current.oscillateGap) return false
      const dynamicGap = Math.round((16 + 34 * Math.sin(phase)) * 10) / 10
      if (gapReadoutRef.current) {
        gapReadoutRef.current.textContent = `${dynamicGap.toFixed(1)}px ${liveSuffixRef.current}`
      }
      syncBenchGap(dynamicGap)
      return true
    })
    loop.start()
    return () => {
      loop.stop()
    }
  }, [
    config.oscillateGap,
    config.gapPx,
    config.blendK,
    config.rimMode,
    config.showWireframe,
    config.renderView,
    material,
    fallbackMaterial,
    refraction,
    theme,
    stageSize,
    splitSize,
    reducedMotion,
  ])

  const handleCapabilitiesChange = useCallback((caps: GlassSurfaceCapabilities) => {
    const view = configRef.current.renderView
    if ((view === 'refract' || view === 'split') && !caps.svgBackdropRefraction) {
      setTierKey(view === 'split' ? 'splitDowngraded' : 'refractDowngraded')
    } else {
      setTierKey(view)
    }
  }, [])

  const updateConfig = <K extends keyof OpticsLabConfig>(key: K, value: OpticsLabConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  const singleField: GlassFieldState = useMemo(
    () => ({
      primitives: activeSinglePrimitives,
      blendK: config.blendK,
      rimOpacity: 1,
      styleMix: config.rimMode === 'soft' ? 1 : 0,
    }),
    [activeSinglePrimitives, config.blendK, config.rimMode],
  )

  const splitField: GlassFieldState = useMemo(
    () => ({
      primitives: activeSplitPrimitives,
      blendK: config.blendK,
      rimOpacity: 1,
      styleMix: config.rimMode === 'soft' ? 1 : 0,
    }),
    [activeSplitPrimitives, config.blendK, config.rimMode],
  )

  const requestedMode: SurfaceRenderMode =
    config.renderView === 'split' ? 'refract' : config.renderView

  return (
    <>
      {config.renderView === 'split' ? (
        <div className="pg-stage-split" data-testid="optics-split-stage">
          <div className="pg-split-pane" ref={splitLeftRef}>
            <TestChart
              title={op.splitLeftTitle}
              caption={op.splitLeftCaption}
              messages={t.chart}
              wordmark={false}
            />
            <GlassField
              className="pg-glass-stage"
              controllerRef={primarySurfaceRef}
              mode="refract"
              theme={theme}
              blendK={config.blendK}
              styleMix={config.rimMode === 'soft' ? 1 : 0}
              primitives={splitField.primitives}
              material={material}
              refraction={refraction}
              onCapabilitiesChange={handleCapabilitiesChange}
            />
            {config.showWireframe ? (
              <SdfWireframeOverlay
                field={splitField}
                pathRef={(el) => {
                  primaryWirePathRef.current = el
                }}
                primRefs={(idx, el) => {
                  primaryRectRefs.current[idx] = el
                }}
              />
            ) : null}
          </div>

          <div className="pg-split-pane">
            <TestChart
              title={op.splitRightTitle}
              caption={op.splitRightCaption}
              messages={t.chart}
              wordmark={false}
            />
            <GlassField
              className="pg-glass-stage"
              controllerRef={secondarySurfaceRef}
              mode="frosted"
              theme={theme}
              blendK={config.blendK}
              styleMix={config.rimMode === 'soft' ? 1 : 0}
              primitives={splitField.primitives}
              material={fallbackMaterial}
              refraction={refraction}
            />
            {config.showWireframe ? (
              <SdfWireframeOverlay
                field={splitField}
                pathRef={(el) => {
                  secondaryWirePathRef.current = el
                }}
                primRefs={(idx, el) => {
                  secondaryRectRefs.current[idx] = el
                }}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="pg-stage" ref={singleStageRef} data-testid="optics-single-stage">
          <TestChart
            title={op.backdropTitle}
            caption={op.backdropCaption}
            messages={t.chart}
          />
          <GlassField
            className="pg-glass-stage"
            controllerRef={primarySurfaceRef}
            mode={requestedMode}
            theme={theme}
            blendK={config.blendK}
            styleMix={config.rimMode === 'soft' ? 1 : 0}
            primitives={singleField.primitives}
            material={material}
            refraction={refraction}
            onCapabilitiesChange={handleCapabilitiesChange}
          />
          {config.showWireframe ? (
            <SdfWireframeOverlay
              field={singleField}
              pathRef={(el) => {
                primaryWirePathRef.current = el
              }}
              primRefs={(idx, el) => {
                primaryRectRefs.current[idx] = el
              }}
            />
          ) : null}
        </div>
      )}

      <ControlPanel title={op.panelTitle} description={op.panelDescription}>
        <div className="pg-btn-group">
          {(['refract', 'frosted', 'solid', 'split'] as const satisfies readonly OpticsViewMode[]).map(
            (modeKey) => (
              <button
                key={modeKey}
                type="button"
                className="pg-btn"
                aria-pressed={config.renderView === modeKey}
                onClick={() => updateConfig('renderView', modeKey)}
              >
                {op.views[modeKey]}
              </button>
            ),
          )}
        </div>

        <SliderControl
          id="optics-gap"
          label={op.gapLabel}
          value={config.gapPx}
          min={-24}
          max={56}
          unit="px"
          onChange={(v) => updateConfig('gapPx', v)}
        />
        <SliderControl
          id="optics-blend"
          label={op.blendKLabel}
          value={config.blendK}
          min={0}
          max={56}
          unit="px"
          onChange={(v) => updateConfig('blendK', v)}
        />
        <SliderControl
          id="optics-bevel"
          label={op.bevelLabel}
          value={config.bevelPx}
          min={4}
          max={32}
          unit="px"
          onChange={(v) => updateConfig('bevelPx', v)}
        />
        <div className="bench-backdrop">
          <div className="bench-backdrop-label">{op.profileLabel}</div>
          <div className="pg-btn-group">
            {(
              ['squircle', 'circle', 'parabolic', 'lip'] as const satisfies readonly RefractionProfileName[]
            ).map((profileKey) => (
              <button
                key={profileKey}
                type="button"
                className="pg-btn"
                aria-pressed={config.refractionProfile === profileKey}
                onClick={() => updateConfig('refractionProfile', profileKey)}
              >
                {op.profiles[profileKey]}
              </button>
            ))}
          </div>
        </div>
        <SliderControl
          id="optics-ior"
          label={op.iorLabel}
          value={config.ior}
          min={1.0}
          max={2.4}
          step={0.05}
          precision={2}
          onChange={(v) => updateConfig('ior', v)}
        />
        <SliderControl
          id="optics-strength"
          label={op.strengthLabel}
          value={config.refractionStrength}
          min={0}
          max={2.2}
          step={0.05}
          precision={2}
          onChange={(v) => updateConfig('refractionStrength', v)}
        />
        <SliderControl
          id="optics-dispersion"
          label={op.dispersionLabel}
          value={config.dispersionPx}
          min={0}
          max={4}
          step={0.1}
          precision={1}
          unit="px"
          onChange={(v) => updateConfig('dispersionPx', v)}
        />
        <SliderControl
          id="optics-blur"
          label={op.blurLabel}
          value={config.blurPx}
          min={0}
          max={24}
          step={0.5}
          precision={1}
          unit="px"
          onChange={(v) => updateConfig('blurPx', v)}
        />
        <SliderControl
          id="optics-saturation"
          label={op.saturationLabel}
          value={config.saturation}
          min={0.5}
          max={3.2}
          step={0.05}
          precision={2}
          onChange={(v) => updateConfig('saturation', v)}
        />
        <SliderControl
          id="optics-tint"
          label={op.tintLabel}
          value={config.tintAlpha}
          min={0}
          max={0.8}
          step={0.02}
          precision={2}
          onChange={(v) => updateConfig('tintAlpha', v)}
        />
        <SliderControl
          id="optics-rim-opacity"
          label={op.rimOpacityLabel}
          value={config.rimOpacity}
          min={0}
          max={0.85}
          step={0.02}
          precision={2}
          onChange={(v) => updateConfig('rimOpacity', v)}
        />

        <div className="pg-btn-group">
          {(['directional', 'soft', 'physical'] as const).map((rm: RimMode) => (
            <button
              key={rm}
              type="button"
              className="pg-btn"
              aria-pressed={config.rimMode === rm}
              onClick={() => updateConfig('rimMode', rm)}
            >
              {op.rimModes[rm]}
            </button>
          ))}
        </div>

        {config.rimMode === 'physical' ? (
          <SliderControl
            id="optics-light-angle"
            label={op.lightAngleLabel}
            value={config.lightAngle}
            min={-180}
            max={180}
            step={5}
            unit="°"
            onChange={(v) => updateConfig('lightAngle', v)}
          />
        ) : null}

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={config.caustics}
            onClick={() => updateConfig('caustics', !config.caustics)}
          >
            {op.causticsButton}
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={config.showWireframe}
            onClick={() => updateConfig('showWireframe', !config.showWireframe)}
          >
            {op.wireframeButton}
          </button>
          <button
            type="button"
            className="pg-btn"
            disabled={reducedMotion}
            aria-pressed={config.oscillateGap && !reducedMotion}
            onClick={() => updateConfig('oscillateGap', !config.oscillateGap)}
          >
            {op.oscillateButton}
          </button>
          <button
            type="button"
            className="pg-btn"
            onClick={() => setConfig(DEFAULT_OPTICS_LAB_CONFIG)}
          >
            {op.resetButton}
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">{op.statEffectiveTier}</div>
            <div className="pg-stat-value">{op.tierLabels[tierKey]}</div>
          </div>
          <div>
            <div className="pg-stat-label">{op.statGapOffset}</div>
            <div className="pg-stat-value">
              <span ref={gapReadoutRef}>{config.gapPx.toFixed(1)}px</span>
            </div>
          </div>
        </div>
      </ControlPanel>
    </>
  )
}
