/**
 * Drag-Merge N-primitive preset for Sessile.
 *
 * Manages draggable rounded-box glass primitives with exact rounded-box hit testing,
 * spring-coupled inertia, soft magnetic attraction, elastic neighbor tugging,
 * release snap/return behaviors, and pairwise smin proximity bridge reporting.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  clamp,
  computeRoundedBoxDistance,
  createSpringChannel,
  deformSizePreservingArea,
  type GlassFieldState,
  type GlassPrimitive,
  type Point,
  type Rect,
  type Size,
  type SpringChannel,
  type SpringParams,
} from '@sessile/core'

/** Initial node descriptor for `createDragMergeController`. */
export interface DragMergeNodeInput {
  id: string
  center: Point
  size: Size
  radius: number
  pinned?: boolean
  weight?: number
  restCenter?: Point
}

/** Mutable fields accepted by `updateNode`. */
export interface DragMergeNodePatch {
  center?: Point
  size?: Size
  radius?: number
  pinned?: boolean
  weight?: number
  restCenter?: Point
}

/** Instantaneous snapshot of a single draggable node. */
export interface DragMergeNodeState {
  id: string
  primitive: GlassPrimitive
  center: Point
  targetCenter: Point
  restCenter: Point
  size: Size
  radius: number
  pinned: boolean
  weight: number
  dragging: boolean
  settled: boolean
}

/** Pairwise proximity and smin liquid bridge status between two nodes. */
export interface DragMergeLink {
  aId: string
  bId: string
  gapPx: number
  bridgeStrength: number
  merged: boolean
  mergeDepth: number
}

/** Configuration options for `createDragMergeController`. */
export interface DragMergeOptions {
  nodes?: readonly DragMergeNodeInput[]
  blendK?: number
  magneticRadiusPx?: number
  magneticStrength?: number
  neighborTugRatio?: number
  /** Peak area-preserving squash-and-stretch ratio driven by node spring velocity (`0` disables; defaults to `0.08`). */
  velocityStretch?: number
  /** Speed (px/s) at which velocity-driven stretch reaches 50% of `velocityStretch` (defaults to `900`). */
  velocityStretchReferencePxPerSec?: number
  spring?: SpringParams
  bounds?: Rect
  returnToRestOnRelease?: boolean
  snapToNearestOnRelease?: boolean
  reducedMotion?: boolean
}

/** Complete instantaneous snapshot returned by `createDragMergeController`. */
export interface DragMergeState {
  nodes: readonly DragMergeNodeState[]
  links: readonly DragMergeLink[]
  activeDragId: string | null
  nearestCandidateId: string | null
  field: GlassFieldState
  isAnimating: boolean
  reducedMotion: boolean
}

/** Controller interface for N-primitive interactive drag-and-merge glass fields. */
export interface DragMergeController {
  hitTest(point: Point): string | null
  startDrag(id: string, pointer: Point): boolean
  moveDrag(pointer: Point): void
  endDrag(): void
  cancelDrag(): void
  addNode(node: DragMergeNodeInput): void
  removeNode(id: string): void
  updateNode(id: string, patch: DragMergeNodePatch): void
  setBounds(bounds: Rect | undefined): void
  setReducedMotion(reduced: boolean): void
  step(dtSec: number): DragMergeState
  getState(): DragMergeState
  subscribe(listener: (state: DragMergeState) => void): () => void
  dispose(): void
}

/** Default smin blend, magnetic range, and spring constants for drag-merge fields. */
export const DRAG_MERGE_DEFAULTS = {
  blendK: 32,
  magneticRadiusPx: 48,
  magneticStrength: 0.18,
  neighborTugRatio: 0.14,
  velocityStretch: 0.08,
  velocityStretchReferencePxPerSec: 900,
  spring: { mass: 1, stiffness: 280, dampingRatio: 0.72 },
} as const satisfies {
  blendK: number
  magneticRadiusPx: number
  magneticStrength: number
  neighborTugRatio: number
  velocityStretch: number
  velocityStretchReferencePxPerSec: number
  spring: SpringParams
}

interface InternalNode {
  id: string
  x: SpringChannel
  y: SpringChannel
  baseCenter: Point
  restCenter: Point
  size: Size
  radius: number
  pinned: boolean
  weight: number
}

function clampNodeSize(size: Size): Size {
  return {
    width: Math.max(0, size.width),
    height: Math.max(0, size.height),
  }
}

function clampNodeRadius(radius: number, size: Size): number {
  return Math.max(0, Math.min(radius, size.width * 0.5, size.height * 0.5))
}

