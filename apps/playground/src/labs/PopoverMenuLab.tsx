import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import {
  DEFAULT_OPTICAL_MATERIALS,
  type Rect,
  type Size,
  type ThemeMode,
} from '@meniscus/core'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type FrameLoop,
  type SurfaceRenderMode,
} from '@meniscus/dom'
import { GlassField, useElasticPress } from '@meniscus/react'
import {
  POPOVER_MORPH_DEFAULTS,
  createPopoverMorphController,
  createPopoverMorphSnapshot,
  type PopoverAnchorConfig,
  type PopoverMorphController,
  type PopoverPanelConfig,
  type PopoverPlacement,
} from '@meniscus/presets'
import { ControlPanel } from '../components/ControlPanel.tsx'
import { LiveBackdrop } from '../components/LiveBackdrop.tsx'
import { POPOVER_ANCHOR_PLACEMENTS, POPOVER_MENU_ITEMS } from '../labDefaults.ts'

export interface PopoverMenuLabProps {
  theme: ThemeMode
  reducedMotion: boolean
  renderMode: SurfaceRenderMode
}

const DEFAULT_STAGE_SIZE: Size = { width: 760, height: 520 }
const PANEL_SIZE: Size = { width: 244, height: 184 }

function computeAnchoredTriggerRect(stageSize: Size, placement: PopoverPlacement): Rect {
  const w = Math.max(280, stageSize.width)
  const h = Math.max(320, stageSize.height)
  const width = 136
  const height = 42

  switch (placement) {
    case 'overAnchorEnd':
      return { x: Math.max(20, w - width - 36), y: 68, width, height }
    case 'overAnchorStart':
      return { x: 28, y: 68, width, height }
    case 'belowPoint':
      return { x: (w - width) * 0.5, y: 74, width, height }
    case 'abovePoint':
      return { x: (w - width) * 0.5, y: h - height - 72, width, height }
  }
}

