/**
 * Segmented Pill continuous-flow preset for Meniscus.
 *
 * Drives a spring-coupled active indicator pill that smoothly stretches into a
 * two-lobe smin liquid bridge during segment transitions and settles back into
 * a crisp single rounded capsule at rest.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  clamp,
  createSpringChannel,
  lerp,
  type GlassFieldState,
  type GlassPrimitive,
  type Rect,
  type SpringChannel,
  type SpringParams,
} from '@meniscus/core'

/** Layout descriptor for a single selectable segment in the control. */
export interface SegmentItem {
  id: string
  rect: Rect
  radius?: number
}

/** Configuration options for `createSegmentedPillController`. */
export interface SegmentedPillOptions {
  segments: readonly SegmentItem[]
  initialActiveId?: string
  defaultRadius?: number
  leadSpring?: SpringParams
  trailSpring?: SpringParams
  blendK?: number
  squeezeRatio?: number
  maxStretchPx?: number
  reducedMotion?: boolean
}

/** Instantaneous snapshot of the segmented indicator pill and its SDF field. */
export interface SegmentedPillState {
  activeId: string | null
  primitive: GlassPrimitive | null
  field: GlassFieldState
  stretchRatio: number
  isAnimating: boolean
  reducedMotion: boolean
}

/** Interruptible controller driving a continuous-flow segmented glass pill. */
export interface SegmentedPillController {
  setActive(id: string): void
  snapTo(id: string): void
  setSegments(segments: readonly SegmentItem[]): void
  setReducedMotion(reduced: boolean): void
  step(dtSec: number): SegmentedPillState
  getState(): SegmentedPillState
  subscribe(listener: (state: SegmentedPillState) => void): () => void
  dispose(): void
}

/** Default springs and deformation limits for the segmented pill preset. */
export const SEGMENTED_PILL_DEFAULTS = {
  leadSpring: { mass: 1, stiffness: 380, dampingRatio: 0.78 },
  trailSpring: { mass: 1, stiffness: 220, dampingRatio: 0.82 },
  blendK: 18,
  squeezeRatio: 0.12,
  maxStretchPx: 14,
} as const satisfies {
  leadSpring: SpringParams
  trailSpring: SpringParams
  blendK: number
  squeezeRatio: number
  maxStretchPx: number
}

const TRAVEL_EPSILON_PX = 0.25

interface ResolvedSegment {
  id: string
  cx: number
  cy: number
  width: number
  height: number
  radius: number
}

function resolveSegment(item: SegmentItem, fallbackRadius?: number): ResolvedSegment {
  const width = Math.max(0, item.rect.width)
  const height = Math.max(0, item.rect.height)
  const defaultPillRadius = Math.min(width, height) * 0.5
  const rawRadius = item.radius ?? fallbackRadius ?? defaultPillRadius
  const radius = Math.max(0, Math.min(rawRadius, width * 0.5, height * 0.5))
  return {
    id: item.id,
    cx: item.rect.x + width * 0.5,
    cy: item.rect.y + height * 0.5,
    width,
    height,
    radius,
  }
}

function resolveAllSegments(
  items: readonly SegmentItem[],
  fallbackRadius?: number,
): ResolvedSegment[] {
  return items.map((item) => resolveSegment(item, fallbackRadius))
}

function snapChannel(channel: SpringChannel, value: number): void {
  channel.setTarget(value)
  channel.snap(value, 0)
}

function createZeroChannel(params: SpringParams, initialValue: number): SpringChannel {
  return createSpringChannel({
    params,
    initialValue,
    initialTarget: initialValue,
    settlePosEps: 0.05,
    settleVelEps: 0.25,
  })
}

/**
 * Creates an interruptible continuous-flow segmented pill controller.
 */