function clampCenterToBounds(center: Point, size: Size, bounds?: Rect): Point {
  if (!bounds) {
    return { x: center.x, y: center.y }
  }
  const halfW = size.width * 0.5
  const halfH = size.height * 0.5
  const minX = bounds.x + halfW
  const maxX = bounds.x + bounds.width - halfW
  const minY = bounds.y + halfH
  const maxY = bounds.y + bounds.height - halfH

  return {
    x: maxX < minX ? bounds.x + bounds.width * 0.5 : clamp(center.x, minX, maxX),
    y: maxY < minY ? bounds.y + bounds.height * 0.5 : clamp(center.y, minY, maxY),
  }
}

/**
 * Computes exact signed surface-to-surface Euclidean gap between two axis-aligned
 * rounded rectangles using Minkowski core decomposition (`Box = Core (+) Disk(r)`).
 * Negative values indicate surface penetration depth; `0` means kissing contact.
 */
function computeRoundedBoxesGap(a: GlassPrimitive, b: GlassPrimitive): number {
  const haw = Math.max(0, a.size.width * 0.5)
  const hah = Math.max(0, a.size.height * 0.5)
  const ra = clampNodeRadius(a.radius, a.size)
  const iaw = haw - ra
  const iah = hah - ra

  const hbw = Math.max(0, b.size.width * 0.5)
  const hbh = Math.max(0, b.size.height * 0.5)
  const rb = clampNodeRadius(b.radius, b.size)
  const ibw = hbw - rb
  const ibh = hbh - rb

  const dx = Math.abs(b.center.x - a.center.x)
  const dy = Math.abs(b.center.y - a.center.y)
  const gx = Math.max(0, dx - iaw - ibw)
  const gy = Math.max(0, dy - iah - ibh)

  if (gx > 0 || gy > 0) {
    return Math.hypot(gx, gy) - ra - rb
  }

  const overlapX = iaw + ibw - dx
  const overlapY = iah + ibh - dy
  return -Math.min(overlapX, overlapY) - ra - rb
}

function makePrimitiveFromCoords(
  node: Pick<InternalNode, 'id' | 'size' | 'radius' | 'weight'>,
  center: Point,
): GlassPrimitive {
  return {
    id: node.id,
    center: { x: center.x, y: center.y },
    size: { width: node.size.width, height: node.size.height },
    radius: node.radius,
    weight: node.weight,
  }
}

/**
 * Creates an interactive N-primitive drag-and-merge glass field controller.
 */
