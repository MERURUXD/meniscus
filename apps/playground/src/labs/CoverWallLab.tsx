import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { type Size, type ThemeMode } from '@sessile/core'
import {
  LEGIBILITY_POLICIES,
  linearToSrgb,
  measureTelemetryGrid,
  relativeLuminance,
  srgbLuma,
  type BackdropTelemetry,
  type BackdropTelemetryGrid,
  type ForegroundPolarity,
  type LegibilityParams,
  type LegibilityTier,
} from '@sessile/core/legibility'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type FrameLoop,
  type SurfaceRenderMode,
} from '@sessile/dom'
import { createGlassLegibility, createRegionProbe, type RegionProbe } from '@sessile/dom/legibility'
import { GlassField } from '@sessile/react/experimental'
import {
  createDragMergeController,
  type DragMergeController,
  type DragMergeState,
} from '@sessile/presets/experimental'
import {
  ControlPanel,
  ControlSection,
  SegmentedControl,
  TelemetryGrid,
  TelemetryItem,
} from '../components/ControlPanel.tsx'
import { COVER_SIZE, createCoverSpecs, paintCover } from '../components/coverArt.ts'
import { hexToRgb } from '../components/wallpaperScenes.ts'
import { getMessages, type Locale, type PlaygroundMessages } from '../i18n.ts'
import {
  COVER_WALL_BLEND_K,
  createCoverWallNodes,
  type GlobalGlassMaterial,
} from '../labDefaults.ts'

export interface CoverWallLabProps {
  theme: ThemeMode
  locale: Locale
  reducedMotion: boolean
  glass: GlobalGlassMaterial
  inspectorOpen: boolean
  showScenePanel: boolean
  panelHeaderSlot?: ReactNode
  onRenderModeChange: (mode: 'refract' | 'frosted') => void
}

type TierChoice = LegibilityTier | 'off'
type ForegroundChoice = 'auto' | ForegroundPolarity

const COVER_SPECS = createCoverSpecs(42, 0x5e551e)
const TIERS: readonly TierChoice[] = ['off', 'clear', 'regular', 'legible']
const INSPECTOR_WIDTH = 348
const STAGE_BOUNDS_PAD = 8
const DEFAULT_STAGE_SIZE: Size = { width: 1280, height: 800 }

/** The glass text and the `foreground` the engine protects come from this one table. */
const FOREGROUND_INK = {
  light: '#f7f9fc',
  dark: '#0e1116',
} as const satisfies Record<ForegroundPolarity, string>

/** The shelf owns its gutter color so probe background telemetry never lags a theme switch. */
const SHELF_GROUND = {
  light: '#efeee9',
  dark: '#0b0c10',
} as const satisfies Record<ThemeMode, string>

function solidTelemetry(hex: string): BackdropTelemetry {
  const [r, g, b] = hexToRgb(hex)
  return {
    lumaHigh: linearToSrgb(relativeLuminance(r, g, b)),
    lumaLow: srgbLuma(r, g, b),
    channelHigh: Math.max(r, g, b),
    channelLow: Math.min(r, g, b),
    chroma: Math.max(r, g, b) - Math.min(r, g, b),
    detail: 0,
  }
}

interface ReadoutSlot {
  /** Display quantum; text is rewritten only when the quantized value changes. */
  step: number
  read: (p: Readonly<LegibilityParams>) => number
  format: (v: number, p: Readonly<LegibilityParams>, t: PlaygroundMessages['coverWall']) => string
}

const READOUT_SLOTS = {
  film: { step: 0.01, read: (p) => p.veilRgba[3]!, format: (v) => v.toFixed(2) },
  blur: { step: 0.1, read: (p) => p.blurBoostPx, format: (v) => `+${v.toFixed(1)}px` },
  refraction: { step: 0.01, read: (p) => p.refractionScale, format: (v) => `×${v.toFixed(2)}` },
  saturation: { step: 0.01, read: (p) => p.saturationScale, format: (v) => `×${v.toFixed(2)}` },
  limit: {
    step: 0.01,
    read: (p) => (p.feasible ? p.backdropLimit : -1),
    format: (v, p, t) =>
      v < 0 ? t.infeasible : `${p.polarity === 'light' ? '≤' : '≥'} ${v.toFixed(2)}`,
  },
} as const satisfies Record<string, ReadoutSlot>

