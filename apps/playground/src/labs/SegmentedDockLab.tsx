import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { DEFAULT_OPTICAL_MATERIALS, type GlassFieldState, type ThemeMode } from '@meniscus/core'
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
import { LiveBackdrop } from '../components/LiveBackdrop.tsx'
import { DOCK_SEGMENTS, type DockSegmentMeta } from '../labDefaults.ts'

export interface SegmentedDockLabProps {
  theme: ThemeMode
  reducedMotion: boolean
  renderMode: SurfaceRenderMode
}

interface DockButtonProps {
  item: DockSegmentMeta
  active: boolean
  reducedMotion: boolean
  registerButton: (id: string, el: HTMLButtonElement | null) => void
  onSelect: (id: string) => void
}

function DockButton({
  item,
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
      <span>{item.label}</span>
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
  reducedMotion,
  renderMode,
}: SegmentedDockLabProps): ReactElement {
  const [activeId, setActiveId] = useState<string>(DOCK_SEGMENTS[0]!.id)
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal')
  const [blendK, setBlendK] = useState<number>(SEGMENTED_PILL_DEFAULTS.blendK)
  const [maxStretchPx, setMaxStretchPx] = useState<number>(
    SEGMENTED_PILL_DEFAULTS.maxStretchPx,
  )
  const [squeezeRatio, setSqueezeRatio] = useState<number>(
    SEGMENTED_PILL_DEFAULTS.squeezeRatio,
  )

  const dockContainerRef = useRef<HTMLDivElement | null>(null)
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
        material: DEFAULT_OPTICAL_MATERIALS[activeTheme].crisp,
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
        radius: 18,
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
    configRef.current = { theme }
    activeIdRef.current = activeId
    reducedMotionRef.current = reducedMotion
    if (ctrlRef.current) {
      applyFrame(ctrlRef.current.getState(), true)
    }
  })

  useLayoutEffect(() => {
    measureSegments()
  }, [orientation, measureSegments])

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
    const el = dockContainerRef.current
    if (!el) return
    return observeElementResize(el, () => {
      measureSegments()
    })
  }, [measureSegments])

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

  return (
    <div className="pg-lab-grid">
      <div className="pg-stage" data-testid="segmented-dock-stage">
        <LiveBackdrop
          title="Continuous Morphing Dock"
          caption="Spring-led trailing and leading lobes elongate along travel and collapse cleanly to a crisp single capsule at rest."
        />

        <div className="pg-dock-wrap">
          <GlassField
            className="pg-dock-field"
            containerRef={dockContainerRef}
            controllerRef={surfaceRef}
            mode={renderMode}
            theme={theme}
            blendK={initialField.blendK}
            primitives={initialField.primitives}
            material={DEFAULT_OPTICAL_MATERIALS[theme].crisp}
          >
            <div
              className="pg-dock-items"
              role="tablist"
              aria-label="Morphing navigation dock"
              data-orientation={orientation}
            >
              {DOCK_SEGMENTS.map((item) => (
                <DockButton
                  key={item.id}
                  item={item}
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

      <ControlPanel
        title="Segmented Flow Parameters"
        description="Lead/trail differential springs stretch the liquid indicator into two blended primitives only while in motion."
      >
        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={orientation === 'horizontal'}
            onClick={() => setOrientation('horizontal')}
          >
            Horizontal
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={orientation === 'vertical'}
            onClick={() => setOrientation('vertical')}
          >
            Vertical
          </button>
        </div>

        <SliderControl
          id="dock-blend-k"
          label="Bridge Blend (blendK)"
          value={blendK}
          min={0}
          max={36}
          unit="px"
          onChange={setBlendK}
        />
        <SliderControl
          id="dock-max-stretch"
          label="Max Separation Clamp"
          value={maxStretchPx}
          min={0}
          max={42}
          unit="px"
          onChange={setMaxStretchPx}
        />
        <SliderControl
          id="dock-squeeze"
          label="Cross-Axis Squeeze"
          value={squeezeRatio}
          min={0}
          max={0.3}
          step={0.02}
          precision={2}
          onChange={setSqueezeRatio}
        />

        <div className="pg-btn-group">
          <button type="button" className="pg-btn" onClick={handleStressRetarget}>
            Mid-Flight Retarget
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">Active Tab</div>
            <div className="pg-stat-value">{telemetry.activeId}</div>
          </div>
          <div>
            <div className="pg-stat-label">Lobes Active</div>
            <div className="pg-stat-value">{telemetry.primitiveCount}</div>
          </div>
          <div>
            <div className="pg-stat-label">Stretch Ratio</div>
            <div className="pg-stat-value">{telemetry.stretchRatio.toFixed(2)}</div>
          </div>
          <div>
            <div className="pg-stat-label">Motion</div>
            <div className="pg-stat-value">{telemetry.isAnimating ? 'Flowing' : 'Settled'}</div>
          </div>
        </div>
      </ControlPanel>
    </div>
  )
}