export function createDragMergeController(
  options: DragMergeOptions = {},
): DragMergeController {
  const blendK = Math.max(0, options.blendK ?? DRAG_MERGE_DEFAULTS.blendK)
  const magneticRadiusPx = Math.max(
    0,
    options.magneticRadiusPx ?? DRAG_MERGE_DEFAULTS.magneticRadiusPx,
  )
  const magneticStrength = clamp(
    options.magneticStrength ?? DRAG_MERGE_DEFAULTS.magneticStrength,
    0,
    1,
  )
  const neighborTugRatio = clamp(
    options.neighborTugRatio ?? DRAG_MERGE_DEFAULTS.neighborTugRatio,
    0,
    1,
  )
  const velocityStretch = clamp(
    options.velocityStretch ?? DRAG_MERGE_DEFAULTS.velocityStretch,
    0,
    0.35,
  )
  const velocityStretchRef = Math.max(
    1,
    options.velocityStretchReferencePxPerSec ??
      DRAG_MERGE_DEFAULTS.velocityStretchReferencePxPerSec,
  )
  const springParams = options.spring ?? DRAG_MERGE_DEFAULTS.spring
  const returnToRestOnRelease = options.returnToRestOnRelease ?? false
  const snapToNearestOnRelease = options.snapToNearestOnRelease ?? false

  let bounds = options.bounds ? { ...options.bounds } : undefined
  let reducedMotion = options.reducedMotion ?? false
  let disposed = false

  let activeDragId: string | null = null
  let dragGrabOffset: Point = { x: 0, y: 0 }
  let dragOriginCenter: Point | null = null
  let nearestCandidateId: string | null = null

  const nodes: InternalNode[] = []
  const listeners = new Set<(state: DragMergeState) => void>()

  function findNodeIndex(id: string): number {
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i]!.id === id) return i
    }
    return -1
  }

  function findNode(id: string | null): InternalNode | null {
    if (!id) return null
    const index = findNodeIndex(id)
    return index >= 0 ? nodes[index]! : null
  }

  function createChannel(initialValue: number): SpringChannel {
    return createSpringChannel({
      params: springParams,
      initialValue,
      initialTarget: initialValue,
      settlePosEps: 0.05,
      settleVelEps: 0.25,
    })
  }

  function createInternalNode(input: DragMergeNodeInput): InternalNode {
    const size = clampNodeSize(input.size)
    const radius = clampNodeRadius(input.radius, size)
    const clampedCenter = clampCenterToBounds(input.center, size, bounds)
    const clampedRest = clampCenterToBounds(input.restCenter ?? clampedCenter, size, bounds)
    return {
      id: input.id,
      x: createChannel(clampedCenter.x),
      y: createChannel(clampedCenter.y),
      baseCenter: { ...clampedCenter },
      restCenter: { ...clampedRest },
      size,
      radius,
      pinned: input.pinned ?? false,
      weight: input.weight ?? 1,
    }
  }

  if (options.nodes) {
    for (const input of options.nodes) {
      if (findNodeIndex(input.id) === -1) {
        nodes.push(createInternalNode(input))
      }
    }
  }

  function setNodeTarget(node: InternalNode, target: Point, immediate: boolean): void {
    const clamped = clampCenterToBounds(target, node.size, bounds)
    node.x.setTarget(clamped.x)
    node.y.setTarget(clamped.y)
    if (immediate) {
      node.x.snap(clamped.x, 0)
      node.y.snap(clamped.y, 0)
    }
  }

  function clampAxisToBounds(
    channel: SpringChannel,
    boundStart: number,
    boundSpan: number,
    halfSize: number,
  ): boolean {
    const minPos = boundStart + halfSize
    const maxPos = boundStart + boundSpan - halfSize
    const state = channel.getState()
    if (maxPos < minPos) {
      const mid = boundStart + boundSpan * 0.5
      if (state.value !== mid || state.velocity !== 0 || state.target !== mid) {
        channel.setTarget(mid)
        channel.snap(mid, 0)
        return true
      }
      return false
    }
    if (state.value < minPos) {
      channel.snap(minPos, state.velocity < 0 ? 0 : state.velocity)
      return true
    }
    if (state.value > maxPos) {
      channel.snap(maxPos, state.velocity > 0 ? 0 : state.velocity)
      return true
    }
    return false
  }

  function clampNodePositionToBounds(node: InternalNode): boolean {
    if (!bounds) return false
    const cx = clampAxisToBounds(node.x, bounds.x, bounds.width, node.size.width * 0.5)
    const cy = clampAxisToBounds(node.y, bounds.y, bounds.height, node.size.height * 0.5)
    return cx || cy
  }

  function restoreOtherNodeBases(excludeId: string | null, immediate: boolean): void {
    for (const node of nodes) {
      if (node.id === excludeId) continue
      setNodeTarget(node, node.baseCenter, immediate)
    }
  }

  function evaluateMagneticTargets(dragNode: InternalNode, rawTarget: Point): void {
    if (reducedMotion || magneticRadiusPx <= 0) {
      let bestId: string | null = null
      let bestGap = Infinity
      if (magneticRadiusPx > 0) {
        const dragPrim = makePrimitiveFromCoords(dragNode, rawTarget)
        for (const candidate of nodes) {
          if (candidate.id === dragNode.id) continue
          const candPrim = makePrimitiveFromCoords(candidate, candidate.baseCenter)
          const gap = computeRoundedBoxesGap(dragPrim, candPrim)
          if (gap <= magneticRadiusPx && gap < bestGap) {
            bestGap = gap
            bestId = candidate.id
          }
        }
      }
      nearestCandidateId = bestId
      setNodeTarget(dragNode, rawTarget, reducedMotion)
      restoreOtherNodeBases(dragNode.id, reducedMotion)
      return
    }

    const dragPrimAtRaw = makePrimitiveFromCoords(dragNode, rawTarget)
    let bestCandidate: InternalNode | null = null
    let bestGap = Infinity

    for (const candidate of nodes) {
      if (candidate.id === dragNode.id) continue
      const candPrim = makePrimitiveFromCoords(candidate, candidate.baseCenter)
      const gap = computeRoundedBoxesGap(dragPrimAtRaw, candPrim)
      if (gap <= magneticRadiusPx && gap < bestGap) {
        bestGap = gap
        bestCandidate = candidate
      }
    }

    nearestCandidateId = bestCandidate?.id ?? null

    let draggedTarget = rawTarget
    if (bestCandidate && magneticStrength > 0) {
      const prox = clamp(1 - Math.max(0, bestGap) / magneticRadiusPx, 0, 1)
      const pullWeight = magneticStrength * prox
      draggedTarget = clampCenterToBounds(
        {
          x: rawTarget.x + (bestCandidate.baseCenter.x - rawTarget.x) * pullWeight,
          y: rawTarget.y + (bestCandidate.baseCenter.y - rawTarget.y) * pullWeight,
        },
        dragNode.size,
        bounds,
      )
    }

    setNodeTarget(dragNode, draggedTarget, false)

    const dragPrimAtPulled = makePrimitiveFromCoords(dragNode, draggedTarget)
    for (const neighbor of nodes) {
      if (neighbor.id === dragNode.id) continue
      if (neighbor.pinned || neighborTugRatio <= 0) {
        setNodeTarget(neighbor, neighbor.baseCenter, false)
        continue
      }
      const neighborPrim = makePrimitiveFromCoords(neighbor, neighbor.baseCenter)
      const gap = computeRoundedBoxesGap(dragPrimAtPulled, neighborPrim)
      if (gap <= magneticRadiusPx) {
        const prox = clamp(1 - Math.max(0, gap) / magneticRadiusPx, 0, 1)
        const tug = neighborTugRatio * prox
        setNodeTarget(
          neighbor,
          {
            x: neighbor.baseCenter.x + (draggedTarget.x - neighbor.baseCenter.x) * tug,
            y: neighbor.baseCenter.y + (draggedTarget.y - neighbor.baseCenter.y) * tug,
          },
          false,
        )
      } else {
        setNodeTarget(neighbor, neighbor.baseCenter, false)
      }
    }
  }

  function buildRenderedNodeSnapshot(node: InternalNode) {
    const xState = node.x.getState()
    const yState = node.y.getState()
    const settled = xState.settled && yState.settled
    const center: Point = { x: xState.value, y: yState.value }
    let primitiveSize: Size = { width: node.size.width, height: node.size.height }
    let primitiveRadius = node.radius

    if (!reducedMotion && !node.pinned && !settled && velocityStretch > 0) {
      const speed = Math.hypot(xState.velocity, yState.velocity)
      if (speed > 1) {
        const normSpeed = speed / (speed + velocityStretchRef)
        let stretch = 1 + velocityStretch * normSpeed
        if (bounds) {
          const lenSq = xState.velocity * xState.velocity + yState.velocity * yState.velocity
          const alpha =
            lenSq > 1e-12
              ? (xState.velocity * xState.velocity - yState.velocity * yState.velocity) / lenSq
              : 0
          if (alpha > 1e-6 && node.size.width > 0) {
            const availHalfW = Math.max(
              0,
              Math.min(center.x - bounds.x, bounds.x + bounds.width - center.x),
            )
            const maxScaleX = (2 * availHalfW) / node.size.width
            stretch = maxScaleX <= 1 ? 1 : Math.min(stretch, Math.pow(maxScaleX, 1 / alpha))
          } else if (alpha < -1e-6 && node.size.height > 0) {
            const availHalfH = Math.max(
              0,
              Math.min(center.y - bounds.y, bounds.y + bounds.height - center.y),
            )
            const maxScaleY = (2 * availHalfH) / node.size.height
            stretch = maxScaleY <= 1 ? 1 : Math.min(stretch, Math.pow(maxScaleY, 1 / -alpha))
          }
        }
        if (stretch > 1 + 1e-9) {
          primitiveSize = deformSizePreservingArea(
            node.size,
            stretch,
            xState.velocity,
            yState.velocity,
          )
          primitiveRadius = clampNodeRadius(node.radius, primitiveSize)
        }
      }
    }

    const primitive: GlassPrimitive = {
      id: node.id,
      center,
      size: primitiveSize,
      radius: primitiveRadius,
      weight: node.weight,
    }
    return { primitive, center, xState, yState, settled }
  }

  function buildState(): DragMergeState {
    const nodeStates: DragMergeNodeState[] = []
    const primitives: GlassPrimitive[] = []
    let animating = false

    for (const node of nodes) {
      const snap = buildRenderedNodeSnapshot(node)
      if (!snap.settled) {
        animating = true
      }
      primitives.push(snap.primitive)
      nodeStates.push({
        id: node.id,
        primitive: snap.primitive,
        center: { x: snap.center.x, y: snap.center.y },
        targetCenter: { x: snap.xState.target, y: snap.yState.target },
        restCenter: { ...node.restCenter },
        size: { ...node.size },
        radius: node.radius,
        pinned: node.pinned,
        weight: node.weight,
        dragging: activeDragId === node.id,
        settled: snap.settled,
      })
    }

    const links: DragMergeLink[] = []
    const sminBridgeThreshold = blendK * 0.5
    for (let i = 0; i < primitives.length; i += 1) {
      const a = primitives[i]!
      for (let j = i + 1; j < primitives.length; j += 1) {
        const b = primitives[j]!
        const gapPx = computeRoundedBoxesGap(a, b)
        const mergeDepth = sminBridgeThreshold - gapPx
        const merged = mergeDepth >= 0
        let bridgeStrength = 0
        if (merged) {
          if (gapPx <= 0 || sminBridgeThreshold <= 1e-6) {
            bridgeStrength = 1
          } else {
            bridgeStrength = clamp(1 - gapPx / sminBridgeThreshold, 0, 1)
          }
        }
        links.push({
          aId: nodes[i]!.id,
          bId: nodes[j]!.id,
          gapPx,
          bridgeStrength,
          merged,
          mergeDepth,
        })
      }
    }

    return {
      nodes: nodeStates,
      links,
      activeDragId,
      nearestCandidateId,
      field: {
        primitives,
        blendK,
      },
      isAnimating: animating || activeDragId !== null,
      reducedMotion,
    }
  }

  function notify(): void {
    if (disposed || listeners.size === 0) return
    const snapshot = buildState()
    for (const listener of [...listeners]) {
      listener(snapshot)
    }
  }

  return {
    hitTest(point: Point): string | null {
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i]!
        const { primitive } = buildRenderedNodeSnapshot(node)
        if (computeRoundedBoxDistance(point.x, point.y, primitive) <= 0) {
          return node.id
        }
      }
      return null
    },

    startDrag(id: string, pointer: Point): boolean {
      if (disposed) return false
      const node = findNode(id)
      if (!node || node.pinned) {
        return false
      }
      if (activeDragId && activeDragId !== id) {
        restoreOtherNodeBases(null, reducedMotion)
      }
      activeDragId = node.id
      const currentX = node.x.getState().value
      const currentY = node.y.getState().value
      dragOriginCenter = { ...node.baseCenter }
      dragGrabOffset = {
        x: pointer.x - currentX,
        y: pointer.y - currentY,
      }
      evaluateMagneticTargets(node, clampCenterToBounds({ x: currentX, y: currentY }, node.size, bounds))
      notify()
      return true
    },

    moveDrag(pointer: Point): void {
      if (disposed || !activeDragId) return
      const dragNode = findNode(activeDragId)
      if (!dragNode) {
        activeDragId = null
        nearestCandidateId = null
        dragOriginCenter = null
        return
      }
      const rawTarget = clampCenterToBounds(
        {
          x: pointer.x - dragGrabOffset.x,
          y: pointer.y - dragGrabOffset.y,
        },
        dragNode.size,
        bounds,
      )
      evaluateMagneticTargets(dragNode, rawTarget)
      notify()
    },

    endDrag(): void {
      if (disposed || !activeDragId) return
      const dragNode = findNode(activeDragId)
      const candidate = findNode(nearestCandidateId)
      activeDragId = null
      nearestCandidateId = null
      dragOriginCenter = null

      if (dragNode) {
        if (returnToRestOnRelease) {
          dragNode.baseCenter = { ...dragNode.restCenter }
          setNodeTarget(dragNode, dragNode.restCenter, reducedMotion)
        } else if (snapToNearestOnRelease && candidate) {
          const snapped = clampCenterToBounds(candidate.baseCenter, dragNode.size, bounds)
          dragNode.baseCenter = { ...snapped }
          setNodeTarget(dragNode, snapped, reducedMotion)
        } else {
          const finalTarget = clampCenterToBounds(
            {
              x: dragNode.x.getState().target,
              y: dragNode.y.getState().target,
            },
            dragNode.size,
            bounds,
          )
          dragNode.baseCenter = { ...finalTarget }
          setNodeTarget(dragNode, finalTarget, reducedMotion)
        }
      }

      restoreOtherNodeBases(null, reducedMotion)
      notify()
    },

    cancelDrag(): void {
      if (disposed || !activeDragId) return
      const dragNode = findNode(activeDragId)
      const origin = dragOriginCenter
      activeDragId = null
      nearestCandidateId = null
      dragOriginCenter = null

      if (dragNode && origin) {
        const restored = clampCenterToBounds(origin, dragNode.size, bounds)
        dragNode.baseCenter = { ...restored }
        setNodeTarget(dragNode, restored, reducedMotion)
      }
      restoreOtherNodeBases(null, reducedMotion)
      notify()
    },

    addNode(nodeInput: DragMergeNodeInput): void {
      if (disposed || findNodeIndex(nodeInput.id) !== -1) return
      nodes.push(createInternalNode(nodeInput))
      notify()
    },

    removeNode(id: string): void {
      if (disposed) return
      const index = findNodeIndex(id)
      if (index === -1) return
      nodes.splice(index, 1)
      if (activeDragId === id) {
        activeDragId = null
        dragOriginCenter = null
        nearestCandidateId = null
        restoreOtherNodeBases(null, reducedMotion)
      } else if (nearestCandidateId === id) {
        nearestCandidateId = null
      }
      notify()
    },

    updateNode(id: string, patch: DragMergeNodePatch): void {
      if (disposed) return
      const node = findNode(id)
      if (!node) return
      if (patch.size !== undefined) {
        node.size = clampNodeSize(patch.size)
      }
      if (patch.radius !== undefined) {
        node.radius = clampNodeRadius(patch.radius, node.size)
      } else if (patch.size !== undefined) {
        node.radius = clampNodeRadius(node.radius, node.size)
      }
      if (patch.pinned !== undefined) {
        node.pinned = patch.pinned
        if (node.pinned && activeDragId === node.id) {
          activeDragId = null
          nearestCandidateId = null
          dragOriginCenter = null
          restoreOtherNodeBases(node.id, reducedMotion)
        }
      }
      if (patch.weight !== undefined) {
        node.weight = patch.weight
      }
      if (patch.restCenter !== undefined) {
        node.restCenter = clampCenterToBounds(patch.restCenter, node.size, bounds)
      }
      if (patch.center !== undefined) {
        const clamped = clampCenterToBounds(patch.center, node.size, bounds)
        node.baseCenter = { ...clamped }
        setNodeTarget(node, clamped, reducedMotion)
      } else {
        const clampedCurrent = clampCenterToBounds(node.baseCenter, node.size, bounds)
        node.baseCenter = { ...clampedCurrent }
        if (activeDragId !== node.id) {
          setNodeTarget(node, clampedCurrent, reducedMotion)
        }
      }
      clampNodePositionToBounds(node)
      notify()
    },

    setBounds(nextBounds: Rect | undefined): void {
      if (disposed) return
      bounds = nextBounds ? { ...nextBounds } : undefined
      for (const node of nodes) {
        node.restCenter = clampCenterToBounds(node.restCenter, node.size, bounds)
        node.baseCenter = clampCenterToBounds(node.baseCenter, node.size, bounds)
        setNodeTarget(
          node,
          { x: node.x.getState().target, y: node.y.getState().target },
          reducedMotion,
        )
        clampNodePositionToBounds(node)
      }
      notify()
    },

    setReducedMotion(reduced: boolean): void {
      if (disposed || reducedMotion === reduced) return
      reducedMotion = reduced
      if (reducedMotion) {
        nearestCandidateId = activeDragId ? nearestCandidateId : null
        for (const node of nodes) {
          const target = clampCenterToBounds(
            {
              x: node.x.getState().target,
              y: node.y.getState().target,
            },
            node.size,
            bounds,
          )
          node.x.setTarget(target.x)
          node.y.setTarget(target.y)
          node.x.snap(target.x, 0)
          node.y.snap(target.y, 0)
        }
        restoreOtherNodeBases(activeDragId, true)
      }
      notify()
    },

    step(dtSec: number): DragMergeState {
      if (disposed || !Number.isFinite(dtSec) || dtSec <= 0) {
        return buildState()
      }

      if (reducedMotion) {
        return buildState()
      }

      let changed = false
      for (const node of nodes) {
        const prevX = node.x.getState()
        const prevY = node.y.getState()
        if (!prevX.settled || !prevY.settled) {
          node.x.step(dtSec)
          node.y.step(dtSec)
          clampNodePositionToBounds(node)
          changed = true
        }
      }

      const next = buildState()
      if (changed) {
        notify()
      }
      return next
    },

    getState(): DragMergeState {
      return buildState()
    },

    subscribe(listener: (state: DragMergeState) => void): () => void {
      if (disposed) {
        return () => {}
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose(): void {
      disposed = true
      listeners.clear()
    },
  }
}