type ReadoutKey = keyof typeof READOUT_SLOTS
const READOUT_KEYS = Object.keys(READOUT_SLOTS) as ReadoutKey[]

export function CoverWallLab({
  theme,
  locale,
  reducedMotion,
  glass,
  inspectorOpen,
  showScenePanel,
  panelHeaderSlot,
  onRenderModeChange,
}: CoverWallLabProps): ReactElement {
  const t = getMessages(locale)
  const cw = t.coverWall

  const [tier, setTier] = useState<TierChoice>('regular')
  const [foregroundChoice, setForegroundChoice] = useState<ForegroundChoice>('auto')
  const polarity: ForegroundPolarity =
    foregroundChoice === 'auto' ? (theme === 'dark' ? 'light' : 'dark') : foregroundChoice
  const foreground = useMemo(() => hexToRgb(FOREGROUND_INK[polarity]), [polarity])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const wallRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  const [surfaceCtrl, setSurfaceCtrl] = useState<GlassSurfaceController | null>(null)
  const surfaceRef = useRef<GlassSurfaceController | null>(null)
  const ctrlRef = useRef<DragMergeController | null>(null)
  const loopRef = useRef<FrameLoop | null>(null)
  const stageSizeRef = useRef<Size>(DEFAULT_STAGE_SIZE)
  const configRef = useRef({ theme, glass, inspectorOpen, reducedMotion })
  const gridsRef = useRef(new Map<Element, BackdropTelemetryGrid>())
  const probe = useMemo<RegionProbe>(
    () => createRegionProbe({ background: solidTelemetry(SHELF_GROUND[theme]) }),
    [theme],
  )
  const readoutRefs = useRef<Record<ReadoutKey, HTMLElement | null>>({
    film: null,
    blur: null,
    refraction: null,
    saturation: null,
    limit: null,
  })

  const [initialPrimitives] = useState(() =>
    createCoverWallNodes(DEFAULT_STAGE_SIZE, INSPECTOR_WIDTH).map((n) => ({
      id: n.id,
      center: { ...n.center },
      size: { ...n.size },
      radius: n.radius,
    })),
  )

  const applyFrame = useCallback((state: DragMergeState) => {
    const { theme: activeTheme, glass: activeGlass } = configRef.current
    surfaceRef.current?.render({
      field: {
        primitives: state.field.primitives,
        blendK: COVER_WALL_BLEND_K,
        rimOpacity: state.field.rimOpacity,
        styleMix: activeGlass.styleMix,
      },
      material: activeGlass.material,
      refraction: activeGlass.refraction,
      theme: activeTheme,
    })
    for (const node of state.nodes) {
      const el = node.id === 'bar' ? barRef.current : dropRef.current
      if (!el) continue
      el.style.width = `${node.size.width}px`
      el.style.height = `${node.size.height}px`
      el.style.transform = `translate3d(${node.center.x - node.size.width * 0.5}px, ${node.center.y - node.size.height * 0.5}px, 0)`
      el.setAttribute('data-dragging', node.dragging ? 'true' : 'false')
    }
  }, [])

  const ensureLoop = useCallback(() => {
    const loop = loopRef.current
    if (loop && !loop.isRunning()) loop.start()
  }, [])

  const relayout = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || ctrl.getState().activeDragId) return
    const size = stageSizeRef.current
    ctrl.setBounds({
      x: STAGE_BOUNDS_PAD,
      y: STAGE_BOUNDS_PAD,
      width: Math.max(40, size.width - STAGE_BOUNDS_PAD * 2),
      height: Math.max(40, size.height - STAGE_BOUNDS_PAD * 2),
    })
    const inset = configRef.current.inspectorOpen ? INSPECTOR_WIDTH : 0
    // Layout changes snap; only user drags should animate.
    ctrl.setReducedMotion(true)
    for (const input of createCoverWallNodes(size, inset)) {
      ctrl.updateNode(input.id, {
        center: input.center,
        restCenter: input.center,
        size: input.size,
        radius: input.radius,
      })
    }
    ctrl.setReducedMotion(configRef.current.reducedMotion)
    applyFrame(ctrl.getState())
  }, [applyFrame])

  useLayoutEffect(() => {
    surfaceRef.current = surfaceCtrl
    configRef.current = { theme, glass, inspectorOpen, reducedMotion }
    if (ctrlRef.current && surfaceCtrl) applyFrame(ctrlRef.current.getState())
  })

  useLayoutEffect(() => {
    const wall = wallRef.current
    if (!wall) return
    const grids = gridsRef.current
    for (const canvas of wall.querySelectorAll<HTMLCanvasElement>('canvas[data-cover]')) {
      if (grids.has(canvas)) continue
      const spec = COVER_SPECS[Number(canvas.dataset.cover)]
      const ctx = canvas.getContext('2d')
      if (!spec || !ctx) continue
      const pixels = paintCover(spec, COVER_SIZE.width, COVER_SIZE.height)
      ctx.putImageData(new ImageData(pixels, COVER_SIZE.width, COVER_SIZE.height), 0, 0)
      grids.set(canvas, measureTelemetryGrid(pixels, COVER_SIZE.width, COVER_SIZE.height, 4, 6))
    }
  }, [])

  useEffect(() => {
    for (const [el, grid] of gridsRef.current) probe.set(el, grid)
    return () => probe.clear()
  }, [probe])

  useEffect(() => {
    if (!surfaceCtrl || tier === 'off') return
    surfaceCtrl.setLegibility(createGlassLegibility({ foreground, tier, probe }))
    return () => surfaceCtrl.setLegibility(null)
  }, [surfaceCtrl, probe, tier, foreground])

  useEffect(() => {
    const loop = createFrameLoop((dtSec) => {
      const ctrl = ctrlRef.current
      if (!ctrl) return false
      const next = ctrl.step(dtSec)
      applyFrame(next)
      return next.isAnimating || next.activeDragId !== null
    })
    loopRef.current = loop
    return () => {
      loop.stop()
      if (loopRef.current === loop) loopRef.current = null
    }
  }, [applyFrame])

  // Own controller creation and cleanup symmetrically in an effect for React StrictMode safety.
  useEffect(() => {
    const ctrl = createDragMergeController({
      nodes: createCoverWallNodes(stageSizeRef.current, configRef.current.inspectorOpen ? INSPECTOR_WIDTH : 0),
      blendK: COVER_WALL_BLEND_K,
      returnToRestOnRelease: true,
      reducedMotion: configRef.current.reducedMotion,
    })
    ctrlRef.current = ctrl
    relayout()
    return () => {
      if (ctrlRef.current === ctrl) ctrlRef.current = null
      ctrl.dispose()
    }
  }, [relayout])

  useEffect(() => {
    ctrlRef.current?.setReducedMotion(reducedMotion)
  }, [reducedMotion])

  useEffect(() => {
    relayout()
  }, [inspectorOpen, relayout])

  useEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    return observeElementResize(
      stageEl,
      (size) => {
        stageSizeRef.current = size
        relayout()
      },
      { emitInitial: true },
    )
  }, [relayout])

  useEffect(() => {
    const quantized = new Float64Array(READOUT_KEYS.length)
    const written: (HTMLElement | null)[] = READOUT_KEYS.map(() => null)
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const params = surfaceRef.current?.getLegibilityParams() ?? null
      for (let i = 0; i < READOUT_KEYS.length; i++) {
        const key = READOUT_KEYS[i]!
        const el = readoutRefs.current[key]
        if (!el) continue
        const slot: ReadoutSlot = READOUT_SLOTS[key]
        const q = params ? Math.round(slot.read(params) / slot.step) : Number.NaN
        if (written[i] === el && Object.is(quantized[i], q)) continue
        quantized[i] = q
        written[i] = el
        el.textContent = params ? slot.format(q * slot.step, params, cw) : cw.readoutOff
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cw, polarity])

  const toStagePoint = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY }
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.startDrag('drop', toStagePoint(e.clientX, e.clientY))) return
    e.currentTarget.setPointerCapture(e.pointerId)
    applyFrame(ctrl.getState())
    ensureLoop()
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.getState().activeDragId) return
    ctrl.moveDrag(toStagePoint(e.clientX, e.clientY))
    applyFrame(ctrl.getState())
    ensureLoop()
  }

  const handlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.getState().activeDragId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (e.type === 'pointercancel') ctrl.cancelDrag()
    else ctrl.endDrag()
    applyFrame(ctrl.getState())
    ensureLoop()
  }

  const ink = FOREGROUND_INK[polarity]
  const bindReadout = (key: ReadoutKey) => (el: HTMLElement | null) => {
    readoutRefs.current[key] = el
  }

  return (
    <>
      <div className="pg-stage" ref={stageRef} data-testid="cover-wall-stage">
        <div
          className="pg-cover-scroll"
          role="region"
          aria-label={cw.wallAriaLabel}
          tabIndex={0}
          style={{ background: SHELF_GROUND[theme] }}
        >
          <div className="pg-cover-grid" ref={wallRef}>
            {COVER_SPECS.map((spec, i) => (
              <canvas
                key={spec.id}
                className="pg-cover"
                data-cover={i}
                width={COVER_SIZE.width}
                height={COVER_SIZE.height}
                role="img"
                aria-label={`${spec.title} #${spec.issue}`}
              />
            ))}
          </div>
        </div>

        <GlassField
          className="pg-glass-stage"
          controllerRef={setSurfaceCtrl}
          mode={glass.renderMode}
          theme={theme}
          blendK={COVER_WALL_BLEND_K}
          styleMix={glass.styleMix}
          primitives={initialPrimitives}
          material={glass.material}
          refraction={glass.refraction}
        >
          <div ref={barRef} className="pg-cover-bar" style={{ color: ink }}>
            <span className="pg-cover-bar-title">{cw.barTitle}</span>
            <span className="pg-cover-bar-caption">{cw.barCaption}</span>
          </div>
          <div
            ref={dropRef}
            className="pg-cover-drop"
            style={{ color: ink }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            {cw.dropLabel}
          </div>
        </GlassField>
      </div>

      {showScenePanel ? (
        <ControlPanel
          title={cw.panelTitle}
          description={cw.panelDescription}
          headerSlot={panelHeaderSlot}
        >
          <ControlSection title={cw.sectionTier}>
            <SegmentedControl
              ariaLabel={cw.sectionTier}
              value={tier}
              columns={4}
              onChange={setTier}
              options={TIERS.map((id) => ({ value: id, label: cw.tiers[id] }))}
            />
          </ControlSection>

          <ControlSection title={cw.sectionRender}>
            <SegmentedControl<SurfaceRenderMode>
              ariaLabel={cw.sectionRender}
              value={glass.renderMode}
              onChange={(mode) => {
                if (mode === 'refract' || mode === 'frosted') onRenderModeChange(mode)
              }}
              options={[
                { value: 'refract', label: cw.renderModes.refract },
                { value: 'frosted', label: cw.renderModes.frosted },
              ]}
            />
          </ControlSection>

          <ControlSection title={cw.sectionForeground}>
            <SegmentedControl
              ariaLabel={cw.sectionForeground}
              value={foregroundChoice}
              onChange={setForegroundChoice}
              options={[
                { value: 'auto', label: cw.foregrounds.auto },
                { value: 'light', label: cw.foregrounds.light },
                { value: 'dark', label: cw.foregrounds.dark },
              ]}
            />
          </ControlSection>

          <TelemetryGrid>
            <TelemetryItem
              label={cw.statTarget}
              value={tier === 'off' ? cw.readoutOff : `${LEGIBILITY_POLICIES[tier].contrast}:1`}
            />
            <TelemetryItem label={cw.statFilm} value="–" valueRef={bindReadout('film')} />
            <TelemetryItem label={cw.statBlur} value="–" valueRef={bindReadout('blur')} />
            <TelemetryItem label={cw.statRefraction} value="–" valueRef={bindReadout('refraction')} />
            <TelemetryItem label={cw.statSaturation} value="–" valueRef={bindReadout('saturation')} />
            <TelemetryItem label={cw.statLimit} value="–" valueRef={bindReadout('limit')} />
          </TelemetryGrid>
        </ControlPanel>
      ) : null}
    </>
  )
}