export function createSegmentedPillController(
  options: SegmentedPillOptions,
): SegmentedPillController {
  const leadSpring = options.leadSpring ?? SEGMENTED_PILL_DEFAULTS.leadSpring
  const trailSpring = options.trailSpring ?? SEGMENTED_PILL_DEFAULTS.trailSpring
  const baseBlendK = Math.max(0, options.blendK ?? SEGMENTED_PILL_DEFAULTS.blendK)
  const squeezeRatio = clamp(options.squeezeRatio ?? SEGMENTED_PILL_DEFAULTS.squeezeRatio, 0, 0.45)
  const maxStretchPx = Math.max(0, options.maxStretchPx ?? SEGMENTED_PILL_DEFAULTS.maxStretchPx)
  const defaultRadius = options.defaultRadius

  let reducedMotion = options.reducedMotion ?? false
  let disposed = false
  let segments = resolveAllSegments(options.segments, defaultRadius)

  function findSegment(id: string | null): ResolvedSegment | null {
    if (!id) return null
    for (const seg of segments) {
      if (seg.id === id) return seg
    }
    return null
  }

  let activeId: string | null =
    findSegment(options.initialActiveId ?? null)?.id ?? segments[0]?.id ?? null

  const initialSeg = findSegment(activeId) ?? {
    id: '',
    cx: 0,
    cy: 0,
    width: 0,
    height: 0,
    radius: 0,
  }

  const leadX = createZeroChannel(leadSpring, initialSeg.cx)
  const leadY = createZeroChannel(leadSpring, initialSeg.cy)
  const leadW = createZeroChannel(leadSpring, initialSeg.width)
  const leadH = createZeroChannel(leadSpring, initialSeg.height)
  const leadR = createZeroChannel(leadSpring, initialSeg.radius)

  const trailX = createZeroChannel(trailSpring, initialSeg.cx)
  const trailY = createZeroChannel(trailSpring, initialSeg.cy)
  const trailW = createZeroChannel(trailSpring, initialSeg.width)
  const trailH = createZeroChannel(trailSpring, initialSeg.height)

  const listeners = new Set<(state: SegmentedPillState) => void>()

  function snapAllChannels(seg: ResolvedSegment): void {
    snapChannel(leadX, seg.cx)
    snapChannel(leadY, seg.cy)
    snapChannel(leadW, seg.width)
    snapChannel(leadH, seg.height)
    snapChannel(leadR, seg.radius)
    snapChannel(trailX, seg.cx)
    snapChannel(trailY, seg.cy)
    snapChannel(trailW, seg.width)
    snapChannel(trailH, seg.height)
  }

  function targetAllChannels(seg: ResolvedSegment): void {
    leadX.setTarget(seg.cx)
    leadY.setTarget(seg.cy)
    leadW.setTarget(seg.width)
    leadH.setTarget(seg.height)
    leadR.setTarget(seg.radius)
    trailX.setTarget(seg.cx)
    trailY.setTarget(seg.cy)
    trailW.setTarget(seg.width)
    trailH.setTarget(seg.height)
  }

  function areAllChannelsSettled(): boolean {
    return (
      leadX.getState().settled &&
      leadY.getState().settled &&
      leadW.getState().settled &&
      leadH.getState().settled &&
      leadR.getState().settled &&
      trailX.getState().settled &&
      trailY.getState().settled &&
      trailW.getState().settled &&
      trailH.getState().settled
    )
  }

  function buildState(): SegmentedPillState {
    if (!activeId || segments.length === 0) {
      return {
        activeId: null,
        primitive: null,
        field: { primitives: [], blendK: 0 },
        stretchRatio: 0,
        isAnimating: false,
        reducedMotion,
      }
    }

    const lx = leadX.getState().value
    const ly = leadY.getState().value
    const lw = Math.max(0, leadW.getState().value)
    const lh = Math.max(0, leadH.getState().value)
    const lr = Math.max(0, Math.min(leadR.getState().value, lw * 0.5, lh * 0.5))

    const tx = trailX.getState().value
    const ty = trailY.getState().value
    const tw = Math.max(0, trailW.getState().value)
    const th = Math.max(0, trailH.getState().value)

    const dx = lx - tx
    const dy = ly - ty
    const rawLagDist = Math.hypot(dx, dy)
    const animating = !reducedMotion && !areAllChannelsSettled()

    if (reducedMotion || (!animating && rawLagDist <= TRAVEL_EPSILON_PX) || rawLagDist <= TRAVEL_EPSILON_PX) {
      const restPrimitive: GlassPrimitive = {
        id: 'segmented-pill',
        center: { x: lx, y: ly },
        size: { width: lw, height: lh },
        radius: lr,
      }
      return {
        activeId,
        primitive: restPrimitive,
        field: {
          primitives: [restPrimitive],
          blendK: 0,
        },
        stretchRatio: 0,
        isAnimating: animating,
        reducedMotion,
      }
    }

    const ux = dx / rawLagDist
    const uy = dy / rawLagDist
    const alongDim = Math.abs(ux) * lw + Math.abs(uy) * lh
    // Cap effective center lag below the overlap + blendK bridge threshold so fast multi-tab jumps never tear apart.
    const stretchCap = Math.min(maxStretchPx, Math.max(0, alongDim * 0.85 + baseBlendK * 0.25))
    const clampedSep =
      stretchCap > 0 ? (stretchCap * rawLagDist) / (stretchCap + rawLagDist) : 0

    const stretchRatio = stretchCap > 0 ? clamp(clampedSep / stretchCap, 0, 1) : 0
    const leadSqueezeX = 1 - squeezeRatio * 0.5 * stretchRatio * Math.abs(uy)
    const leadSqueezeY = 1 - squeezeRatio * 0.5 * stretchRatio * Math.abs(ux)
    const leadStretchX = 1 + squeezeRatio * 0.35 * stretchRatio * Math.abs(ux)
    const leadStretchY = 1 + squeezeRatio * 0.35 * stretchRatio * Math.abs(uy)

    const trailSqueezeX = 1 - squeezeRatio * stretchRatio * Math.abs(uy)
    const trailSqueezeY = 1 - squeezeRatio * stretchRatio * Math.abs(ux)

    const outLeadW = Math.max(0, lw * leadStretchX * leadSqueezeX)
    const outLeadH = Math.max(0, lh * leadStretchY * leadSqueezeY)
    const outTrailW = Math.max(0, tw * trailSqueezeX)
    const outTrailH = Math.max(0, th * trailSqueezeY)

    const leadPrimitive: GlassPrimitive = {
      id: 'segmented-pill-lead',
      center: { x: lx, y: ly },
      size: { width: outLeadW, height: outLeadH },
      radius: Math.max(0, Math.min(lr, outLeadW * 0.5, outLeadH * 0.5)),
    }

    const trailPrimitive: GlassPrimitive = {
      id: 'segmented-pill-trail',
      center: {
        x: lx - ux * clampedSep,
        y: ly - uy * clampedSep,
      },
      size: { width: outTrailW, height: outTrailH },
      radius: Math.max(0, Math.min(lr, outTrailW * 0.5, outTrailH * 0.5)),
    }

    const activeBlendK = baseBlendK * clamp(lerp(0.25, 1, stretchRatio), 0, 1)

    return {
      activeId,
      primitive: leadPrimitive,
      field: {
        primitives: [leadPrimitive, trailPrimitive],
        blendK: activeBlendK,
      },
      stretchRatio,
      isAnimating: true,
      reducedMotion: false,
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
    getState(): SegmentedPillState {
      return buildState()
    },

    setActive(id: string): void {
      if (disposed) return
      const targetSeg = findSegment(id)
      if (!targetSeg) return
      if (activeId === targetSeg.id && areAllChannelsSettled()) return

      activeId = targetSeg.id
      if (reducedMotion) {
        snapAllChannels(targetSeg)
      } else {
        targetAllChannels(targetSeg)
      }
      notify()
    },

    snapTo(id: string): void {
      if (disposed) return
      const targetSeg = findSegment(id)
      if (!targetSeg) return
      activeId = targetSeg.id
      snapAllChannels(targetSeg)
      notify()
    },

    setSegments(nextSegments: readonly SegmentItem[]): void {
      if (disposed) return
      const hadActive = activeId !== null
      segments = resolveAllSegments(nextSegments, defaultRadius)

      if (segments.length === 0) {
        activeId = null
        snapAllChannels({
          id: '',
          cx: 0,
          cy: 0,
          width: 0,
          height: 0,
          radius: 0,
        })
        notify()
        return
      }

      const matched = findSegment(activeId) ?? segments[0]!
      activeId = matched.id

      if (!hadActive || reducedMotion) {
        snapAllChannels(matched)
      } else {
        targetAllChannels(matched)
      }
      notify()
    },

    setReducedMotion(reduced: boolean): void {
      if (disposed || reducedMotion === reduced) return
      reducedMotion = reduced
      if (reducedMotion && activeId) {
        const currentSeg = findSegment(activeId)
        if (currentSeg) {
          snapAllChannels(currentSeg)
        }
      }
      notify()
    },

    step(dtSec: number): SegmentedPillState {
      if (disposed || !Number.isFinite(dtSec) || dtSec <= 0) {
        return buildState()
      }
      if (reducedMotion || areAllChannelsSettled()) {
        return buildState()
      }

      leadX.step(dtSec)
      leadY.step(dtSec)
      leadW.step(dtSec)
      leadH.step(dtSec)
      leadR.step(dtSec)
      trailX.step(dtSec)
      trailY.step(dtSec)
      trailW.step(dtSec)
      trailH.step(dtSec)

      const next = buildState()
      notify()
      return next
    },

    subscribe(listener: (state: SegmentedPillState) => void): () => void {
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
