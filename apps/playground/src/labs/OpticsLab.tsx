import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
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
} from '@sessile/dom'
import { GlassField } from '@sessile/react'
import {
  ControlPanel,
  ControlSection,
  SegmentedControl,
  SliderControl,
  SwitchControl,
  TelemetryGrid,
  TelemetryItem,
} from '../components/ControlPanel.tsx'
import { TestChart } from '../components/TestChart.tsx'
import { getMessages, type Locale, type PlaygroundMessages } from '../i18n.ts'
import {
  DEFAULT_OPTICS_LAB_CONFIG,
  buildOpticsLabPrimitives,
  updateWireframeDom,
  type GlobalGlassMaterial,
  type OpticsLabConfig,
  type OpticsPresetId,
  type OpticsViewMode,
} from '../labDefaults.ts'

type TierLabelKey = keyof PlaygroundMessages['optics']['tierLabels']
type OpticsBank = 'geometry' | 'optics' | 'surface'

const DEFAULT_SPLIT_STAGE: Size = { width: 420, height: 520 }
const OPTICS_PRESET_IDS: readonly OpticsPresetId[] = ['crown', 'prism', 'meniscus', 'frost']
const OPTICS_BANKS: readonly OpticsBank[] = ['geometry', 'optics', 'surface']

const PROFILE_GLYPHS: Readonly<Record<RefractionProfileName, ReactElement>> = {
  squircle: (
    <svg width="16" height="10" viewBox="0 0 18 10" fill="none">
      <path d="M1 9 C1 2.5 5 1.5 17 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  circle: (
    <svg width="16" height="10" viewBox="0 0 18 10" fill="none">
      <path d="M1 9 A9 8 0 0 1 10 1.5 L17 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  parabolic: (
    <svg width="16" height="10" viewBox="0 0 18 10" fill="none">
      <path d="M1 9 Q6 1.5 17 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  lip: (
    <svg width="16" height="10" viewBox="0 0 18 10" fill="none">
      <path d="M1 9 C3 2 6 1 9 2.5 C12 4 14 2 17 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
}

export interface SdfWireframeOverlayProps {
  field: GlassFieldState
  pathRef?: (el: SVGPathElement | null) => void
  primRefs?: (index: number, el: SVGRectElement | null) => void
}

export function SdfWireframeOverlay({
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
      <path ref={pathRef} d={contourPath} className="pg-wire-contour" />
    </svg>
  )
}

export interface GlobalMaterialPanelProps {
  locale: Locale
  reducedMotion: boolean
  config: OpticsLabConfig
  activePreset: OpticsPresetId | null
  svgRefractionSupported: boolean
  gapReadoutRef: RefObject<HTMLElement | null>
  headerSlot?: ReactNode
  onUpdateConfig: <K extends keyof OpticsLabConfig>(key: K, value: OpticsLabConfig[K]) => void
  onApplyPreset: (presetId: OpticsPresetId) => void
  onReset: () => void
}

export function GlobalMaterialPanel({
  locale,
  reducedMotion,
  config,
  activePreset,
  svgRefractionSupported,
  gapReadoutRef,
  headerSlot,
  onUpdateConfig,
  onApplyPreset,
  onReset,
}: GlobalMaterialPanelProps): ReactElement {
  const t = getMessages(locale)
  const op = t.optics
  const [activeBank, setActiveBank] = useState<OpticsBank>('geometry')

  const isSplit = config.renderView === 'split'
  const tierKey: TierLabelKey = isSplit
    ? svgRefractionSupported
      ? 'split'
      : 'splitDowngraded'
    : config.renderView === 'refract' && !svgRefractionSupported
      ? 'refractDowngraded'
      : config.renderView

  return (
    <ControlPanel
      title={op.panelTitle}
      description={op.panelDescription}
      headerSlot={headerSlot}
    >
      <ControlSection title={op.sectionView}>
        <SegmentedControl
          ariaLabel={op.sectionView}
          value={config.renderView}
          size="sm"
          onChange={(modeKey) => onUpdateConfig('renderView', modeKey)}
          options={(['refract', 'frosted', 'solid', 'split'] as const satisfies readonly OpticsViewMode[]).map(
            (modeKey) => ({
              value: modeKey,
              label: op.views[modeKey],
            }),
          )}
        />
      </ControlSection>

      <ControlSection title={op.sectionPreset}>
        <SegmentedControl
          ariaLabel={op.sectionPreset}
          value={(activePreset ?? '') as OpticsPresetId}
          size="sm"
          onChange={onApplyPreset}
          options={OPTICS_PRESET_IDS.map((presetId) => ({
            value: presetId,
            label: op.presets[presetId],
          }))}
        />
      </ControlSection>

      <section className="pg-section">
        <SegmentedControl
          ariaLabel={op.panelTitle}
          value={activeBank}
          size="sm"
          onChange={setActiveBank}
          options={OPTICS_BANKS.map((bank) => ({
            value: bank,
            label: op.banks[bank],
          }))}
        />
        <div className="pg-section-body">
          {activeBank === 'geometry' ? (
            <>
              {isSplit ? (
                <>
                  <SliderControl
                    id="optics-gap"
                    label={op.gapLabel}
                    value={config.gapPx}
                    defaultValue={DEFAULT_OPTICS_LAB_CONFIG.gapPx}
                    min={-24}
                    max={56}
                    unit="px"
                    onChange={(v) => onUpdateConfig('gapPx', v)}
                  />
                  <SliderControl
                    id="optics-blend"
                    label={op.blendKLabel}
                    value={config.blendK}
                    defaultValue={DEFAULT_OPTICS_LAB_CONFIG.blendK}
                    min={0}
                    max={56}
                    unit="px"
                    onChange={(v) => onUpdateConfig('blendK', v)}
                  />
                </>
              ) : null}
              <SliderControl
                id="optics-bevel"
                label={op.bevelLabel}
                value={config.bevelPx}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.bevelPx}
                min={4}
                max={32}
                unit="px"
                onChange={(v) => onUpdateConfig('bevelPx', v)}
              />
              <div className="pg-sub-label">{op.profileLabel}</div>
              <SegmentedControl
                ariaLabel={op.profileLabel}
                value={config.refractionProfile}
                columns={2}
                size="sm"
                onChange={(profileKey) => onUpdateConfig('refractionProfile', profileKey)}
                options={(
                  ['squircle', 'circle', 'parabolic', 'lip'] as const satisfies readonly RefractionProfileName[]
                ).map((profileKey) => ({
                  value: profileKey,
                  label: op.profiles[profileKey],
                  icon: PROFILE_GLYPHS[profileKey],
                }))}
              />
            </>
          ) : null}

          {activeBank === 'optics' ? (
            <>
              <SliderControl
                id="optics-ior"
                label={op.iorLabel}
                value={config.ior}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.ior}
                min={1.0}
                max={2.4}
                step={0.05}
                precision={2}
                onChange={(v) => onUpdateConfig('ior', v)}
              />
              <SliderControl
                id="optics-strength"
                label={op.strengthLabel}
                value={config.refractionStrength}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.refractionStrength}
                min={0}
                max={2.2}
                step={0.05}
                precision={2}
                onChange={(v) => onUpdateConfig('refractionStrength', v)}
              />
              <SliderControl
                id="optics-dispersion"
                label={op.dispersionLabel}
                value={config.dispersionPx}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.dispersionPx}
                min={0}
                max={4}
                step={0.1}
                precision={1}
                unit="px"
                onChange={(v) => onUpdateConfig('dispersionPx', v)}
              />
              <SwitchControl
                id="optics-caustics"
                label={op.causticsButton}
                checked={config.caustics}
                onChange={(checked) => onUpdateConfig('caustics', checked)}
              />
            </>
          ) : null}

          {activeBank === 'surface' ? (
            <>
              <SliderControl
                id="optics-blur"
                label={op.blurLabel}
                value={config.blurPx}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.blurPx}
                min={0}
                max={24}
                step={0.5}
                precision={1}
                unit="px"
                onChange={(v) => onUpdateConfig('blurPx', v)}
              />
              <SliderControl
                id="optics-saturation"
                label={op.saturationLabel}
                value={config.saturation}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.saturation}
                min={0.5}
                max={3.2}
                step={0.05}
                precision={2}
                onChange={(v) => onUpdateConfig('saturation', v)}
              />
              <SliderControl
                id="optics-tint"
                label={op.tintLabel}
                value={config.tintAlpha}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.tintAlpha}
                min={0}
                max={0.8}
                step={0.02}
                precision={2}
                onChange={(v) => onUpdateConfig('tintAlpha', v)}
              />
              <SliderControl
                id="optics-rim-opacity"
                label={op.rimOpacityLabel}
                value={config.rimOpacity}
                defaultValue={DEFAULT_OPTICS_LAB_CONFIG.rimOpacity}
                min={0}
                max={0.85}
                step={0.02}
                precision={2}
                onChange={(v) => onUpdateConfig('rimOpacity', v)}
              />
              <div className="pg-sub-label">{op.rimModeLabel}</div>
              <SegmentedControl
                ariaLabel={op.rimModeLabel}
                value={config.rimMode}
                size="sm"
                onChange={(rm) => onUpdateConfig('rimMode', rm)}
                options={(['directional', 'soft', 'physical'] as const satisfies readonly RimMode[]).map(
                  (rm) => ({
                    value: rm,
                    label: op.rimModes[rm],
                  }),
                )}
              />
              {config.rimMode === 'physical' ? (
                <SliderControl
                  id="optics-light-angle"
                  label={op.lightAngleLabel}
                  value={config.lightAngle}
                  defaultValue={DEFAULT_OPTICS_LAB_CONFIG.lightAngle}
                  min={-180}
                  max={180}
                  step={5}
                  unit="°"
                  onChange={(v) => onUpdateConfig('lightAngle', v)}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <ControlSection title={op.sectionStage}>
        <SwitchControl
          id="optics-wireframe"
          label={op.wireframeButton}
          checked={config.showWireframe}
          onChange={(checked) => onUpdateConfig('showWireframe', checked)}
        />
        {isSplit ? (
          <SwitchControl
            id="optics-oscillate"
            label={op.oscillateButton}
            checked={config.oscillateGap && !reducedMotion}
            disabled={reducedMotion}
            onChange={(checked) => onUpdateConfig('oscillateGap', checked)}
          />
        ) : null}
        <div className="pg-btn-group">
          <button type="button" className="pg-btn" onClick={onReset}>
            {op.resetButton}
          </button>
        </div>
      </ControlSection>

      <TelemetryGrid>
        <TelemetryItem label={op.statEffectiveTier} value={op.tierLabels[tierKey]} />
        {isSplit ? (
          <TelemetryItem
            label={op.statGapOffset}
            value={`${config.gapPx.toFixed(1)}px`}
            valueRef={gapReadoutRef}
          />
        ) : (
          <TelemetryItem label={op.iorLabel} value={config.ior.toFixed(2)} />
        )}
      </TelemetryGrid>
    </ControlPanel>
  )
}

