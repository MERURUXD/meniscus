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
  MAX_GPU_PRIMITIVES,
  type GlassFieldState,
  type Size,
  type ThemeMode,
} from '@sessile/core'
import {
  GlassSurfaceController,
  createFrameLoop,
  observeElementResize,
  type FrameLoop,
  type SurfaceRenderMode,
} from '@sessile/dom'
import { GlassField } from '@sessile/react'
import {
  DRAG_MERGE_DEFAULTS,
  createDragMergeController,
  type DragMergeController,
  type DragMergeNodeInput,
  type DragMergeState,
} from '@sessile/presets'
import { ControlPanel, SliderControl } from '../components/ControlPanel.tsx'
import { TestChart } from '../components/TestChart.tsx'
import { getMessages, type Locale, type PlaygroundMessages } from '../i18n.ts'
import {
  INITIAL_DRAG_NODE_META,
  SHOWCASE_MATERIALS,
  createExtraDropletInput,
  createInitialDragMergeNodes,
} from '../labDefaults.ts'

export interface DragMergeLabProps {
  theme: ThemeMode
  locale: Locale
  reducedMotion: boolean
  renderMode: SurfaceRenderMode
}

interface TelemetrySnapshot {
  mergedCount: number
  aId: string | null
  bId: string | null
  minGap: number
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
  let aId: string | null = null
  let bId: string | null = null

  for (const link of state.links) {
    if (link.merged) {
      mergedCount += 1
    }
    if (link.gapPx < minGap) {
      minGap = link.gapPx
      aId = link.aId
      bId = link.bId
    }
  }

  return {
    mergedCount,
    aId,
    bId,
    minGap,
    activeCount: state.nodes.length,
  }
}

function resolveNodeDisplay(
  id: string,
  extraIndices: Readonly<Record<string, number>>,
  copy: PlaygroundMessages['dragMerge'],
): { label: string; sublabel: string } {
  if (
    id === 'anchor' ||
    id === 'orb-a' ||
    id === 'orb-b' ||
    id === 'pill-c'
  ) {
    return copy.nodes[id]
  }
  const extraIdx = extraIndices[id]
  if (extraIdx !== undefined) {
    return {
      label: `${copy.extraNodeLabelPrefix} ${extraIdx}`,
      sublabel: copy.extraNodeSublabel,
    }
  }
  return { label: id, sublabel: copy.extraNodeSublabel }
}