export function PopoverMenuLab({
  theme,
  reducedMotion,
  renderMode,
}: PopoverMenuLabProps): ReactElement {
  const [placement, setPlacement] = useState<PopoverPlacement>('overAnchorEnd')
  const [externalTrigger, setExternalTrigger] = useState(false)
  const [bareSource, setBareSource] = useState(false)
  const [activeSourceKind, setActiveSourceKind] = useState<'anchored' | 'point'>('anchored')
  const [pointRect, setPointRect] = useState<Rect>({ x: 180, y: 240, width: 2, height: 2 })
  const [stageSize, setStageSize] = useState<Size>(DEFAULT_STAGE_SIZE)
  const [phaseLabel, setPhaseLabel] = useState<string>('closed')
  const [lastAction, setLastAction] = useState<string>('None')

  const stageRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<GlassSurfaceController | null>(null)
  const triggerBtnRef = useRef<HTMLButtonElement | null>(null)
  const triggerGlyphRef = useRef<HTMLSpanElement | null>(null)
  const panelClipRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const loopRef = useRef<FrameLoop | null>(null)
  const ctrlRef = useRef<PopoverMorphController | null>(null)
  const interruptTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const reducedMotionRef = useRef(reducedMotion)

  const triggerRect = useMemo(
    () => computeAnchoredTriggerRect(stageSize, placement),
    [stageSize, placement],
  )

  const buildConfigs = useCallback(
    (
      sourceKind: 'anchored' | 'point',
      currentStageSize: Size,
      currentPlacement: PopoverPlacement,
      currentExternal: boolean,
      currentBare: boolean,
      currentPoint: Rect,
    ): { anchor: PopoverAnchorConfig; panel: PopoverPanelConfig } => {
      if (sourceKind === 'point') {
        return {
          anchor: {
            anchorRect: currentPoint,
            placement: 'belowPoint',
            bareSource: true,
            externalTrigger: false,
            viewportSize: currentStageSize,
          },
          panel: {
            size: PANEL_SIZE,
            restingRadius: POPOVER_MORPH_DEFAULTS.restingRadius,
            screenMargin: POPOVER_MORPH_DEFAULTS.screenMargin,
            blendK: POPOVER_MORPH_DEFAULTS.dropletBlendK,
          },
        }
      }

      const rect = computeAnchoredTriggerRect(currentStageSize, currentPlacement)
      return {
        anchor: {
          anchorRect: rect,
          placement: currentPlacement,
          bareSource: currentBare,
          externalTrigger: currentExternal,
          viewportSize: currentStageSize,
        },
        panel: {
          size: PANEL_SIZE,
          restingRadius: POPOVER_MORPH_DEFAULTS.restingRadius,
          screenMargin: POPOVER_MORPH_DEFAULTS.screenMargin,
          blendK: POPOVER_MORPH_DEFAULTS.dropletBlendK,
        },
      }
    },
    [],
  )

  const latestRef = useRef({
    theme,
    activeSourceKind,
    stageSize,
    placement,
    externalTrigger,
    bareSource,
    pointRect,
  })

  const syncDom = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const l = latestRef.current
    const { anchor, panel } = buildConfigs(
      l.activeSourceKind,
      l.stageSize,
      l.placement,
      l.externalTrigger,
      l.bareSource,
      l.pointRect,
    )
    const motion = ctrl.getState()
    const geom = ctrl.evaluateGeometry(anchor, panel)

    setPhaseLabel((prev) => (prev === motion.phase ? prev : motion.phase))

    const opacity =
      l.activeSourceKind === 'point'
        ? motion.phase === 'closed'
          ? 0
          : motion.bareGlassOpacity
        : l.bareSource
          ? motion.bareGlassOpacity
          : 1

    const surface = surfaceRef.current
    if (surface) {
      if (opacity <= 0.005) {
        surface.clear()
      } else {
        surface.render({
          field: geom.field,
          material: DEFAULT_OPTICAL_MATERIALS[l.theme].crisp,
          theme: l.theme,
          opacity,
          blurBumpPx: motion.blurBumpPx,
        })
      }
    }

    const trigRect = computeAnchoredTriggerRect(l.stageSize, l.placement)
    const btnEl = triggerBtnRef.current
    if (btnEl) {
      if (motion.phase === 'closed') {
        btnEl.removeAttribute('data-meniscus-morphing')
      } else {
        btnEl.setAttribute('data-meniscus-morphing', 'true')
      }
      const triggerInteractive =
        motion.phase === 'closed' ||
        (l.externalTrigger && l.activeSourceKind === 'anchored')
      btnEl.style.pointerEvents = triggerInteractive ? 'auto' : 'none'
    }

    const glyphEl = triggerGlyphRef.current
    if (glyphEl) {
      if (l.activeSourceKind === 'anchored') {
        const dx = geom.glyphTransform.centerX - (trigRect.x + trigRect.width * 0.5)
        const dy = geom.glyphTransform.centerY - (trigRect.y + trigRect.height * 0.5)
        glyphEl.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${geom.glyphTransform.scale})`
        glyphEl.style.opacity = String(motion.triggerGlyphOpacity)
        glyphEl.style.filter =
          motion.triggerGlyphBlurPx > 0.05 ? `blur(${motion.triggerGlyphBlurPx}px)` : 'none'
      } else {
        glyphEl.style.transform = 'translate3d(0px, 0px, 0) scale(1)'
        glyphEl.style.opacity = '1'
        glyphEl.style.filter = 'none'
      }
    }

    const clipEl = panelClipRef.current
    const panelEl = panelRef.current
    if (clipEl && panelEl) {
      const visible = motion.phase !== 'closed' && motion.contentOpacity > 0.005
      panelEl.style.left = `${geom.targetRect.x}px`
      panelEl.style.top = `${geom.targetRect.y}px`
      panelEl.style.width = `${geom.targetRect.width}px`
      panelEl.style.minHeight = `${geom.targetRect.height}px`
      panelEl.style.transform = `translate3d(${geom.contentTransform.translateX}px, ${geom.contentTransform.translateY}px, 0) scale(${geom.contentTransform.scale})`
      panelEl.style.opacity = String(visible ? motion.contentOpacity : 0)
      panelEl.style.filter =
        motion.contentBlurPx > 0.05 ? `blur(${motion.contentBlurPx}px)` : 'none'
      panelEl.style.pointerEvents =
        motion.phase === 'open' || motion.phase === 'opening' ? 'auto' : 'none'
      panelEl.style.visibility = visible ? 'visible' : 'hidden'

      const rInset = Math.max(0, l.stageSize.width - geom.contentTransform.clipRight)
      const bInset = Math.max(0, l.stageSize.height - geom.contentTransform.clipBottom)
      clipEl.style.clipPath = `inset(${geom.contentTransform.clipTop}px ${rInset}px ${bInset}px ${geom.contentTransform.clipLeft}px round ${geom.contentTransform.clipRadius}px)`
    }
  }, [buildConfigs])

  useLayoutEffect(() => {
    reducedMotionRef.current = reducedMotion
    latestRef.current = {
      theme,
      activeSourceKind,
      stageSize,
      placement,
      externalTrigger,
      bareSource,
      pointRect,
    }
    syncDom()
  })

  const ensureLoop = useCallback(() => {
    const loop = loopRef.current
    if (loop && !loop.isRunning()) {
      loop.start()
    }
  }, [])

  useElasticPress(triggerBtnRef, {
    reducedMotion,
    enabled: phaseLabel === 'closed',
  })

  // Instantiate and dispose controller symmetrically inside effect for StrictMode safety.
  useEffect(() => {
    const ctrl = createPopoverMorphController({
      reducedMotion: reducedMotionRef.current,
    })
    ctrlRef.current = ctrl
    const loop = createFrameLoop((dtSec) => {
      const next = ctrl.step(dtSec)
      syncDom()
      return next.isAnimating
    })
    loopRef.current = loop
    syncDom()

    const timers = interruptTimersRef.current
    return () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.length = 0
      loop.stop()
      if (loopRef.current === loop) {
        loopRef.current = null
      }
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
      }
      ctrl.dispose()
    }
  }, [syncDom])

  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.setReducedMotion(reducedMotion)
    syncDom()
  }, [reducedMotion, syncDom])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    return observeElementResize(
      el,
      (size) => {
        if (size.width > 0 && size.height > 0) {
          setStageSize(size)
        }
      },
      { emitInitial: true },
    )
  }, [])

  const closeCurrentMenu = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const l = latestRef.current
    const state = ctrl.getState()
    if (state.phase === 'closed' || state.phase === 'closing') return
    const { anchor, panel } = buildConfigs(
      l.activeSourceKind,
      l.stageSize,
      l.placement,
      l.externalTrigger,
      l.bareSource,
      l.pointRect,
    )
    const snap = createPopoverMorphSnapshot(ctrl.evaluateGeometry(anchor, panel), state)
    ctrl.close(snap)
    syncDom()
    ensureLoop()
  }, [buildConfigs, syncDom, ensureLoop])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeCurrentMenu()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeCurrentMenu])

  const openAnchoredMenu = () => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const state = ctrl.getState()
    if (state.phase === 'open' || state.phase === 'opening') {
      closeCurrentMenu()
      return
    }
    setActiveSourceKind('anchored')
    latestRef.current = { ...latestRef.current, activeSourceKind: 'anchored' }
    ctrl.open(true)
    syncDom()
    ensureLoop()
  }

  const openContextMenuAt = (x: number, y: number) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const nextPoint: Rect = { x, y, width: 2, height: 2 }
    setPointRect(nextPoint)
    setActiveSourceKind('point')
    latestRef.current = {
      ...latestRef.current,
      activeSourceKind: 'point',
      pointRect: nextPoint,
    }
    ctrl.open(false)
    syncDom()
    ensureLoop()
  }

  const handleStageContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const stageEl = stageRef.current
    if (!stageEl) return
    const rect = stageEl.getBoundingClientRect()
    openContextMenuAt(e.clientX - rect.left, e.clientY - rect.top)
  }

  const handleStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const phase = ctrl.getState().phase
    if (phase !== 'open' && phase !== 'opening') return
    const target = e.target as Node | null
    if (panelRef.current?.contains(target) || triggerBtnRef.current?.contains(target)) {
      return
    }
    closeCurrentMenu()
  }

  const handleRunInterruptSequence = () => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    for (const t of interruptTimersRef.current) clearTimeout(t)
    interruptTimersRef.current = []

    setActiveSourceKind('anchored')
    latestRef.current = { ...latestRef.current, activeSourceKind: 'anchored' }
    ctrl.reset('closed')
    ctrl.open(true)
    syncDom()
    ensureLoop()

    interruptTimersRef.current.push(
      setTimeout(() => {
        closeCurrentMenu()
      }, 130),
      setTimeout(() => {
        const activeCtrl = ctrlRef.current
        if (!activeCtrl) return
        activeCtrl.open(true)
        syncDom()
        ensureLoop()
      }, 280),
    )
  }

  const restingPrimitives = [
    {
      id: 'droplet',
      center: {
        x: triggerRect.x + triggerRect.width * 0.5,
        y: triggerRect.y + triggerRect.height * 0.5,
      },
      size: { width: triggerRect.width, height: triggerRect.height },
      radius: triggerRect.height * 0.5,
    },
  ]

  return (
    <div className="pg-lab-grid">
      <div
        className="pg-stage"
        ref={stageRef}
        data-testid="popover-menu-stage"
        onContextMenu={handleStageContextMenu}
        onClick={handleStageClick}
      >
        <LiveBackdrop
          title="Production Popover & Context Menu"
          caption="Click Actions to expand the anchored liquid popover, or right-click anywhere inside the stage for a point context menu."
        />

        <GlassField
          className="pg-glass-stage"
          controllerRef={surfaceRef}
          mode={renderMode}
          theme={theme}
          blendK={POPOVER_MORPH_DEFAULTS.dropletBlendK}
          primitives={restingPrimitives}
          opacity={activeSourceKind === 'point' || bareSource ? 0 : 1}
          material={DEFAULT_OPTICAL_MATERIALS[theme].crisp}
        >
          <button
            ref={triggerBtnRef}
            type="button"
            className="pg-popover-trigger"
            style={{
              left: `${triggerRect.x}px`,
              top: `${triggerRect.y}px`,
              width: `${triggerRect.width}px`,
              height: `${triggerRect.height}px`,
              pointerEvents: 'auto',
            }}
            aria-expanded={phaseLabel === 'open' || phaseLabel === 'opening'}
            onClick={openAnchoredMenu}
          >
            <span
              ref={triggerGlyphRef}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                willChange: 'transform, opacity',
              }}
            >
              Actions ▾
            </span>
          </button>

          <div
            ref={panelClipRef}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 4,
              pointerEvents: 'none',
            }}
          >
            <div
              ref={panelRef}
              className="pg-popover-panel"
              role="menu"
              aria-label="Morphing popover actions"
            >
              {POPOVER_MENU_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="pg-menu-item"
                  onClick={() => {
                    setLastAction(item.label)
                    closeCurrentMenu()
                  }}
                >
                  <span>{item.label}</span>
                  <span className="pg-menu-shortcut">{item.shortcut}</span>
                </button>
              ))}
            </div>
          </div>
        </GlassField>

        <div className="pg-context-hint">
          <span>Right-click stage or spawn at point:</span>
          <button
            type="button"
            className="pg-btn"
            onClick={(e) => {
              e.stopPropagation()
              openContextMenuAt(stageSize.width * 0.32, stageSize.height * 0.45)
            }}
          >
            Context Menu Here
          </button>
        </div>
      </div>

      <ControlPanel
        title="Popover & Menu Options"
        description="Test anchor placements, bare/external triggers, point clamping, and rapid mid-flight reversals."
      >
        <div className="pg-btn-group">
          {POPOVER_ANCHOR_PLACEMENTS.map((p) => (
            <button
              key={p}
              type="button"
              className="pg-btn"
              aria-pressed={placement === p}
              onClick={() => {
                setPlacement(p)
                setExternalTrigger(p === 'belowPoint' || p === 'abovePoint')
              }}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={externalTrigger}
            onClick={() => setExternalTrigger((v) => !v)}
          >
            External Trigger
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={bareSource}
            onClick={() => setBareSource((v) => !v)}
          >
            Bare Source
          </button>
        </div>

        <div className="pg-btn-group">
          <button type="button" className="pg-btn" onClick={handleRunInterruptSequence}>
            Interrupt Reversal Demo
          </button>
          <button type="button" className="pg-btn" onClick={closeCurrentMenu}>
            Close Menu
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">Phase</div>
            <div className="pg-stat-value">{phaseLabel}</div>
          </div>
          <div>
            <div className="pg-stat-label">Source Mode</div>
            <div className="pg-stat-value">{activeSourceKind}</div>
          </div>
          <div>
            <div className="pg-stat-label">Last Action</div>
            <div className="pg-stat-value">{lastAction}</div>
          </div>
          <div>
            <div className="pg-stat-label">Reduced Motion</div>
            <div className="pg-stat-value">{reducedMotion ? 'Crossfade' : 'Spring'}</div>
          </div>
        </div>
      </ControlPanel>
    </div>
  )
}