export interface OpticsCompareStageProps {
  theme: ThemeMode
  locale: Locale
  reducedMotion: boolean
  glass: GlobalGlassMaterial
  gapReadoutRef: RefObject<HTMLElement | null>
  onGapChange: (gapPx: number) => void
  onStopOscillate: () => void
  onCapabilitiesChange?: (caps: GlassSurfaceCapabilities) => void
}

export function OpticsCompareStage({
  theme,
  locale,
  reducedMotion,
  glass,
  gapReadoutRef,
  onGapChange,
  onStopOscillate,
  onCapabilitiesChange,
}: OpticsCompareStageProps): ReactElement {
  const t = getMessages(locale)
  const op = t.optics
  const { config, material, fallbackMaterial, refraction, styleMix } = glass

  const [splitSize, setSplitSize] = useState<Size>(DEFAULT_SPLIT_STAGE)
  const splitLeftRef = useRef<HTMLDivElement | null>(null)
  const primarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const secondarySurfaceRef = useRef<GlassSurfaceController | null>(null)
  const primaryWirePathRef = useRef<SVGPathElement | null>(null)
  const secondaryWirePathRef = useRef<SVGPathElement | null>(null)
  const primaryRectRefs = useRef<Array<SVGRectElement | null>>([])
  const secondaryRectRefs = useRef<Array<SVGRectElement | null>>([])
  const satelliteHitboxRefs = useRef<Array<HTMLDivElement | null>>([])
  const dragGapRef = useRef<{ pointerId: number; startX: number; startGap: number } | null>(null)
  // Last gap actually drawn; differs from config.gapPx while the breathe animation runs.
  const renderedGapRef = useRef(config.gapPx)

  const splitPrimitives = useMemo(
    () => buildOpticsLabPrimitives(splitSize, config.gapPx),
    [splitSize, config.gapPx],
  )
  const splitField: GlassFieldState = useMemo(
    () => ({
      primitives: splitPrimitives,
      blendK: config.blendK,
      rimOpacity: 1,
      styleMix,
    }),
    [splitPrimitives, config.blendK, styleMix],
  )

  const latestRef = useRef({
    config,
    material,
    fallbackMaterial,
    refraction,
    styleMix,
    theme,
    liveSuffix: op.liveSuffix,
    splitSize,
  })

  useEffect(() => {
    latestRef.current = {
      config,
      material,
      fallbackMaterial,
      refraction,
      styleMix,
      theme,
      liveSuffix: op.liveSuffix,
      splitSize,
    }
  }, [config, material, fallbackMaterial, refraction, styleMix, theme, op.liveSuffix, splitSize])

  useEffect(() => {
    const el = splitLeftRef.current
    if (!el) return
    return observeElementResize(
      el,
      (next) => {
        if (next.width > 0 && next.height > 0) {
          setSplitSize(next)
        }
      },
      { emitInitial: true },
    )
  }, [])

  useEffect(() => {
    const syncSplitGap = (gapPx: number) => {
      renderedGapRef.current = gapPx
      const l = latestRef.current
      const field: GlassFieldState = {
        primitives: buildOpticsLabPrimitives(l.splitSize, gapPx),
        blendK: l.config.blendK,
        rimOpacity: 1,
        styleMix: l.styleMix,
      }
      primarySurfaceRef.current?.render({
        field,
        material: l.material,
        refraction: l.refraction,
        theme: l.theme,
      })
      secondarySurfaceRef.current?.render({
        field,
        material: l.fallbackMaterial,
        refraction: l.refraction,
        theme: l.theme,
      })
      if (l.config.showWireframe) {
        updateWireframeDom(field, primaryWirePathRef.current, primaryRectRefs.current)
        updateWireframeDom(field, secondaryWirePathRef.current, secondaryRectRefs.current)
      }
      const sat = field.primitives[1]
      if (sat) {
        const x = sat.center.x - sat.size.width * 0.5
        const y = sat.center.y - sat.size.height * 0.5
        for (const el of satelliteHitboxRefs.current) {
          if (!el) continue
          el.style.width = `${sat.size.width}px`
          el.style.height = `${sat.size.height}px`
          el.style.borderRadius = `${sat.radius}px`
          el.style.transform = `translate3d(${x}px, ${y}px, 0)`
        }
      }
    }

    if (!config.oscillateGap || reducedMotion) {
      if (gapReadoutRef.current) {
        gapReadoutRef.current.textContent = `${config.gapPx.toFixed(1)}px`
      }
      syncSplitGap(config.gapPx)
      return
    }

    let phase = 0
    const loop = createFrameLoop((dtSec) => {
      phase += dtSec * 1.45
      if (!latestRef.current.config.oscillateGap) return false
      const dynamicGap = Math.round((16 + 34 * Math.sin(phase)) * 10) / 10
      if (gapReadoutRef.current) {
        gapReadoutRef.current.textContent = `${dynamicGap.toFixed(1)}px ${latestRef.current.liveSuffix}`
      }
      syncSplitGap(dynamicGap)
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
    config.showWireframe,
    styleMix,
    material,
    fallbackMaterial,
    refraction,
    theme,
    splitSize,
    reducedMotion,
    gapReadoutRef,
  ])

  const handleCapabilities = useCallback(
    (caps: GlassSurfaceCapabilities) => {
      onCapabilitiesChange?.(caps)
    },
    [onCapabilitiesChange],
  )

  const handleSatellitePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startGap = renderedGapRef.current
    if (config.oscillateGap) {
      // Freeze at the live gap so the stopped effect does not snap back to the stored value.
      onGapChange(startGap)
      onStopOscillate()
    }
    dragGapRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startGap,
    }
  }

  const handleSatellitePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragGapRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const nextGap = Math.max(-24, Math.min(56, Math.round(drag.startGap + (e.clientX - drag.startX) * 2)))
    if (nextGap !== latestRef.current.config.gapPx) {
      onGapChange(nextGap)
    }
  }

  const handleSatellitePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragGapRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragGapRef.current = null
  }

  const renderSatelliteHitbox = (slotIndex: number, primitive: GlassPrimitive | undefined) => {
    if (!primitive) return null
    const x = primitive.center.x - primitive.size.width * 0.5
    const y = primitive.center.y - primitive.size.height * 0.5
    return (
      <div
        ref={(el) => {
          satelliteHitboxRefs.current[slotIndex] = el
        }}
        className="pg-optics-drag-lens"
        style={{
          width: `${primitive.size.width}px`,
          height: `${primitive.size.height}px`,
          borderRadius: `${primitive.radius}px`,
          transform: `translate3d(${x}px, ${y}px, 0)`,
        }}
        title={op.dragLensHint}
        onPointerDown={handleSatellitePointerDown}
        onPointerMove={handleSatellitePointerMove}
        onPointerUp={handleSatellitePointerEnd}
        onPointerCancel={handleSatellitePointerEnd}
      >
        <span>{op.dragLensHint}</span>
      </div>
    )
  }

  return (
    <div className="pg-stage-split" data-testid="optics-split-stage">
      <div className="pg-split-pane">
        <header className="pg-split-head">
          <h3 className="pg-split-title">{op.splitLeftTitle}</h3>
          <p className="pg-split-caption">{op.splitLeftCaption}</p>
        </header>
        <div className="pg-split-pane-stage" ref={splitLeftRef}>
          <TestChart messages={t.chart} compact />
          <GlassField
            className="pg-glass-stage"
            controllerRef={primarySurfaceRef}
            mode="refract"
            theme={theme}
            blendK={config.blendK}
            styleMix={styleMix}
            primitives={splitField.primitives}
            material={material}
            refraction={refraction}
            onCapabilitiesChange={handleCapabilities}
          >
            {renderSatelliteHitbox(0, splitField.primitives[1])}
          </GlassField>
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
      </div>

      <div className="pg-split-pane">
        <header className="pg-split-head">
          <h3 className="pg-split-title">{op.splitRightTitle}</h3>
          <p className="pg-split-caption">{op.splitRightCaption}</p>
        </header>
        <div className="pg-split-pane-stage">
          <TestChart messages={t.chart} compact />
          <GlassField
            className="pg-glass-stage"
            controllerRef={secondarySurfaceRef}
            mode="frosted"
            theme={theme}
            blendK={config.blendK}
            styleMix={styleMix}
            primitives={splitField.primitives}
            material={fallbackMaterial}
            refraction={refraction}
          >
            {renderSatelliteHitbox(1, splitField.primitives[1])}
          </GlassField>
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
    </div>
  )
}
