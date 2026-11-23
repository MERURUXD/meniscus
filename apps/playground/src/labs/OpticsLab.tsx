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
  type RimMode,
  type Size,
  type ThemeMode,
} from '@meniscus/core'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type GlassSurfaceCapabilities,
  type RefractFilterConfig,
  type SurfaceRenderMode,
} from '@meniscus/dom'
import { GlassField } from '@meniscus/react'
import { ControlPanel, SliderControl } from '../components/ControlPanel.tsx'
import { LiveBackdrop } from '../components/LiveBackdrop.tsx'
import {
  DEFAULT_OPTICS_LAB_CONFIG,
  buildOpticsLabMaterial,
  buildOpticsLabPrimitives,
  type OpticsLabConfig,
  type OpticsViewMode,
} from '../labDefaults.ts'

export interface OpticsLabProps {
  theme: ThemeMode
  reducedMotion: boolean
}

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
          fill="none"
          stroke="rgba(236, 72, 153, 0.85)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
      ))}
      <path
        ref={pathRef}
        d={contourPath}
        fill="none"
        stroke="rgba(14, 165, 233, 0.95)"
        strokeWidth={2}
      />
    </svg>
  )
}

export function OpticsLab({ theme, reducedMotion }: OpticsLabProps): ReactElement {
  const [config, setConfig] = useState<OpticsLabConfig>(DEFAULT_OPTICS_LAB_CONFIG)
  const [stageSize, setStageSize] = useState<Size>(DEFAULT_SINGLE_STAGE)
  const [splitSize, setSplitSize] = useState<Size>(DEFAULT_SPLIT_STAGE)
  const [effectiveModeLabel, setEffectiveModeLabel] = useState<string>('refract')

  const singleStageRef = useRef<HTMLDivElement | null>(null)
  const splitLeftRef = useRef<HTMLDivElement | null>(null)

  const primarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const secondarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const gapReadoutRef = useRef<HTMLSpanElement | null>(null)
  const primaryWirePathRef = useRef<SVGPathElement | null>(null)
  const secondaryWirePathRef = useRef<SVGPathElement | null>(null)
  const primaryRectRefs = useRef<Array<SVGRectElement | null>>([])
  const secondaryRectRefs = useRef<Array<SVGRectElement | null>>([])

  const material = useMemo(() => buildOpticsLabMaterial(theme, config), [theme, config])
  const refraction = useMemo<Partial<RefractFilterConfig>>(
    () => ({
      bezel: config.bevelPx,
      strength: config.refractionStrength,
      dispersion: config.dispersionPx,
    }),
    [config.bevelPx, config.refractionStrength, config.dispersionPx],
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
  const refractionRef = useRef(refraction)
  const themeRef = useRef(theme)
  const sizeRef = useRef({ single: stageSize, split: splitSize })

  useEffect(() => {
    configRef.current = config
    materialRef.current = material
    refractionRef.current = refraction
    themeRef.current = theme
    sizeRef.current = { single: stageSize, split: splitSize }
  }, [config, material, refraction, theme, stageSize, splitSize])

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
    if (ctrl) {
      const nextLabel =
        config.renderView === 'split'
          ? `${ctrl.getEffectiveMode()} + frosted`
          : ctrl.getEffectiveMode()
      setEffectiveModeLabel(nextLabel)
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
          material: activeMat,
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
        gapReadoutRef.current.textContent = `${dynamicGap.toFixed(1)}px (live)`
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
    refraction,
    theme,
    stageSize,
    splitSize,
    reducedMotion,
  ])

  const handleCapabilitiesChange = useCallback((caps: GlassSurfaceCapabilities) => {
    const view = configRef.current.renderView
    if ((view === 'refract' || view === 'split') && !caps.svgBackdropRefraction) {
      setEffectiveModeLabel(view === 'split' ? 'frosted + frosted' : 'frosted (auto-downgraded)')
    } else {
      setEffectiveModeLabel(view === 'split' ? 'refract + frosted' : view)
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
    <div className="pg-lab-grid">
      {config.renderView === 'split' ? (
        <div className="pg-stage-split" data-testid="optics-split-stage">
          <div className="pg-split-pane" ref={splitLeftRef}>
            <div className="pg-split-badge">Requested: Refract (Route B3)</div>
            <LiveBackdrop
              title="Route B3 Lens"
              caption="Stored-PNG SDF displacement + chromatic dispersion."
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
            <div className="pg-split-badge">Fallback: Frosted Contour</div>
            <LiveBackdrop
              title="Frosted Veil"
              caption="Universal CSS backdrop blur + SDF contour + WebGL2 rim."
            />
            <GlassField
              className="pg-glass-stage"
              controllerRef={secondarySurfaceRef}
              mode="frosted"
              theme={theme}
              blendK={config.blendK}
              styleMix={config.rimMode === 'soft' ? 1 : 0}
              primitives={splitField.primitives}
              material={material}
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
          <LiveBackdrop
            title="Optics & Progressive Degradation"
            caption="Tune bevel lens width, RGB dispersion, blur, and separation gap over crisp text and spectral swatches."
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

      <ControlPanel
        title="Optical Bench Parameters"
        description="Inspect Route B3 displacement refraction vs Gaussian frosted fallback and live SDF contours."
      >
        <div className="pg-btn-group">
          {(
            [
              ['refract', 'Refract'],
              ['frosted', 'Frosted'],
              ['solid', 'Solid'],
              ['split', 'Split Compare'],
            ] as readonly [OpticsViewMode, string][]
          ).map(([modeKey, label]) => (
            <button
              key={modeKey}
              type="button"
              className="pg-btn"
              aria-pressed={config.renderView === modeKey}
              onClick={() => updateConfig('renderView', modeKey)}
            >
              {label}
            </button>
          ))}
        </div>

        <SliderControl
          id="optics-gap"
          label="Primitive Separation"
          value={config.gapPx}
          min={-24}
          max={56}
          unit="px"
          onChange={(v) => updateConfig('gapPx', v)}
        />
        <SliderControl
          id="optics-blend"
          label="Smooth Union (blendK)"
          value={config.blendK}
          min={0}
          max={56}
          unit="px"
          onChange={(v) => updateConfig('blendK', v)}
        />
        <SliderControl
          id="optics-bevel"
          label="Bevel Lens Width"
          value={config.bevelPx}
          min={4}
          max={32}
          unit="px"
          onChange={(v) => updateConfig('bevelPx', v)}
        />
        <SliderControl
          id="optics-strength"
          label="Refraction Strength"
          value={config.refractionStrength}
          min={0}
          max={2.2}
          step={0.05}
          precision={2}
          onChange={(v) => updateConfig('refractionStrength', v)}
        />
        <SliderControl
          id="optics-dispersion"
          label="RGB Dispersion"
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
          label="Gaussian Blur"
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
          label="Backdrop Saturation"
          value={config.saturation}
          min={0.5}
          max={3.2}
          step={0.05}
          precision={2}
          onChange={(v) => updateConfig('saturation', v)}
        />
        <SliderControl
          id="optics-rim-opacity"
          label="Rim Highlight Opacity"
          value={config.rimOpacity}
          min={0}
          max={0.85}
          step={0.02}
          precision={2}
          onChange={(v) => updateConfig('rimOpacity', v)}
        />

        <div className="pg-btn-group">
          {(['directional', 'soft'] as const).map((rm: RimMode) => (
            <button
              key={rm}
              type="button"
              className="pg-btn"
              aria-pressed={config.rimMode === rm}
              onClick={() => updateConfig('rimMode', rm)}
            >
              Rim: {rm}
            </button>
          ))}
        </div>

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={config.showWireframe}
            onClick={() => updateConfig('showWireframe', !config.showWireframe)}
          >
            SDF Wireframe
          </button>
          <button
            type="button"
            className="pg-btn"
            disabled={reducedMotion}
            aria-pressed={config.oscillateGap && !reducedMotion}
            onClick={() => updateConfig('oscillateGap', !config.oscillateGap)}
          >
            Oscillate Gap
          </button>
          <button
            type="button"
            className="pg-btn"
            onClick={() => setConfig(DEFAULT_OPTICS_LAB_CONFIG)}
          >
            Reset Optics
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">Effective Tier</div>
            <div className="pg-stat-value">{effectiveModeLabel}</div>
          </div>
          <div>
            <div className="pg-stat-label">Gap Offset</div>
            <div className="pg-stat-value">
              <span ref={gapReadoutRef}>{config.gapPx.toFixed(1)}px</span>
            </div>
          </div>
        </div>
      </ControlPanel>
    </div>
  )
}