export function DragMergeLab({
  theme,
  locale,
  reducedMotion,
  renderMode,
}: DragMergeLabProps): ReactElement {
  const t = getMessages(locale)
  const dm = t.dragMerge

  const [blendK, setBlendK] = useState<number>(DRAG_MERGE_DEFAULTS.blendK)
  const [magneticRadiusPx, setMagneticRadiusPx] = useState<number>(
    DRAG_MERGE_DEFAULTS.magneticRadiusPx,
  )
  const [returnToRest, setReturnToRest] = useState(false)
  const [snapToNearest, setSnapToNearest] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const [surfaceCtrl, setSurfaceCtrl] = useState<GlassSurfaceController | null>(null)
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
  const [extraIndices, setExtraIndices] = useState<Readonly<Record<string, number>>>({})
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    mergedCount: 0,
    aId: 'anchor',
    bId: 'orb-a',
    minGap: 22.3,
    activeCount: initialSeed.nodeIds.length,
  })

  const hitboxMapRef = useRef(new Map<string, HTMLDivElement>())
  const loopRef = useRef<FrameLoop | null>(null)
  const lastTelemetryAtRef = useRef(0)
  const configRef = useRef({ theme, blendK, renderMode })
  const reducedMotionRef = useRef(reducedMotion)

  const applyFrameToDom = useCallback((state: DragMergeState, forceTelemetry = false) => {
    const surface = surfaceRef.current
    const activeBlendK = configRef.current.blendK
    const activeTheme = configRef.current.theme
    const activeMaterials = SHOWCASE_MATERIALS[configRef.current.renderMode]

    if (surface) {
      surface.render({
        field: {
          primitives: state.field.primitives,
          blendK: activeBlendK,
          rimOpacity: state.field.rimOpacity,
          styleMix: state.field.styleMix,
        },
        material: activeMaterials[activeTheme],
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
        prev.aId === nextTel.aId &&
        prev.bId === nextTel.bId &&
        Math.abs(prev.minGap - nextTel.minGap) < 0.05 &&
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
    surfaceRef.current = surfaceCtrl
    configRef.current = { theme, blendK, renderMode }
    reducedMotionRef.current = reducedMotion
    if (ctrlRef.current && surfaceCtrl) {
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
    setExtraIndices((prev) => ({ ...prev, [input.id]: idx }))
    setNodeIds(ctrl.getState().nodes.map((n) => n.id))
    applyFrameToDom(ctrl.getState(), true)
  }

  const handleRemoveLastDroplet = () => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const list = ctrl.getState().nodes
    const removable = [...list].reverse().find((n) => !n.pinned)
    if (!removable || list.length <= 2) return
    userInteractedRef.current = true
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

  const closestPairText =
    telemetry.aId && telemetry.bId
      ? `${resolveNodeDisplay(telemetry.aId, extraIndices, dm).label} ↔ ${resolveNodeDisplay(telemetry.bId, extraIndices, dm).label}`
      : dm.nonePair
  const gapText = Number.isFinite(telemetry.minGap) ? `${telemetry.minGap.toFixed(1)}px` : '—'

  return (
    <>
      <div className="pg-stage" ref={stageRef} data-testid="drag-merge-stage">
        <TestChart
          title={dm.backdropTitle}
          caption={dm.backdropCaption}
          messages={t.chart}
        />
        <GlassField
          className="pg-glass-stage"
          controllerRef={setSurfaceCtrl}
          mode={renderMode}
          theme={theme}
          blendK={blendK}
          primitives={initialSeed.field.primitives}
          material={SHOWCASE_MATERIALS[renderMode][theme]}
        >
          {nodeIds.map((id) => {
            const meta = resolveNodeDisplay(id, extraIndices, dm)
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

      <ControlPanel title={dm.panelTitle} description={dm.panelDescription}>
        <SliderControl
          id="drag-blend-k"
          label={dm.blendKLabel}
          value={blendK}
          min={0}
          max={48}
          unit="px"
          onChange={setBlendK}
        />
        <SliderControl
          id="drag-magnetic-r"
          label={dm.magneticRadiusLabel}
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
            {dm.returnOnRelease}
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
            {dm.snapNearest}
          </button>
        </div>

        <div className="pg-btn-group">
          <button
            type="button"
            className="pg-btn"
            disabled={nodeIds.length >= MAX_GPU_PRIMITIVES}
            onClick={handleAddDroplet}
          >
            {dm.addDroplet}
          </button>
          <button
            type="button"
            className="pg-btn"
            disabled={nodeIds.length <= 2}
            onClick={handleRemoveLastDroplet}
          >
            {dm.remove}
          </button>
          <button type="button" className="pg-btn" onClick={handleReset}>
            {dm.reset}
          </button>
        </div>

        <div className="pg-telemetry">
          <div>
            <div className="pg-stat-label">{dm.statPrimitives}</div>
            <div className="pg-stat-value">
              {telemetry.activeCount} / {MAX_GPU_PRIMITIVES}
            </div>
          </div>
          <div>
            <div className="pg-stat-label">{dm.statBridges}</div>
            <div className="pg-stat-value">{telemetry.mergedCount}</div>
          </div>
          <div>
            <div className="pg-stat-label">{dm.statClosestPair}</div>
            <div className="pg-stat-value">{closestPairText}</div>
          </div>
          <div>
            <div className="pg-stat-label">{dm.statSurfaceGap}</div>
            <div className="pg-stat-value">{gapText}</div>
          </div>
        </div>
      </ControlPanel>
    </>
  )
}
