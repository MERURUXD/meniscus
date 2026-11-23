import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import {
  DEFAULT_OPTICAL_MATERIALS,
  MAX_GPU_PRIMITIVES,
  type GlassFieldState,
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
import { GlassField } from '@meniscus/react'
import {
  DRAG_MERGE_DEFAULTS,
  createDragMergeController,
  type DragMergeController,
  type DragMergeNodeInput,
  type DragMergeState,
} from '@meniscus/presets'
import { ControlPanel, SliderControl } from '../components/ControlPanel.tsx'
import { LiveBackdrop } from '../components/LiveBackdrop.tsx'
import {
  INITIAL_DRAG_NODE_META,
  createExtraDropletInput,
  createInitialDragMergeNodes,
  type DragNodeMeta,
} from '../labDefaults.ts'

export interface DragMergeLabProps {
  theme: ThemeMode
  reducedMotion: boolean
  renderMode: SurfaceRenderMode
}

interface TelemetrySnapshot {
  mergedCount: number
  strongestPair: string
  strongestGap: string
  activeCount: number
}

const DEFAULT_STAGE_SIZE: Size = { width: 760, height: 520 }
const STAGE_BOUNDS_PAD = 8

function snapshotNodeInputs(controller: DragMergeController): DragMergeNodeInput[] {
  return controller.getState().nodes.map((node) => ({
    id: node.id,
    center: { ...node.center },
    restCenter: { ...node.restCenter },
    size: { ...node.size },
    radius: node.radius,
    pinned: node.pinned,
    weight: node.weight,
  }))
}

function summarizeTelemetry(state: DragMergeState): TelemetrySnapshot {
  let mergedCount = 0
  let minGap = Infinity
  let strongestPair = 'None'

  for (const link of state.links) {
    if (link.merged) {
      mergedCount += 1
    }
    if (link.gapPx < minGap) {
      minGap = link.gapPx
      strongestPair = `${link.aId} ↔ ${link.bId}`
    }
  }

  return {
    mergedCount,
    strongestPair,
    strongestGap: Number.isFinite(minGap) ? `${minGap.toFixed(1)}px` : '—',
    activeCount: state.nodes.length,
  }
}

export function DragMergeLab({
  theme,
  reducedMotion,
  renderMode,
}: DragMergeLabProps): ReactElement {
  const [blendK, setBlendK] = useState<number>(DRAG_MERGE_DEFAULTS.blendK)
  const [magneticRadiusPx, setMagneticRadiusPx] = useState<number>(
    DRAG_MERGE_DEFAULTS.magneticRadiusPx,
  )
  const [returnToRest, setReturnToRest] = useState(false)
  const [snapToNearest, setSnapToNearest] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<GlassSurfaceController | null>(null)
  const stageSizeRef = useRef<Size>(DEFAULT_STAGE_SIZE)
  const userInteractedRef = useRef(false)
  const nextExtraIdxRef = useRef(1)

  const [initialSeed] = useState(() => {
    const nodes = createInitialDragMergeNodes(DEFAULT_STAGE_SIZE)
    const primitives = nodes.map((n) => ({
      id: n.id,
      center: { ...n.center },
      size: { ...n.size },
      radius: n.radius,
      weight: n.weight,
    }))
    return {
      nodes,
      nodeIds: nodes.map((n) => n.id),
      field: {
        primitives,
        blendK: DRAG_MERGE_DEFAULTS.blendK,
      } as GlassFieldState,
    }
  })

  const nodesSnapshotRef = useRef<DragMergeNodeInput[]>(initialSeed.nodes)
  const ctrlRef = useRef<DragMergeController | null>(null)
  const [nodeIds, setNodeIds] = useState<string[]>(initialSeed.nodeIds)
  const [nodeMetaMap, setNodeMetaMap] = useState<Readonly<Record<string, DragNodeMeta>>>(
    () => INITIAL_DRAG_NODE_META,
  )
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    mergedCount: 0,
    strongestPair: 'anchor ↔ orb-a',
    strongestGap: '22.3px',
    activeCount: initialSeed.nodeIds.length,
  })

  const hitboxMapRef = useRef(new Map<string, HTMLDivElement>())
  const loopRef = useRef<FrameLoop | null>(null)
  const lastTelemetryAtRef = useRef(0)
  const configRef = useRef({ theme, blendK })
  const reducedMotionRef = useRef(reducedMotion)

  const applyFrameToDom = useCallback((state: DragMergeState, forceTelemetry = false) => {
    const surface = surfaceRef.current
    const activeBlendK = configRef.current.blendK
    const activeTheme = configRef.current.theme

    if (surface) {
      surface.render({
        field: {
          primitives: state.field.primitives,
          blendK: activeBlendK,
          rimOpacity: state.field.rimOpacity,
          styleMix: state.field.styleMix,
        },
        material: DEFAULT_OPTICAL_MATERIALS[activeTheme].crisp,
        theme: activeTheme,
      })
    }

    for (const node of state.nodes) {
      const el = hitboxMapRef.current.get(node.id)
      if (!el) continue
      const x = node.center.x - node.size.width * 0.5
      const y = node.center.y - node.size.height * 0.5
      el.style.width = `${node.size.width}px`
      el.style.height = `${node.size.height}px`
      el.style.borderRadius = `${node.radius}px`
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
      el.style.cursor = node.pinned ? 'default' : node.dragging ? 'grabbing' : 'grab'
      el.setAttribute('data-dragging', node.dragging ? 'true' : 'false')
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (forceTelemetry || now - lastTelemetryAtRef.current >= 90) {
      lastTelemetryAtRef.current = now
      const nextTel = summarizeTelemetry(state)
      setTelemetry((prev) =>
        prev.mergedCount === nextTel.mergedCount &&
        prev.strongestPair === nextTel.strongestPair &&
        prev.strongestGap === nextTel.strongestGap &&
        prev.activeCount === nextTel.activeCount
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

  useLayoutEffect(() => {
    configRef.current = { theme, blendK }
    reducedMotionRef.current = reducedMotion
    if (ctrlRef.current) {
      applyFrameToDom(ctrlRef.current.getState(), true)
    }
  })

  useEffect(() => {
    const loop = createFrameLoop((dtSec) => {
      const ctrl = ctrlRef.current
      if (!ctrl) return false
      const next = ctrl.step(dtSec)
      const keepAlive = next.isAnimating || next.activeDragId !== null
      applyFrameToDom(next, !keepAlive)
      return keepAlive
    })
    loopRef.current = loop
    if (ctrlRef.current) {
      applyFrameToDom(ctrlRef.current.getState(), true)
    }

    return () => {
      loop.stop()
      if (loopRef.current === loop) {
        loopRef.current = null
      }
    }
  }, [applyFrameToDom])

  // Own controller creation and cleanup symmetrically in an effect for React StrictMode safety.
  useEffect(() => {
    const size = stageSizeRef.current
    const seedNodes = userInteractedRef.current
      ? nodesSnapshotRef.current
      : createInitialDragMergeNodes(size)

    const ctrl = createDragMergeController({
      nodes: seedNodes,
      bounds: {
        x: STAGE_BOUNDS_PAD,
        y: STAGE_BOUNDS_PAD,
        width: Math.max(40, size.width - STAGE_BOUNDS_PAD * 2),
        height: Math.max(40, size.height - STAGE_BOUNDS_PAD * 2),
      },
      blendK,
      magneticRadiusPx,
      returnToRestOnRelease: returnToRest,
      snapToNearestOnRelease: snapToNearest,
      reducedMotion: reducedMotionRef.current,
    })
    ctrlRef.current = ctrl
    applyFrameToDom(ctrl.getState(), true)

    return () => {
      nodesSnapshotRef.current = snapshotNodeInputs(ctrl)
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
      }
      ctrl.dispose()
    }
  }, [blendK, magneticRadiusPx, returnToRest, snapToNearest, applyFrameToDom])

  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.setReducedMotion(reducedMotion)
    applyFrameToDom(ctrl.getState(), true)
  }, [reducedMotion, applyFrameToDom])

  useEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    return observeElementResize(
      stageEl,
      (size) => {
        stageSizeRef.current = size
        const bounds = {
          x: STAGE_BOUNDS_PAD,
          y: STAGE_BOUNDS_PAD,
          width: Math.max(40, size.width - STAGE_BOUNDS_PAD * 2),
          height: Math.max(40, size.height - STAGE_BOUNDS_PAD * 2),
        }

        const ctrl = ctrlRef.current
        if (!ctrl) return
        ctrl.setBounds(bounds)

        if (!userInteractedRef.current && size.width > 0 && size.height > 0) {
          const responsiveNodes = createInitialDragMergeNodes(size)
          nodesSnapshotRef.current = responsiveNodes
          ctrl.setReducedMotion(true)
          for (const input of responsiveNodes) {
            ctrl.updateNode(input.id, {
              center: input.center,
              restCenter: input.center,
              size: input.size,
              radius: input.radius,
              pinned: input.pinned,
            })
          }
          ctrl.setReducedMotion(reducedMotionRef.current)
        }
        applyFrameToDom(ctrl.getState(), true)
      },
      { emitInitial: true },
    )
  }, [applyFrameToDom])

  const toStagePoint = (clientX: number, clientY: number) => {
    const stageEl = stageRef.current
    if (!stageEl) return { x: clientX, y: clientY }
    const rect = stageEl.getBoundingClientRect()
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    }
  }

  const handleBlobPointerDown = (id: string, e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const pt = toStagePoint(e.clientX, e.clientY)
    if (!ctrl.startDrag(id, pt)) return
    userInteractedRef.current = true
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    applyFrameToDom(ctrl.getState(), true)
    ensureLoop()
  }

  const handleBlobPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.getState().activeDragId) return
    ctrl.moveDrag(toStagePoint(e.clientX, e.clientY))
    applyFrameToDom(ctrl.getState())
    ensureLoop()
  }

  const handleBlobPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.getState().activeDragId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    ctrl.endDrag()
    applyFrameToDom(ctrl.getState(), true)
    ensureLoop()
  }

  const handleBlobPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.getState().activeDragId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    ctrl.cancelDrag()
    applyFrameToDom(ctrl.getState(), true)
    ensureLoop()
  }

  const handleAddDroplet = () => {
    const ctrl = ctrlRef.current
    if (!ctrl || ctrl.getState().nodes.length >= MAX_GPU_PRIMITIVES) return
    userInteractedRef.current = true
    const idx = nextExtraIdxRef.current++
    const input = createExtraDropletInput(idx, stageSizeRef.current)
    ctrl.addNode(input)
    nodesSnapshotRef.current = snapshotNodeInputs(ctrl)
    setNodeMetaMap((prev) => ({
      ...prev,
      [input.id]: { id: input.id, label: `Drop ${idx}`, sublabel: 'Drag me' },
    }))
    setNodeIds(ctrl.getState().nodes.map((n) => n.id))
    applyFrameToDom(ctrl.getState(), true)
  }

  const handleRemoveLastDroplet = () => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const list = ctrl.getState().nodes
    const removable = [...list].reverse().find((n) => !n.pinned)
    if (!removable || list.length <= 2) return
    ctrl.removeNode(removable.id)
    nodesSnapshotRef.current = snapshotNodeInputs(ctrl)
    setNodeIds(ctrl.getState().nodes.map((n) => n.id))
    applyFrameToDom(ctrl.getState(), true)
  }

  const handleReset = () => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    userInteractedRef.current = false
    const fresh = createInitialDragMergeNodes(stageSizeRef.current)
    for (const node of [...ctrl.getState().nodes]) {
      if (!INITIAL_DRAG_NODE_META[node.id]) {
        ctrl.removeNode(node.id)
      }
    }
    const existingIds = new Set(ctrl.getState().nodes.map((n) => n.id))
    for (const input of fresh) {
      if (!existingIds.has(input.id)) {
        ctrl.addNode(input)
      } else {
        ctrl.updateNode(input.id, {
          center: input.center,
          restCenter: input.center,
          size: input.size,
          radius: input.radius,
          pinned: input.pinned,
        })
      }
    }
    nodesSnapshotRef.current = fresh
    setNodeIds(ctrl.getState().nodes.map((n) => n.id))
    applyFrameToDom(ctrl.getState(), true)
    ensureLoop()
  }

  return (
    <div className="pg-lab-grid">
      <div className="pg-stage" ref={stageRef} data-testid="drag-merge-stage">
        <LiveBackdrop
          title="Drag & Merge Liquid Bridges"
          caption="Drag droplets across swatches or slide them into the pinned anchor to trigger magnetic pull and smin meniscus bridges."
        />
        <GlassField
          className="pg-glass-stage"
          controllerRef={surfaceRef}
          mode={renderMode}
          theme={theme}
          blendK={blendK}
          primitives={initialSeed.field.primitives}
          material={DEFAULT_OPTICAL_MATERIALS[theme].crisp}
        >
          {nodeIds.map((id) => {
            const meta = nodeMetaMap[id] ?? { id, label: id, sublabel: 'Drag me' }
            return (
              <div
                key={id}
                ref={(el) => {
                  if (el) {
                    hitboxMapRef.current.set(id, el)
                  } else {
                    hitboxMapRef.current.delete(id)
                  }
                }}
                className="pg-blob-label"
                style={{ pointerEvents: 'auto', touchAction: 'none' }}
                data-node-id={id}
                onPointerDown={(e) => handleBlobPointerDown(id, e)}
                onPointerMove={handleBlobPointerMove}
                onPointerUp={handleBlobPointerUp}
                onPointerCancel={handleBlobPointerCancel}
              >
                <span>{meta.label}</span>
                <span className="pg-blob-sub">{meta.sublabel}</span>
              </div>
            )
          })}
        </GlassField>
      </div>

      <ControlPanel
        title="Field & Coupling Controls"
        description="Tune the smooth-union radius and magnetic pull driving the N-primitive SDF field."
      >
        <SliderControl
          id="drag-blend-k"
          label="Smooth Union (blendK)"
          value={blendK}
          min={0}
          max={48}
          unit="px"
          onChange={setBlendK}
        />
        <SliderControl
          id="drag-magnetic-r"
          label="Magnetic Capture Radius"
          value={magneticRadiusPx}
          min={0}
          max={96}
          unit="px"
          onChange={setMagneticRadiusPx}
        />

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={returnToRest}
            onClick={() => {
              setReturnToRest((v) => !v)
              if (!returnToRest) setSnapToNearest(false)
            }}
          >
            Return on Release
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={snapToNearest}
            onClick={() => {
              setSnapToNearest((v) => !v)
              if (!snapToNearest) setReturnToRest(false)
            }}
          >
            Snap Nearest
          </button>
        </div>

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            disabled={nodeIds.length >= MAX_GPU_PRIMITIVES}
            onClick={handleAddDroplet}
          >
            Add Droplet
          </button>
          <button
            type="button"
            className="pg-btn"
            disabled={nodeIds.length <= 2}
            onClick={handleRemoveLastDroplet}
          >
            Remove
          </button>
          <button type="button" className="pg-btn" onClick={handleReset}>
            Reset
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">Primitives</div>
            <div className="pg-stat-value">
              {telemetry.activeCount} / {MAX_GPU_PRIMITIVES}
            </div>
          </div>
          <div>
            <div className="pg-stat-label">Active Bridges</div>
            <div className="pg-stat-value">{telemetry.mergedCount}</div>
          </div>
          <div>
            <div className="pg-stat-label">Closest Pair</div>
            <div className="pg-stat-value">{telemetry.strongestPair}</div>
          </div>
          <div>
            <div className="pg-stat-label">Surface Gap</div>
            <div className="pg-stat-value">{telemetry.strongestGap}</div>
          </div>
        </div>
      </ControlPanel>
    </div>
  )
}
