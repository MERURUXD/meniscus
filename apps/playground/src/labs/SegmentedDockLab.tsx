import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import type { GlassFieldState, ThemeMode } from '@meniscus/core'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type FrameLoop,
  type SurfaceRenderMode,
} from '@meniscus/dom'
import { GlassField, useElasticPress } from '@meniscus/react'
import {
  SEGMENTED_PILL_DEFAULTS,
  createSegmentedPillController,
  type SegmentItem,
  type SegmentedPillController,
  type SegmentedPillState,
} from '@meniscus/presets'
import { ControlPanel, SliderControl } from '../components/ControlPanel.tsx'
import { TestChart } from '../components/TestChart.tsx'
import { getMessages, type Locale } from '../i18n.ts'
import { DOCK_SEGMENTS, SHOWCASE_MATERIALS, type DockSegmentMeta } from '../labDefaults.ts'

export interface SegmentedDockLabProps {
  theme: ThemeMode
  locale: Locale
  reducedMotion: boolean
  renderMode: SurfaceRenderMode
}

interface DockButtonProps {
  item: DockSegmentMeta
  label: string
  active: boolean
  reducedMotion: boolean
  registerButton: (id: string, el: HTMLButtonElement | null) => void
  onSelect: (id: string) => void
}

function DockButton({
  item,
  label,
  active,
  reducedMotion,
  registerButton,
  onSelect,
}: DockButtonProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  useElasticPress(buttonRef, {
    reducedMotion,
    intensity: 0.75,
  })

  return (
    <button
      ref={(el) => {
        buttonRef.current = el
        registerButton(item.id, el)
      }}
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active ? 'true' : 'false'}
      className="pg-dock-item"
      onClick={() => onSelect(item.id)}
    >
      <span>{label}</span>
      {item.badge ? <span className="pg-dock-badge">{item.badge}</span> : null}
    </button>
  )
}

interface DockTelemetry {
  activeId: string
  primitiveCount: number
  stretchRatio: number
  isAnimating: boolean
}

function makeFallbackSegments(): SegmentItem[] {
  return DOCK_SEGMENTS.map((seg, idx) => ({
    id: seg.id,
    rect: { x: 8 + idx * 96, y: 8, width: 90, height: 38 },
    radius: 18,
  }))
}

export function SegmentedDockLab({
  theme,
  locale,
  reducedMotion,
  renderMode,
}: SegmentedDockLabProps): ReactElement {
  const t = getMessages(locale)
  const sd = t.segmentedDock

  const [activeId, setActiveId] = useState<string>(DOCK_SEGMENTS[0]!.id)
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal')
  const [blendK, setBlendK] = useState<number>(SEGMENTED_PILL_DEFAULTS.blendK)
  const [maxStretchPx, setMaxStretchPx] = useState<number>(
    SEGMENTED_PILL_DEFAULTS.maxStretchPx,
  )
  const [squeezeRatio, setSqueezeRatio] = useState<number>(
    SEGMENTED_PILL_DEFAULTS.squeezeRatio,
  )

  const [dockContainerEl, setDockContainerEl] = useState<HTMLDivElement | null>(null)
  const dockContainerRef = useRef<HTMLDivElement | null>(null)
  const [surfaceCtrl, setSurfaceCtrl] = useState<GlassSurfaceController | null>(null)
  const surfaceRef = useRef<GlassSurfaceController | null>(null)
  const buttonMapRef = useRef(new Map<string, HTMLButtonElement>())
  const loopRef = useRef<FrameLoop | null>(null)
  const ctrlRef = useRef<SegmentedPillController | null>(null)
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTelemetryAtRef = useRef(0)
  const hasMeasuredRef = useRef(false)
  const measuredSegmentsRef = useRef<SegmentItem[] | null>(null)
  const activeIdRef = useRef(activeId)
  const reducedMotionRef = useRef(reducedMotion)

  const [initialField] = useState<GlassFieldState>(() => {
    const first = makeFallbackSegments()[0]!
    return {
      primitives: [
        {
          id: first.id,
          center: {
            x: first.rect.x + first.rect.width * 0.5,
            y: first.rect.y + first.rect.height * 0.5,
          },
          size: { width: first.rect.width, height: first.rect.height },
          radius: first.radius ?? 18,
        },
      ],
      blendK: 0,
    }
  })

  const [telemetry, setTelemetry] = useState<DockTelemetry>({
    activeId: DOCK_SEGMENTS[0]!.id,
    primitiveCount: 1,
    stretchRatio: 0,
    isAnimating: false,
  })
  const configRef = useRef({ theme })

  const registerButton = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      buttonMapRef.current.set(id, el)
    } else {
      buttonMapRef.current.delete(id)
    }
  }, [])

  const applyFrame = useCallback((state: SegmentedPillState, forceTelemetry = false) => {
    const surface = surfaceRef.current
    const activeTheme = configRef.current.theme
    if (surface) {
      surface.render({
        field: state.field,
        material: SHOWCASE_MATERIALS[activeTheme],
        theme: activeTheme,
      })
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (forceTelemetry || now - lastTelemetryAtRef.current >= 70 || !state.isAnimating) {
      lastTelemetryAtRef.current = now
      const nextTel: DockTelemetry = {
        activeId: state.activeId ?? DOCK_SEGMENTS[0]!.id,
        primitiveCount: state.field.primitives.length,
        stretchRatio: Math.round(state.stretchRatio * 100) / 100,
        isAnimating: state.isAnimating,
      }
      setTelemetry((prev) =>
        prev.activeId === nextTel.activeId &&
        prev.primitiveCount === nextTel.primitiveCount &&
        prev.stretchRatio === nextTel.stretchRatio &&
        prev.isAnimating === nextTel.isAnimating
          ? prev
          : nextTel,
      )
    }
  }, [])

  const ensureLoop = useCallback(() => {
    const loop = loopRef.current
    if (loop && !loop.isRunning()) {
      loop.start()
    }
  }, [])

  const measureSegments = useCallback(() => {
    const ctrl = ctrlRef.current
    const container = dockContainerRef.current
    if (!ctrl || !container) return
    const cRect = container.getBoundingClientRect()
    const originX = cRect.left + (container.clientLeft || 0)
    const originY = cRect.top + (container.clientTop || 0)

    const items: SegmentItem[] = []
    for (const seg of DOCK_SEGMENTS) {
      const btn = buttonMapRef.current.get(seg.id)
      if (!btn) continue
      const bRect = btn.getBoundingClientRect()
      items.push({
        id: seg.id,
        rect: {
          x: bRect.left - originX,
          y: bRect.top - originY,
          width: bRect.width,
          height: bRect.height,
        },
        radius: bRect.height * 0.5,
      })
    }

    if (items.length > 0) {
      measuredSegmentsRef.current = items
      ctrl.setSegments(items)
      if (!hasMeasuredRef.current) {
        hasMeasuredRef.current = true
        ctrl.snapTo(activeIdRef.current)
      } else if (ctrl.getState().isAnimating) {
        ensureLoop()
      }
      applyFrame(ctrl.getState(), true)
    }
  }, [applyFrame, ensureLoop])

  useLayoutEffect(() => {
    dockContainerRef.current = dockContainerEl
    surfaceRef.current = surfaceCtrl
    configRef.current = { theme }
    activeIdRef.current = activeId
    reducedMotionRef.current = reducedMotion
    if (ctrlRef.current && surfaceCtrl) {
      applyFrame(ctrlRef.current.getState(), true)
    }
  })

  useLayoutEffect(() => {
    if (surfaceCtrl) {
      measureSegments()
    }
  }, [surfaceCtrl, orientation, locale, measureSegments])

  useEffect(() => {
    const loop = createFrameLoop((dtSec) => {
      const ctrl = ctrlRef.current
      if (!ctrl) return false
      const next = ctrl.step(dtSec)
      applyFrame(next, !next.isAnimating)
      return next.isAnimating
    })
    loopRef.current = loop
    return () => {
      loop.stop()
      if (loopRef.current === loop) {
        loopRef.current = null
      }
      if (jumpTimerRef.current !== null) {
        clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = null
      }
    }
  }, [applyFrame])

  useEffect(() => {
    if (!dockContainerEl) return
    return observeElementResize(dockContainerEl, () => {
      measureSegments()
    })
  }, [dockContainerEl, measureSegments])

  // Create and dispose SegmentedPillController symmetrically inside effect for StrictMode safety.
  useEffect(() => {
    const ctrl = createSegmentedPillController({
      segments: measuredSegmentsRef.current ?? makeFallbackSegments(),
      initialActiveId: activeIdRef.current,
      blendK,
      maxStretchPx,
      squeezeRatio,
      reducedMotion: reducedMotionRef.current,
    })
    ctrlRef.current = ctrl
    measureSegments()

    return () => {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
      }
      ctrl.dispose()
    }
  }, [blendK, maxStretchPx, squeezeRatio, measureSegments])

  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.setReducedMotion(reducedMotion)
    applyFrame(ctrl.getState(), true)
  }, [reducedMotion, applyFrame])

  const selectSegment = (id: string) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    setActiveId(id)
    activeIdRef.current = id
    ctrl.setActive(id)
    applyFrame(ctrl.getState(), true)
    ensureLoop()
  }

  const handleStressRetarget = () => {
    if (jumpTimerRef.current !== null) {
      clearTimeout(jumpTimerRef.current)
    }
    const firstId = DOCK_SEGMENTS[0]!.id
    const lastId = DOCK_SEGMENTS[DOCK_SEGMENTS.length - 1]!.id
    const midId = DOCK_SEGMENTS[2]!.id
    const initialTarget = activeId === lastId ? firstId : lastId
    selectSegment(initialTarget)
    jumpTimerRef.current = setTimeout(() => {
      jumpTimerRef.current = null
      selectSegment(midId)
    }, 115)
  }

  const activeSegmentLabel =
    sd.segments[telemetry.activeId as keyof typeof sd.segments] ?? telemetry.activeId

  return (
    <>
      <div className="pg-stage" data-testid="segmented-dock-stage">
        <TestChart
          title={sd.backdropTitle}
          caption={sd.backdropCaption}
          messages={t.chart}
        />

        <div className="pg-dock-wrap">
          <GlassField
            className="pg-dock-field"
            containerRef={setDockContainerEl}
            controllerRef={setSurfaceCtrl}
            mode={renderMode}
            theme={theme}
            blendK={initialField.blendK}
            primitives={initialField.primitives}
            material={SHOWCASE_MATERIALS[theme]}
          >
            <div
              className="pg-dock-items"
              role="tablist"
              aria-label={sd.dockAriaLabel}
              data-orientation={orientation}
            >
              {DOCK_SEGMENTS.map((item) => (
                <DockButton
                  key={item.id}
                  item={item}
                  label={sd.segments[item.id as keyof typeof sd.segments] ?? item.label}
                  active={activeId === item.id}
                  reducedMotion={reducedMotion}
                  registerButton={registerButton}
                  onSelect={selectSegment}
                />
              ))}
            </div>
          </GlassField>
        </div>
      </div>

      <ControlPanel title={sd.panelTitle} description={sd.panelDescription}>
        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={orientation === 'horizontal'}
            onClick={() => setOrientation('horizontal')}
          >
            {sd.horizontal}
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={orientation === 'vertical'}
            onClick={() => setOrientation('vertical')}
          >
            {sd.vertical}
          </button>
        </div>

        <SliderControl
          id="dock-blend-k"
          label={sd.blendKLabel}
          value={blendK}
          min={0}
          max={36}
          unit="px"
          onChange={setBlendK}
        />
        <SliderControl
          id="dock-max-stretch"
          label={sd.maxStretchLabel}
          value={maxStretchPx}
          min={0}
          max={42}
          unit="px"
          onChange={setMaxStretchPx}
        />
        <SliderControl
          id="dock-squeeze"
          label={sd.squeezeLabel}
          value={squeezeRatio}
          min={0}
          max={0.3}
          step={0.02}
          precision={2}
          onChange={setSqueezeRatio}
        />

        <div className="pg-btn-group">
          <button type="button" className="pg-btn" onClick={handleStressRetarget}>
            {sd.retargetButton}
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">{sd.statActiveTab}</div>
            <div className="pg-stat-value">{activeSegmentLabel}</div>
          </div>
          <div>
            <div className="pg-stat-label">{sd.statLobes}</div>
            <div className="pg-stat-value">{telemetry.primitiveCount}</div>
          </div>
          <div>
            <div className="pg-stat-label">{sd.statStretch}</div>
            <div className="pg-stat-value">{telemetry.stretchRatio.toFixed(2)}</div>
          </div>
          <div>
            <div className="pg-stat-label">{sd.statMotion}</div>
            <div className="pg-stat-value">
              {telemetry.isAnimating ? sd.motionFlowing : sd.motionSettled}
            </div>
          </div>
        </div>
      </ControlPanel>
    </>
  )
}
