/**
 * Morphing Popover / Menu preset for Sessile.
 *
 * Computes viewport-clamped placement, spring-coupled open/close/interrupt motion
 * trajectories, synchronized platter/droplet SDF field geometry, and content/glyph
 * transforms without host-specific CSS variable coupling.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_SPRINGS,
  clamp,
  computePairMergeStatus,
  cubicBezier,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  evaluateSpring,
  lerp,
  riseAndFall,
  smoothstep,
  type EdgeInsets,
  type GlassFieldState,
  type GlassPrimitive,
  type MorphTimelinePhase,
  type Point,
  type Rect,
  type Size,
  type SpringParams,
} from '@sessile/core'

export type PopoverMorphPhase = MorphTimelinePhase

export type PopoverPlacement =
  | 'overAnchorEnd'
  | 'overAnchorStart'
  | 'belowPoint'
  | 'abovePoint'

/** Anchor configuration describing the trigger element or point and viewport constraints. */
export interface PopoverAnchorConfig {
  /** Trigger bounds (or click point rect) in the overlay's coordinate space. */
  anchorRect: Rect
  placement: PopoverPlacement
  /** True when the trigger has no resting glass surface (inflates droplet and fades bare glass). */
  bareSource?: boolean
  /** Whether `bareSource` inflates `anchorRect` by bare anchor padding (defaults to `true`). */
  inflateBareAnchor?: boolean
  /**
   * True when the menu settles outside an external trigger button (e.g. Popover):
   * droplet anchors near the trigger, stretches into the smin bridge, pinches off,
   * and returns cleanly to the resting trigger at scale `1.0`.
   */
  externalTrigger?: boolean
  /** Optional rect to avoid when placement is `'belowPoint'` or `'abovePoint'`. */
  avoidRect?: Rect
  /** Container/viewport size in logical CSS pixels for clamping and flip checks. */
  viewportSize: Size
  /** Safe-area insets added to `screenMargin`. */
  safeInsets?: EdgeInsets
}

/** Target popover panel dimensions and corner/placement overrides. */
export interface PopoverPanelConfig {
  /** Measured resting size of the popover panel in logical CSS pixels. */
  size: Size
  /** Optional explicit resting panel rect, bypassing placement calculation. */
  targetRectOverride?: Rect
  itemRadius?: number
  panelInset?: number
  restingRadius?: number
  overlapY?: number
  avoidGap?: number
  screenMargin?: number
  blendK?: number
}

/** Mid-flight geometry snapshot captured when an opening morph is interrupted by close. */
export interface PopoverMorphSnapshot {
  platter: GlassPrimitive
  droplet: GlassPrimitive
  platterRadius: number
  blurPx: number
  elapsedFraction: number
  blendK?: number
}

/** Captured closing-phase origin used to blend geometry continuously on mid-close reopen. */
export interface PopoverReopenOrigin {
  motion: PopoverMotionState
  closeSnapshot: PopoverMorphSnapshot | null
  startElapsedSec: number
  blendDurationSec: number
}

/** Anchored optical values captured on mid-flight reversal to keep transitions continuous. */
export interface PopoverInterruptStart {
  contentOpacity?: number
  contentBlurPx?: number
  triggerGlyphOpacity?: number
  triggerGlyphBlurPx?: number
  bareGlassOpacity?: number
  startNormalizedT?: number
  startSettled?: number
  reopenFrom?: PopoverReopenOrigin
}

/** Options accepted by `evaluatePopoverMotion`. */
export interface EvaluatePopoverMotionOptions {
  hasControlSource?: boolean
  reducedMotion?: boolean
  interruptStart?: PopoverInterruptStart
}

/** Deterministic motion frame state for a morphing popover/menu transition. */
export interface PopoverMotionState {
  phase: PopoverMorphPhase
  hasControlSource: boolean
  elapsedSec: number
  normalizedT: number
  morphProgress: number
  cornerProgress: number
  ringing: number
  absorbed: number
  closeBlendRamp: number
  platterDipEnvelope: number
  dropletOvershootEnvelope: number
  blurBumpPx: number
  settled: number
  contentOpacity: number
  contentBlurPx: number
  triggerGlyphOpacity: number
  triggerGlyphBlurPx: number
  bareGlassOpacity: number
  pointScale: number
  isAnimating: boolean
  reducedMotion: boolean
  reopenFrom?: PopoverReopenOrigin
}

/** Synchronized panel content CSS transform and rounded clip bounds. */
export interface PopoverContentTransform {
  originX: number
  originY: number
  scale: number
  translateX: number
  translateY: number
  clipLeft: number
  clipTop: number
  clipRight: number
  clipBottom: number
  clipRadius: number
}

/** Synchronized trigger glyph transform tied to the morphing droplet. */
export interface PopoverGlyphTransform {
  centerX: number
  centerY: number
  scale: number
}

/** Complete per-frame SDF field, merge metrics, and synchronized DOM transforms. */
export interface PopoverFrameGeometry {
  targetRect: Rect
  targetRadius: number
  platter: GlassPrimitive
  droplet: GlassPrimitive
  blendK: number
  mergeDepth: number
  isMerged: boolean
  rimOpacity: number
  styleMix: number
  field: GlassFieldState
  contentTransform: PopoverContentTransform
  glyphTransform: PopoverGlyphTransform
}

/** Configuration for `createPopoverMorphController`. */
export interface PopoverMorphControllerOptions {
  reducedMotion?: boolean
}

/** Interruptible controller driving a morphing popover/menu transition. */
export interface PopoverMorphController {
  open(hasControlSource?: boolean): void
  close(snapshot?: PopoverMorphSnapshot): void
  reset(toPhase?: 'closed' | 'open'): void
  step(dtSec: number): PopoverMotionState
  seek(
    phase: PopoverMorphPhase,
    normalizedT: number,
    hasControlSource?: boolean,
  ): PopoverMotionState
  setReducedMotion(reduced: boolean): void
  getState(): PopoverMotionState
  getCloseSnapshot(): PopoverMorphSnapshot | null
  evaluateGeometry(
    anchor: PopoverAnchorConfig,
    panel: PopoverPanelConfig,
  ): PopoverFrameGeometry
  subscribe(listener: (state: PopoverMotionState) => void): () => void
  dispose(): void
}

/** Default timing, geometry, and spring constants for morphing popovers and menus. */
export const POPOVER_MORPH_DEFAULTS = {
  openDurationSec: 0.45,
  /** Normalized time at which the opening springs start landing on the resting `open` state. */
  openLandingStart: 0.7,
  closeDurationSec: 0.5,
  pointCloseDurationSec: 0.2,
  reducedMotionDurationSec: 0.15,
  cornerDelaySec: 0.07,
  dropletBlendK: 28,
  mergeRimFadeDepth: 8,
  itemRadius: 16,
  panelInset: 8,
  restingRadius: 24,
  anchorOverlapY: 8,
  avoidGap: 8,
  screenMargin: 16,
  bareAnchorInflateX: 12,
  bareAnchorInflateY: 6,
  bareSourceFadeInSec: 0.1,
  minPlatterScaleRatio: 0.41,
  dropletTargetScale: 0.25,
  pointCloseEndScale: 0.8,
  openCornerWidthFactor: 0.48,
  closeBlendRampSec: 0.05,
  closeRingingStartSec: 0.4,
  closeRingingEndSec: 0.5,
  closeContentOutSec: 0.1,
  closeGlyphBackSec: 0.47,
  closeAbsorptionStart: 0.6,
  closeAbsorptionEnd: 0.9,
  openSettledGlyphEnd: 0.25,
  openGlyphBlurMaxPx: 4,
  openContentBlurBasePx: 4,
  closeContentBlurMaxPx: 8,
  closeGlyphStartOpacity: 0.2,
  openDipPeakSec: 0.098,
  openDipSharpness: 3.3,
  openDipBasePx: 23,
  openDipDyScale: 0.124,
  openDipDyCap: 30,
  openBlurBumpPeakSec: 0.069,
  openBlurBumpSharpness: 2.1,
  openBlurBumpAmpPx: 1.9,
  closePlatterDipPeakSec: 0.072,
  closePlatterDipSharpness: 2.4,
  closePlatterDipRatio: 0.21,
  closePlatterDipCapPx: 22,
  closeDropletOvershootPeakSec: 0.176,
  closeDropletOvershootSharpness: 4.9,
  closeDropletOvershootRatio: 0.25,
  closeDropletOvershootCapPx: 19,
  springs: {
    open: DEFAULT_SPRINGS.standard,
    corners: DEFAULT_SPRINGS.corners,
    droplet: DEFAULT_SPRINGS.soft,
  } satisfies Record<'open' | 'corners' | 'droplet', SpringParams>,
} as const

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  }
}

function rectCenter(rect: Rect): Point {
  return {
    x: rect.x + rect.width * 0.5,
    y: rect.y + rect.height * 0.5,
  }
}

function deflateRect(rect: Rect, inset: number): Rect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - inset * 2,
    height: rect.height - inset * 2,
  }
}

function clampPointToRect(point: Point, rect: Rect): Point {
  return {
    x: clamp(point.x, rect.x, rect.x + rect.width),
    y: clamp(point.y, rect.y, rect.y + rect.height),
  }
}

function normalizeOrZero(v: Point): { dir: Point; len: number } {
  const len = Math.hypot(v.x, v.y)
  if (len <= 1e-5) {
    return { dir: { x: 0, y: 0 }, len: 0 }
  }
  return { dir: { x: v.x / len, y: v.y / len }, len }
}

function beyondRound(size: Size): { w: number; h: number } {
  return {
    w: Math.max(0, size.width - size.height),
    h: Math.max(0, size.height - size.width),
  }
}

function externalTugEnvelope(progress: number): number {
  const u = clamp(progress, 0, 1)
  if (u <= 0 || u >= 1) return 0
  return Math.pow(u / 0.35, 1.4) * Math.pow((1 - u) / 0.65, 2.6)
}

function getEffectiveAnchorRect(anchor: PopoverAnchorConfig): Rect {
  const rect = anchor.anchorRect
  if (!anchor.bareSource || anchor.inflateBareAnchor === false) {
    return rect
  }
  const ix = POPOVER_MORPH_DEFAULTS.bareAnchorInflateX
  const iy = POPOVER_MORPH_DEFAULTS.bareAnchorInflateY
  return {
    x: rect.x - ix,
    y: rect.y - iy,
    width: rect.width + ix * 2,
    height: rect.height + iy * 2,
  }
}

function resolveRestingRadius(panel: PopoverPanelConfig): number {
  if (panel.restingRadius !== undefined) {
    return panel.restingRadius
  }
  if (panel.itemRadius !== undefined || panel.panelInset !== undefined) {
    return (
      (panel.itemRadius ?? POPOVER_MORPH_DEFAULTS.itemRadius) +
      (panel.panelInset ?? POPOVER_MORPH_DEFAULTS.panelInset)
    )
  }
  return POPOVER_MORPH_DEFAULTS.restingRadius
}

/**
 * Computes the resting popover panel rect for the requested placement mode,
 * flipping vertically when space is constrained and clamping inside `viewportSize`
 * minus `screenMargin + safeInsets`.
 */
export function computePopoverTargetRect(
  anchor: PopoverAnchorConfig,
  panel: PopoverPanelConfig,
): Rect {
  if (panel.targetRectOverride) {
    return { ...panel.targetRectOverride }
  }

  const panelW = Math.max(0, panel.size.width)
  const panelH = Math.max(0, panel.size.height)
  const overlapY = panel.overlapY ?? POPOVER_MORPH_DEFAULTS.anchorOverlapY
  const avoidGap = panel.avoidGap ?? POPOVER_MORPH_DEFAULTS.avoidGap
  const screenMargin = panel.screenMargin ?? POPOVER_MORPH_DEFAULTS.screenMargin
  const safe = anchor.safeInsets ?? { top: 0, right: 0, bottom: 0, left: 0 }

  const minX = screenMargin + safe.left
  const maxX = anchor.viewportSize.width - screenMargin - safe.right - panelW
  const minY = screenMargin + safe.top
  const maxBottom = anchor.viewportSize.height - screenMargin - safe.bottom
  const maxY = maxBottom - panelH

  const a = anchor.anchorRect
  let rawX = a.x
  let rawY = a.y

  if (anchor.placement === 'overAnchorEnd') {
    rawX = a.x + a.width - panelW
    rawY = a.y - overlapY
  } else if (anchor.placement === 'overAnchorStart') {
    rawX = a.x
    rawY = a.y - overlapY
  } else if (anchor.placement === 'abovePoint') {
    rawX = a.x
    const refRect = anchor.avoidRect ?? a
    const aboveY = refRect.y - avoidGap - panelH
    const belowY = refRect.y + refRect.height + avoidGap
    if (aboveY >= minY) {
      rawY = aboveY
    } else {
      const spaceAbove = refRect.y - avoidGap - minY
      const spaceBelow = maxBottom - belowY
      rawY = spaceBelow >= panelH || spaceBelow >= spaceAbove ? belowY : aboveY
    }
  } else {
    rawX = a.x
    const refRect = anchor.avoidRect ?? a
    const belowY = refRect.y + refRect.height + avoidGap
    const aboveY = refRect.y - avoidGap - panelH
    if (belowY + panelH <= maxBottom) {
      rawY = belowY
    } else {
      const spaceBelow = maxBottom - belowY
      const spaceAbove = refRect.y - avoidGap - minY
      rawY = spaceAbove >= panelH || spaceAbove >= spaceBelow ? aboveY : belowY
    }
  }

  return {
    x: clamp(rawX, minX, maxX),
    y: clamp(rawY, minY, maxY),
    width: panelW,
    height: panelH,
  }
}

/** Returns the transition duration in seconds for the given phase and capabilities. */
export function getPopoverPhaseDurationSec(
  phase: PopoverMorphPhase,
  hasControlSource = true,
  reducedMotion = false,
): number {
  if (phase === 'closed' || phase === 'open') {
    return 0
  }
  if (reducedMotion) {
    return POPOVER_MORPH_DEFAULTS.reducedMotionDurationSec
  }
  if (phase === 'opening') {
    return POPOVER_MORPH_DEFAULTS.openDurationSec
  }
  return hasControlSource
    ? POPOVER_MORPH_DEFAULTS.closeDurationSec
    : POPOVER_MORPH_DEFAULTS.pointCloseDurationSec
}

/**
 * Pure deterministic motion evaluator for any popover phase and normalized progress in `[0, 1]`.
 */
export function evaluatePopoverMotion(
  phase: PopoverMorphPhase,
  normalizedT: number,
  options: EvaluatePopoverMotionOptions = {},
): PopoverMotionState {
  const hasControlSource = options.hasControlSource ?? true
  const reducedMotion = options.reducedMotion ?? false
  const u = clamp(Number.isFinite(normalizedT) ? normalizedT : 0, 0, 1)

  if (phase === 'closed') {
    return {
      phase: 'closed',
      hasControlSource,
      elapsedSec: 0,
      normalizedT: 0,
      morphProgress: 1,
      cornerProgress: 1,
      ringing: 0,
      absorbed: 1,
      closeBlendRamp: 1,
      platterDipEnvelope: 0,
      dropletOvershootEnvelope: 0,
      blurBumpPx: 0,
      settled: 0,
      contentOpacity: 0,
      contentBlurPx: 0,
      triggerGlyphOpacity: 1,
      triggerGlyphBlurPx: 0,
      bareGlassOpacity: 0,
      pointScale: 1,
      isAnimating: false,
      reducedMotion,
    }
  }

  if (phase === 'open') {
    return {
      phase: 'open',
      hasControlSource,
      elapsedSec: getPopoverPhaseDurationSec('opening', hasControlSource, reducedMotion),
      normalizedT: 1,
      morphProgress: 1,
      cornerProgress: 0,
      ringing: 0,
      absorbed: 0,
      closeBlendRamp: 0,
      platterDipEnvelope: 0,
      dropletOvershootEnvelope: 0,
      blurBumpPx: 0,
      settled: 1,
      contentOpacity: 1,
      contentBlurPx: 0,
      triggerGlyphOpacity: 0,
      triggerGlyphBlurPx: reducedMotion ? 0 : POPOVER_MORPH_DEFAULTS.openGlyphBlurMaxPx,
      bareGlassOpacity: 1,
      pointScale: 1,
      isAnimating: false,
      reducedMotion,
    }
  }

  if (phase === 'opening') {
    const duration = getPopoverPhaseDurationSec('opening', hasControlSource, reducedMotion)
    const elapsedSec = u * duration
    const interrupt = options.interruptStart

    if (reducedMotion) {
      const fade = easeOutCubic(u)
      let settled = fade
      let contentOpacity = fade
      let triggerGlyphOpacity = 1 - fade
      let bareGlassOpacity = fade
      if (interrupt) {
        const startU = clamp(interrupt.startNormalizedT ?? 0, 0, 1 - 1e-6)
        const remT = clamp((u - startU) / (1 - startU), 0, 1)
        const ramp = easeOutCubic(remT)
        settled = lerp(interrupt.startSettled ?? fade, 1, ramp)
        contentOpacity = lerp(interrupt.contentOpacity ?? fade, 1, ramp)
        triggerGlyphOpacity = lerp(interrupt.triggerGlyphOpacity ?? 1 - fade, 0, ramp)
        bareGlassOpacity = lerp(interrupt.bareGlassOpacity ?? fade, 1, ramp)
      }
      return {
        phase: 'opening',
        hasControlSource,
        elapsedSec,
        normalizedT: u,
        morphProgress: 1,
        cornerProgress: 0,
        ringing: 0,
        absorbed: 0,
        closeBlendRamp: 0,
        platterDipEnvelope: 0,
        dropletOvershootEnvelope: 0,
        blurBumpPx: 0,
        settled,
        contentOpacity,
        contentBlurPx: 0,
        triggerGlyphOpacity,
        triggerGlyphBlurPx: 0,
        bareGlassOpacity,
        pointScale: 1,
        isAnimating: u < 1,
        reducedMotion: true,
      }
    }

    // The springs still ring at `openDurationSec` (corners about 1.3px short on a 360px panel),
    // so their residuals fade out over the tail: the last opening frame is the `open` state and
    // the hand-off to the resting surface has no step.
    const landing = 1 - smoothstep(POPOVER_MORPH_DEFAULTS.openLandingStart, 1, u)
    const morphProgress = lerp(1, evaluateSpring(elapsedSec, POPOVER_MORPH_DEFAULTS.springs.open), landing)
    const cornerDelay = POPOVER_MORPH_DEFAULTS.cornerDelaySec
    const cornerProgress =
      elapsedSec <= cornerDelay
        ? 1
        : lerp(
            0,
            1 - evaluateSpring(elapsedSec - cornerDelay, POPOVER_MORPH_DEFAULTS.springs.corners),
            landing,
          )
    const platterDipEnvelope = hasControlSource
      ? lerp(
          0,
          riseAndFall(elapsedSec, POPOVER_MORPH_DEFAULTS.openDipPeakSec, POPOVER_MORPH_DEFAULTS.openDipSharpness),
          landing,
        )
      : 0
    const blurBumpPx = lerp(
      0,
      POPOVER_MORPH_DEFAULTS.openBlurBumpAmpPx *
        riseAndFall(
          elapsedSec,
          POPOVER_MORPH_DEFAULTS.openBlurBumpPeakSec,
          POPOVER_MORPH_DEFAULTS.openBlurBumpSharpness,
        ),
      landing,
    )
    const settled = clamp(morphProgress, 0, 1)
    const glyphT = clamp(settled / POPOVER_MORPH_DEFAULTS.openSettledGlyphEnd, 0, 1)
    const normalContentBlurPx = Math.hypot(
      POPOVER_MORPH_DEFAULTS.openContentBlurBasePx * (1 - settled),
      blurBumpPx,
    )
    const normalBareGlassOpacity = clamp(
      elapsedSec / POPOVER_MORPH_DEFAULTS.bareSourceFadeInSec,
      0,
      1,
    )

    let contentOpacity = settled
    let contentBlurPx = normalContentBlurPx
    let triggerGlyphOpacity = 1 - glyphT
    let triggerGlyphBlurPx = POPOVER_MORPH_DEFAULTS.openGlyphBlurMaxPx * glyphT
    let bareGlassOpacity = normalBareGlassOpacity

    if (interrupt) {
      const startSettled = clamp(interrupt.startSettled ?? 0, 0, 0.999)
      const settledRamp = clamp((settled - startSettled) / (1 - startSettled), 0, 1)
      contentOpacity = lerp(interrupt.contentOpacity ?? settled, 1, settledRamp)
      contentBlurPx = lerp(
        interrupt.contentBlurPx ?? normalContentBlurPx,
        normalContentBlurPx,
        settledRamp,
      )
      const glyphSpan = Math.max(
        1e-4,
        Math.min(POPOVER_MORPH_DEFAULTS.openSettledGlyphEnd, 1 - startSettled),
      )
      const interruptGlyphT = clamp((settled - startSettled) / glyphSpan, 0, 1)
      triggerGlyphOpacity = lerp(interrupt.triggerGlyphOpacity ?? 1, 0, interruptGlyphT)
      triggerGlyphBlurPx = lerp(
        interrupt.triggerGlyphBlurPx ?? 0,
        POPOVER_MORPH_DEFAULTS.openGlyphBlurMaxPx,
        interruptGlyphT,
      )
      const startElapsedSec = clamp(interrupt.startNormalizedT ?? 0, 0, 1) * duration
      const bareRamp = clamp(
        (elapsedSec - startElapsedSec) / POPOVER_MORPH_DEFAULTS.bareSourceFadeInSec,
        0,
        1,
      )
      bareGlassOpacity = lerp(interrupt.bareGlassOpacity ?? normalBareGlassOpacity, 1, bareRamp)
    }

    return {
      phase: 'opening',
      hasControlSource,
      elapsedSec,
      normalizedT: u,
      morphProgress,
      cornerProgress,
      ringing: 0,
      absorbed: 0,
      closeBlendRamp: 0,
      platterDipEnvelope,
      dropletOvershootEnvelope: 0,
      blurBumpPx,
      settled,
      contentOpacity,
      contentBlurPx,
      triggerGlyphOpacity,
      triggerGlyphBlurPx,
      bareGlassOpacity,
      pointScale: 1,
      isAnimating: u < 1,
      reducedMotion: false,
      reopenFrom: interrupt?.reopenFrom,
    }
  }

  const duration = getPopoverPhaseDurationSec('closing', hasControlSource, reducedMotion)
  const elapsedSec = u * duration
  const startContentOpacity = options.interruptStart?.contentOpacity ?? 1
  const startContentBlurPx = options.interruptStart?.contentBlurPx ?? 0
  const startBareGlassOpacity = options.interruptStart?.bareGlassOpacity ?? 1

  if (reducedMotion) {
    const fade = easeOutCubic(u)
    const startGlyphOpacity = options.interruptStart?.triggerGlyphOpacity ?? 0
    return {
      phase: 'closing',
      hasControlSource,
      elapsedSec,
      normalizedT: u,
      morphProgress: 0,
      cornerProgress: 0,
      ringing: 0,
      absorbed: 1,
      closeBlendRamp: 0,
      platterDipEnvelope: 0,
      dropletOvershootEnvelope: 0,
      blurBumpPx: 0,
      settled: 1 - fade,
      contentOpacity: startContentOpacity * (1 - fade),
      contentBlurPx: 0,
      triggerGlyphOpacity: lerp(startGlyphOpacity, 1, fade),
      triggerGlyphBlurPx: 0,
      bareGlassOpacity: startBareGlassOpacity * (1 - fade),
      pointScale: 1,
      isAnimating: u < 1,
      reducedMotion: true,
    }
  }

  if (!hasControlSource) {
    const eased = easeOutCubic(u)
    return {
      phase: 'closing',
      hasControlSource: false,
      elapsedSec,
      normalizedT: u,
      morphProgress: eased,
      cornerProgress: 0,
      ringing: 0,
      absorbed: eased,
      closeBlendRamp: 0,
      platterDipEnvelope: 0,
      dropletOvershootEnvelope: 0,
      blurBumpPx: 0,
      settled: 1 - eased,
      contentOpacity: startContentOpacity * (1 - eased),
      contentBlurPx: 0,
      triggerGlyphOpacity: 1,
      triggerGlyphBlurPx: 0,
      bareGlassOpacity: startBareGlassOpacity * (1 - eased),
      pointScale: lerp(1, POPOVER_MORPH_DEFAULTS.pointCloseEndScale, eased),
      isAnimating: u < 1,
      reducedMotion: false,
    }
  }

  const ringingSpan =
    POPOVER_MORPH_DEFAULTS.closeRingingEndSec - POPOVER_MORPH_DEFAULTS.closeRingingStartSec
  const ringing =
    1 -
    easeInQuad(
      clamp((elapsedSec - POPOVER_MORPH_DEFAULTS.closeRingingStartSec) / ringingSpan, 0, 1),
    )
  const dropletSpring = evaluateSpring(elapsedSec, POPOVER_MORPH_DEFAULTS.springs.droplet)
  const morphProgress = 1 + (dropletSpring - 1) * ringing
  const closeBlendRamp = clamp(elapsedSec / POPOVER_MORPH_DEFAULTS.closeBlendRampSec, 0, 1)
  const absStartSec = POPOVER_MORPH_DEFAULTS.closeAbsorptionStart * duration
  const absSpanSec =
    (POPOVER_MORPH_DEFAULTS.closeAbsorptionEnd - POPOVER_MORPH_DEFAULTS.closeAbsorptionStart) *
    duration
  const absorbed = easeInOutCubic(clamp((elapsedSec - absStartSec) / absSpanSec, 0, 1))
  const platterDipEnvelope =
    riseAndFall(
      elapsedSec,
      POPOVER_MORPH_DEFAULTS.closePlatterDipPeakSec,
      POPOVER_MORPH_DEFAULTS.closePlatterDipSharpness,
    ) * ringing
  const dropletOvershootEnvelope =
    riseAndFall(
      elapsedSec,
      POPOVER_MORPH_DEFAULTS.closeDropletOvershootPeakSec,
      POPOVER_MORPH_DEFAULTS.closeDropletOvershootSharpness,
    ) * ringing

  const contentOut = easeOutCubic(
    clamp(elapsedSec / POPOVER_MORPH_DEFAULTS.closeContentOutSec, 0, 1),
  )
  const startGlyphOpacity =
    options.interruptStart?.triggerGlyphOpacity ?? POPOVER_MORPH_DEFAULTS.closeGlyphStartOpacity
  const glyphCurveT = cubicBezier(
    0.25,
    0.1,
    0.25,
    1,
    clamp(elapsedSec / POPOVER_MORPH_DEFAULTS.closeGlyphBackSec, 0, 1),
  )

  return {
    phase: 'closing',
    hasControlSource: true,
    elapsedSec,
    normalizedT: u,
    morphProgress,
    cornerProgress: 0,
    ringing,
    absorbed,
    closeBlendRamp,
    platterDipEnvelope,
    dropletOvershootEnvelope,
    blurBumpPx: 0,
    settled: clamp(1 - morphProgress, 0, 1),
    contentOpacity: startContentOpacity * (1 - contentOut),
    contentBlurPx: lerp(startContentBlurPx, POPOVER_MORPH_DEFAULTS.closeContentBlurMaxPx, contentOut),
    triggerGlyphOpacity: lerp(startGlyphOpacity, 1, glyphCurveT),
    triggerGlyphBlurPx: 0,
    bareGlassOpacity: startBareGlassOpacity * (1 - absorbed),
    pointScale: 1,
    isAnimating: u < 1,
    reducedMotion: false,
  }
}

function computeDropletRestingTarget(
  anchorCenter: Point,
  panelCenter: Point,
  targetRect: Rect,
  anchorLongest: number,
  blendK: number,
): Point {
  const deflateInset =
    anchorLongest * 0.125 + blendK + POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth
  const deflated = deflateRect(targetRect, deflateInset)
  if (deflated.width <= 0 || deflated.height <= 0) {
    return panelCenter
  }
  const biasPoint = lerpPoint(
    anchorCenter,
    panelCenter,
    POPOVER_MORPH_DEFAULTS.dropletTargetScale,
  )
  return clampPointToRect(biasPoint, deflated)
}

function computeContentTransform(
  platter: GlassPrimitive,
  targetRect: Rect,
): PopoverContentTransform {
  const panelCenter = rectCenter(targetRect)
  const scale = targetRect.width > 0 ? platter.size.width / targetRect.width : 1
  const halfW = platter.size.width * 0.5
  const halfH = platter.size.height * 0.5

  return {
    originX: targetRect.width * 0.5,
    originY: targetRect.height * 0.5,
    scale,
    translateX: platter.center.x - panelCenter.x,
    translateY: platter.center.y - panelCenter.y,
    clipLeft: platter.center.x - halfW,
    clipTop: platter.center.y - halfH,
    clipRight: platter.center.x + halfW,
    clipBottom: platter.center.y + halfH,
    clipRadius: platter.radius,
  }
}

function computeGlyphTransform(
  droplet: GlassPrimitive,
  effectiveAnchor: Rect,
  externalTrigger: boolean,
): PopoverGlyphTransform {
  let scale = 0
  if (effectiveAnchor.width > 0) {
    scale =
      externalTrigger && effectiveAnchor.height > 0
        ? Math.min(
            droplet.size.width / effectiveAnchor.width,
            droplet.size.height / effectiveAnchor.height,
          )
        : droplet.size.width / effectiveAnchor.width
  }
  return {
    centerX: droplet.center.x,
    centerY: droplet.center.y,
    scale,
  }
}

/**
 * Evaluates the complete per-frame SDF field, merge metrics, optical style mix,
 * and synchronized DOM content/glyph transforms for a morphing popover/menu.
 */
export function computePopoverMorphGeometry(
  motion: PopoverMotionState,
  anchor: PopoverAnchorConfig,
  panel: PopoverPanelConfig,
  closeSnapshot?: PopoverMorphSnapshot | null,
): PopoverFrameGeometry {
  const targetRect = computePopoverTargetRect(anchor, panel)
  const restingRadius = resolveRestingRadius(panel)
  const targetRadius = Math.max(
    0,
    Math.min(restingRadius, targetRect.width * 0.5, targetRect.height * 0.5),
  )
  const configuredBlendK = panel.blendK ?? POPOVER_MORPH_DEFAULTS.dropletBlendK

  const effectiveAnchor = getEffectiveAnchorRect(anchor)
  const anchorCenter = rectCenter(effectiveAnchor)
  const panelCenter = rectCenter(targetRect)
  const anchorShortest = Math.min(effectiveAnchor.width, effectiveAnchor.height)
  const anchorLongest = Math.max(effectiveAnchor.width, effectiveAnchor.height)
  const beyond = beyondRound({
    width: effectiveAnchor.width,
    height: effectiveAnchor.height,
  })

  const openDropletTarget = computeDropletRestingTarget(
    anchorCenter,
    panelCenter,
    targetRect,
    anchorLongest,
    configuredBlendK,
  )

  let platter: GlassPrimitive
  let droplet: GlassPrimitive
  let blendK: number
  let styleMix: number
  let mergeDepth: number
  let isMerged: boolean
  let rimOpacity: number

  if (motion.reducedMotion && (motion.phase === 'opening' || motion.phase === 'closing')) {
    platter = {
      id: 'platter',
      center: panelCenter,
      size: { width: targetRect.width, height: targetRect.height },
      radius: targetRadius,
    }
    droplet = motion.hasControlSource
      ? {
          id: 'droplet',
          center: anchorCenter,
          size: { width: effectiveAnchor.width, height: effectiveAnchor.height },
          radius: Math.min(effectiveAnchor.width, effectiveAnchor.height) * 0.5,
        }
      : {
          id: 'droplet',
          center: clampPointToRect(anchorCenter, targetRect),
          size: { width: 0, height: 0 },
          radius: 0,
        }
    blendK = 0
    styleMix = 1
    mergeDepth = POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth
    isMerged = !anchor.externalTrigger || !motion.hasControlSource
    rimOpacity = 1
  } else if (motion.phase === 'opening' || motion.phase === 'open') {
    const progress = motion.phase === 'open' ? 1 : motion.morphProgress
    const panelW = targetRect.width
    const panelH = targetRect.height
    const scale =
      panelW > 0
        ? lerp((POPOVER_MORPH_DEFAULTS.minPlatterScaleRatio * anchorShortest) / panelW, 1, progress)
        : 1
    const height = lerp(panelW, panelH, progress)
    const beyondWeight = clamp(1 - progress, 0, 1)

    const platterW = Math.max(0, panelW * scale + beyond.w * beyondWeight)
    const platterH = Math.max(0, height * scale + beyond.h * beyondWeight)

    const dy = panelCenter.y - anchorCenter.y
    const absDy = Math.abs(dy)
    const dip =
      motion.hasControlSource && absDy > 1e-5
        ? Math.sign(dy) *
          (Math.min(1, absDy / POPOVER_MORPH_DEFAULTS.openDipDyCap) *
            POPOVER_MORPH_DEFAULTS.openDipBasePx +
            POPOVER_MORPH_DEFAULTS.openDipDyScale * absDy) *
          motion.platterDipEnvelope
        : 0

    const baseCenter = lerpPoint(anchorCenter, panelCenter, progress)
    const platterCenter = {
      x: baseCenter.x,
      y: baseCenter.y + dip,
    }

    const corners =
      restingRadius +
      panelW * POPOVER_MORPH_DEFAULTS.openCornerWidthFactor * motion.cornerProgress
    const platterRadius = Math.max(
      0,
      Math.min(Math.min(height * 0.5, corners) * scale, platterW * 0.5, platterH * 0.5),
    )

    platter = {
      id: 'platter',
      center: platterCenter,
      size: { width: platterW, height: platterH },
      radius: platterRadius,
    }

    if (motion.hasControlSource) {
      if (anchor.externalTrigger) {
        const dropletProgress = clamp(progress, 0, 1)
        const tug = motion.phase === 'open' ? 0 : externalTugEnvelope(dropletProgress)
        const { dir: towardPanel, len: distToPanel } = normalizeOrZero({
          x: panelCenter.x - anchorCenter.x,
          y: panelCenter.y - anchorCenter.y,
        })
        const tugDist = Math.min(22, distToPanel * 0.22) * tug
        const stretchW = 1 + (0.1 * Math.abs(towardPanel.x) - 0.05 * Math.abs(towardPanel.y)) * tug
        const stretchH = 1 + (0.1 * Math.abs(towardPanel.y) - 0.05 * Math.abs(towardPanel.x)) * tug
        const dropletW = Math.max(0, effectiveAnchor.width * stretchW)
        const dropletH = Math.max(0, effectiveAnchor.height * stretchH)
        droplet = {
          id: 'droplet',
          center: {
            x: anchorCenter.x + towardPanel.x * tugDist,
            y: anchorCenter.y + towardPanel.y * tugDist,
          },
          size: { width: dropletW, height: dropletH },
          radius: Math.min(dropletW, dropletH) * 0.5,
        }
        const pinch = motion.phase === 'open' ? 0 : 1 - smoothstep(0.38, 0.68, dropletProgress)
        blendK = configuredBlendK * pinch
        styleMix = clamp(progress, 0, 1)
        isMerged = false
        rimOpacity = motion.phase === 'open' ? 1 : smoothstep(0.35, 0.72, dropletProgress)
        mergeDepth =
          motion.phase === 'open'
            ? POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth
            : computePairMergeStatus(
                platter,
                droplet,
                blendK,
                POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth,
              ).mergeDepth
      } else {
        const dropletProgress = clamp(progress, 0, 1)
        const dropletScale = lerp(1, POPOVER_MORPH_DEFAULTS.dropletTargetScale, dropletProgress)
        const dropletW = Math.max(0, effectiveAnchor.width * dropletScale)
        const dropletH = Math.max(0, effectiveAnchor.height * dropletScale)
        droplet = {
          id: 'droplet',
          center: lerpPoint(anchorCenter, openDropletTarget, dropletProgress),
          size: { width: dropletW, height: dropletH },
          radius: Math.min(dropletW, dropletH) * 0.5,
        }
        blendK = configuredBlendK
        styleMix = clamp(progress, 0, 1)

        const merge = computePairMergeStatus(
          platter,
          droplet,
          blendK,
          POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth,
        )
        mergeDepth = merge.mergeDepth
        isMerged = merge.isMerged
        rimOpacity = merge.rimOpacity
      }
    } else {
      droplet = {
        id: 'droplet',
        center: anchorCenter,
        size: { width: 0, height: 0 },
        radius: 0,
      }
      blendK = 0
      styleMix = 1
      mergeDepth = POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth
      isMerged = true
      rimOpacity = 1
    }
  } else if (!motion.hasControlSource) {
    // Point-anchored close fallback: uniform shrink from current bounds toward clamped anchor point.
    const fromPlatter: GlassPrimitive = closeSnapshot?.platter ?? {
      id: 'platter',
      center: panelCenter,
      size: { width: targetRect.width, height: targetRect.height },
      radius: targetRadius,
    }
    const fromRadius = closeSnapshot?.platterRadius ?? targetRadius
    const pointScale =
      motion.phase === 'closed' ? POPOVER_MORPH_DEFAULTS.pointCloseEndScale : motion.pointScale
    const pivot = clampPointToRect(anchorCenter, targetRect)
    const platterW = Math.max(0, fromPlatter.size.width * pointScale)
    const platterH = Math.max(0, fromPlatter.size.height * pointScale)
    platter = {
      id: 'platter',
      center: {
        x: pivot.x + (fromPlatter.center.x - pivot.x) * pointScale,
        y: pivot.y + (fromPlatter.center.y - pivot.y) * pointScale,
      },
      size: {
        width: platterW,
        height: platterH,
      },
      radius: Math.max(0, Math.min(fromRadius * pointScale, platterW * 0.5, platterH * 0.5)),
    }
    droplet = {
      id: 'droplet',
      center: pivot,
      size: { width: 0, height: 0 },
      radius: 0,
    }
    blendK = 0
    styleMix = 1
    mergeDepth = POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth
    isMerged = true
    rimOpacity = 1
  } else {
    // Control-anchored close (or resting closed state).
    const openDropletW = effectiveAnchor.width * POPOVER_MORPH_DEFAULTS.dropletTargetScale
    const openDropletH = effectiveAnchor.height * POPOVER_MORPH_DEFAULTS.dropletTargetScale
    const fromPlatter: GlassPrimitive = closeSnapshot?.platter ?? {
      id: 'platter',
      center: panelCenter,
      size: { width: targetRect.width, height: targetRect.height },
      radius: targetRadius,
    }
    const defaultDroplet: GlassPrimitive = anchor.externalTrigger
      ? {
          id: 'droplet',
          center: anchorCenter,
          size: { width: effectiveAnchor.width, height: effectiveAnchor.height },
          radius: Math.min(effectiveAnchor.width, effectiveAnchor.height) * 0.5,
        }
      : {
          id: 'droplet',
          center: openDropletTarget,
          size: { width: openDropletW, height: openDropletH },
          radius: Math.min(openDropletW, openDropletH) * 0.5,
        }
    const fromDroplet: GlassPrimitive = closeSnapshot?.droplet ?? defaultDroplet
    const fromRadius = closeSnapshot?.platterRadius ?? targetRadius

    const progress = motion.phase === 'closed' ? 1 : motion.morphProgress
    const fromW = fromPlatter.size.width
    const fromH = fromPlatter.size.height
    const fromMaxDim = Math.max(fromW, fromH)

    const scale =
      fromMaxDim > 0
        ? lerp(
            1,
            (POPOVER_MORPH_DEFAULTS.minPlatterScaleRatio * anchorShortest) / fromMaxDim,
            progress,
          )
        : 0
    const height = lerp(fromH, fromW, progress)
    const beyondWeight = clamp(progress, 0, 1)

    const platterW = Math.max(0, fromW * scale + beyond.w * beyondWeight)
    const platterH = Math.max(0, height * scale + beyond.h * beyondWeight)

    const toPanel = {
      x: fromPlatter.center.x - anchorCenter.x,
      y: fromPlatter.center.y - anchorCenter.y,
    }
    const { dir: awayFromAnchor, len: toPanelLen } = normalizeOrZero(toPanel)

    const dipMag =
      Math.min(
        POPOVER_MORPH_DEFAULTS.closePlatterDipRatio * toPanelLen,
        POPOVER_MORPH_DEFAULTS.closePlatterDipCapPx,
      ) * motion.platterDipEnvelope
    const basePlatterCenter = lerpPoint(fromPlatter.center, anchorCenter, progress)
    const platterCenter = {
      x: basePlatterCenter.x + awayFromAnchor.x * dipMag,
      y: basePlatterCenter.y + awayFromAnchor.y * dipMag,
    }
    const platterRadius = Math.max(
      0,
      Math.min(lerp(fromRadius, fromW * 0.5, progress) * scale, platterW * 0.5, platterH * 0.5),
    )

    platter = {
      id: 'platter',
      center: platterCenter,
      size: { width: platterW, height: platterH },
      radius: platterRadius,
    }

    const dropletSizeT = clamp(progress, 0, 1)
    const overshootMag =
      Math.min(
        POPOVER_MORPH_DEFAULTS.closeDropletOvershootRatio * toPanelLen,
        POPOVER_MORPH_DEFAULTS.closeDropletOvershootCapPx,
      ) * motion.dropletOvershootEnvelope

    if (anchor.externalTrigger) {
      const catchT = clamp(dropletSizeT / 0.65, 0, 1)
      const catchSin = Math.sin(Math.PI * catchT)
      const catchBell = motion.phase === 'closed' ? 0 : catchSin * catchSin
      const catchMag = Math.min(18, toPanelLen * 0.16) * catchBell
      const stretchW =
        1 + (0.06 * Math.abs(awayFromAnchor.x) - 0.04 * Math.abs(awayFromAnchor.y)) * catchBell
      const stretchH =
        1 + (0.06 * Math.abs(awayFromAnchor.y) - 0.04 * Math.abs(awayFromAnchor.x)) * catchBell
      const targetW = effectiveAnchor.width * stretchW
      const targetH = effectiveAnchor.height * stretchH
      const dropletW = Math.max(0, lerp(fromDroplet.size.width, targetW, dropletSizeT))
      const dropletH = Math.max(0, lerp(fromDroplet.size.height, targetH, dropletSizeT))
      const baseDropletCenter = lerpPoint(fromDroplet.center, anchorCenter, dropletSizeT)
      droplet = {
        id: 'droplet',
        center: {
          x: baseDropletCenter.x + awayFromAnchor.x * (catchMag - overshootMag),
          y: baseDropletCenter.y + awayFromAnchor.y * (catchMag - overshootMag),
        },
        size: { width: dropletW, height: dropletH },
        radius: Math.min(dropletW, dropletH) * 0.5,
      }
    } else {
      const dropletW = Math.max(0, lerp(fromDroplet.size.width, effectiveAnchor.width, dropletSizeT))
      const dropletH = Math.max(
        0,
        lerp(fromDroplet.size.height, effectiveAnchor.height, dropletSizeT),
      )
      const baseDropletCenter = lerpPoint(fromDroplet.center, anchorCenter, progress)

      droplet = {
        id: 'droplet',
        center: {
          x: baseDropletCenter.x - awayFromAnchor.x * overshootMag,
          y: baseDropletCenter.y - awayFromAnchor.y * overshootMag,
        },
        size: { width: dropletW, height: dropletH },
        radius: Math.min(dropletW, dropletH) * 0.5,
      }
    }

    const startBlendK = closeSnapshot?.blendK ?? 0
    blendK =
      motion.phase === 'closed'
        ? 0
        : lerp(startBlendK, configuredBlendK, motion.closeBlendRamp) * (1 - motion.absorbed)

    const minClosedW = POPOVER_MORPH_DEFAULTS.minPlatterScaleRatio * anchorShortest
    const startMix = closeSnapshot
      ? clamp((fromW - minClosedW) / Math.max(1, targetRect.width - minClosedW), 0, 1)
      : 1
    styleMix = motion.phase === 'closed' ? 0 : startMix * (1 - clamp(progress, 0, 1))

    if (anchor.externalTrigger) {
      isMerged = false
      mergeDepth = computePairMergeStatus(
        platter,
        droplet,
        blendK,
        POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth,
      ).mergeDepth
      rimOpacity =
        motion.phase === 'closed' ? 0 : startMix * (1 - smoothstep(0, 0.45, dropletSizeT))
    } else {
      const merge = computePairMergeStatus(
        platter,
        droplet,
        blendK,
        POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth,
      )
      mergeDepth = merge.mergeDepth
      isMerged = merge.isMerged
      rimOpacity = merge.rimOpacity
    }
  }

  if (motion.phase === 'opening' && motion.reopenFrom) {
    const reopen = motion.reopenFrom
    const blendT = clamp(
      (motion.elapsedSec - reopen.startElapsedSec) / Math.max(1e-4, reopen.blendDurationSec),
      0,
      1,
    )
    const blend = smoothstep(0, 1, blendT)
    if (blend < 1) {
      const originGeom = computePopoverMorphGeometry(
        reopen.motion,
        anchor,
        panel,
        reopen.closeSnapshot,
      )
      if (blend <= 0) {
        return originGeom
      }
      const nextPlatterW = Math.max(0, lerp(originGeom.platter.size.width, platter.size.width, blend))
      const nextPlatterH = Math.max(0, lerp(originGeom.platter.size.height, platter.size.height, blend))
      platter = {
        id: 'platter',
        center: lerpPoint(originGeom.platter.center, platter.center, blend),
        size: { width: nextPlatterW, height: nextPlatterH },
        radius: Math.max(
          0,
          Math.min(
            lerp(originGeom.platter.radius, platter.radius, blend),
            nextPlatterW * 0.5,
            nextPlatterH * 0.5,
          ),
        ),
      }
      const nextDropletW = Math.max(0, lerp(originGeom.droplet.size.width, droplet.size.width, blend))
      const nextDropletH = Math.max(0, lerp(originGeom.droplet.size.height, droplet.size.height, blend))
      droplet = {
        id: 'droplet',
        center: lerpPoint(originGeom.droplet.center, droplet.center, blend),
        size: { width: nextDropletW, height: nextDropletH },
        radius: Math.max(
          0,
          Math.min(
            lerp(originGeom.droplet.radius, droplet.radius, blend),
            nextDropletW * 0.5,
            nextDropletH * 0.5,
          ),
        ),
      }
      blendK = Math.max(0, lerp(originGeom.blendK, blendK, blend))
      styleMix = clamp(lerp(originGeom.styleMix, styleMix, blend), 0, 1)
      if (anchor.externalTrigger || !motion.hasControlSource) {
        rimOpacity = clamp(lerp(originGeom.rimOpacity, rimOpacity, blend), 0, 1)
        isMerged = blend >= 0.5 ? isMerged : originGeom.isMerged
        mergeDepth = lerp(originGeom.mergeDepth, mergeDepth, blend)
      } else {
        const merge = computePairMergeStatus(
          platter,
          droplet,
          blendK,
          POPOVER_MORPH_DEFAULTS.mergeRimFadeDepth,
        )
        mergeDepth = merge.mergeDepth
        isMerged = merge.isMerged
        rimOpacity = merge.rimOpacity
      }
    }
  }

  const primitives: GlassPrimitive[] =
    droplet.size.width > 0 && droplet.size.height > 0 ? [platter, droplet] : [platter]

  return {
    targetRect,
    targetRadius,
    platter,
    droplet,
    blendK,
    mergeDepth,
    isMerged,
    rimOpacity,
    styleMix,
    field: {
      primitives,
      blendK,
      rimOpacity,
      styleMix,
    },
    contentTransform: computeContentTransform(platter, targetRect),
    glyphTransform: computeGlyphTransform(
      droplet,
      effectiveAnchor,
      Boolean(anchor.externalTrigger && motion.hasControlSource),
    ),
  }
}

/**
 * Captures a mid-flight geometry snapshot so closing an interrupted opening morph
 * retracts smoothly from the instantaneous platter/droplet bounds.
 */
export function createPopoverMorphSnapshot(
  geometry: PopoverFrameGeometry,
  motion: Pick<PopoverMotionState, 'contentBlurPx' | 'normalizedT'>,
): PopoverMorphSnapshot {
  return {
    platter: {
      id: geometry.platter.id,
      center: { ...geometry.platter.center },
      size: { ...geometry.platter.size },
      radius: geometry.platter.radius,
    },
    droplet: {
      id: geometry.droplet.id,
      center: { ...geometry.droplet.center },
      size: { ...geometry.droplet.size },
      radius: geometry.droplet.radius,
    },
    platterRadius: geometry.platter.radius,
    blurPx: motion.contentBlurPx,
    elapsedFraction: motion.normalizedT,
    blendK: geometry.blendK,
  }
}

function solveOpenElapsedForProgress(targetProgress: number): number {
  const target = clamp(targetProgress, 0, 0.999)
  if (target <= 0) return 0

  // Primary open spring rises monotonically on [0, ~0.185s] before peaking.
  let lo = 0
  let hi = Math.min(0.2, POPOVER_MORPH_DEFAULTS.openDurationSec)
  while (
    hi < POPOVER_MORPH_DEFAULTS.openDurationSec &&
    evaluateSpring(hi, POPOVER_MORPH_DEFAULTS.springs.open) < target
  ) {
    hi = Math.min(POPOVER_MORPH_DEFAULTS.openDurationSec, hi + 0.05)
  }

  for (let i = 0; i < 24; i += 1) {
    const mid = 0.5 * (lo + hi)
    if (evaluateSpring(mid, POPOVER_MORPH_DEFAULTS.springs.open) < target) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return 0.5 * (lo + hi)
}

/**
 * Creates a stateful, interruptible controller for the morphing popover/menu preset.
 */
export function createPopoverMorphController(
  options: PopoverMorphControllerOptions = {},
): PopoverMorphController {
  let reducedMotion = options.reducedMotion ?? false
  let phase: PopoverMorphPhase = 'closed'
  let hasControlSource = true
  let elapsedSec = 0
  let closeSnapshot: PopoverMorphSnapshot | null = null
  let interruptStart: PopoverInterruptStart | undefined
  let disposed = false

  const listeners = new Set<(state: PopoverMotionState) => void>()

  function buildState(): PopoverMotionState {
    const duration = getPopoverPhaseDurationSec(phase, hasControlSource, reducedMotion)
    const normalizedT =
      duration > 0 ? clamp(elapsedSec / duration, 0, 1) : phase === 'open' ? 1 : 0
    return evaluatePopoverMotion(phase, normalizedT, {
      hasControlSource,
      reducedMotion,
      interruptStart: phase === 'opening' || phase === 'closing' ? interruptStart : undefined,
    })
  }

  function notify(): void {
    if (disposed || listeners.size === 0) return
    const snapshot = buildState()
    for (const listener of [...listeners]) {
      listener(snapshot)
    }
  }

  return {
    getState(): PopoverMotionState {
      return buildState()
    },

    getCloseSnapshot(): PopoverMorphSnapshot | null {
      return closeSnapshot
    },

    evaluateGeometry(
      anchor: PopoverAnchorConfig,
      panel: PopoverPanelConfig,
    ): PopoverFrameGeometry {
      const motion = buildState()
      const snapshot = motion.phase === 'closing' ? closeSnapshot : null
      return computePopoverMorphGeometry(motion, anchor, panel, snapshot)
    },

    setReducedMotion(reduced: boolean): void {
      if (disposed || reducedMotion === reduced) return
      reducedMotion = reduced
      if (phase === 'opening' || phase === 'closing') {
        const nextDuration = getPopoverPhaseDurationSec(phase, hasControlSource, reducedMotion)
        interruptStart = undefined
        if (elapsedSec >= nextDuration) {
          if (phase === 'opening') {
            phase = 'open'
            elapsedSec = nextDuration
          } else {
            phase = 'closed'
            elapsedSec = 0
            closeSnapshot = null
          }
        }
      }
      notify()
    },

    open(controlSource = true): void {
      if (disposed) return
      if (phase === 'open' || phase === 'opening') {
        return
      }
      let nextElapsedSec = 0
      let nextInterruptStart: PopoverInterruptStart | undefined
      if (phase === 'closing') {
        const current = buildState()
        const originDuration = POPOVER_MORPH_DEFAULTS.openDurationSec
        const snapshotOpenProgress = closeSnapshot
          ? clamp(
              evaluateSpring(
                clamp(closeSnapshot.elapsedFraction, 0, 1) * originDuration,
                POPOVER_MORPH_DEFAULTS.springs.open,
              ),
              0,
              1,
            )
          : 1
        const openFraction = reducedMotion
          ? clamp(current.settled, 0, 0.95)
          : clamp(snapshotOpenProgress * (1 - current.morphProgress), 0, 0.95)
        if (openFraction > 0) {
          if (reducedMotion) {
            const u = 1 - Math.cbrt(1 - openFraction)
            nextElapsedSec = u * POPOVER_MORPH_DEFAULTS.reducedMotionDurationSec
          } else {
            nextElapsedSec = solveOpenElapsedForProgress(openFraction)
          }
        }
        if (current.normalizedT < 1) {
          const nextDuration = getPopoverPhaseDurationSec('opening', controlSource, reducedMotion)
          const startNormalizedT =
            nextDuration > 0 ? clamp(nextElapsedSec / nextDuration, 0, 1) : 0
          const startSettled = reducedMotion
            ? easeOutCubic(startNormalizedT)
            : clamp(evaluateSpring(nextElapsedSec, POPOVER_MORPH_DEFAULTS.springs.open), 0, 1)
          const blendDurationSec = reducedMotion
            ? 0
            : Math.min(0.22, Math.max(1e-4, nextDuration - nextElapsedSec))
          nextInterruptStart = {
            contentOpacity: current.contentOpacity,
            contentBlurPx: current.contentBlurPx,
            triggerGlyphOpacity: current.triggerGlyphOpacity,
            triggerGlyphBlurPx: current.triggerGlyphBlurPx,
            bareGlassOpacity: current.bareGlassOpacity,
            startNormalizedT,
            startSettled,
            reopenFrom: reducedMotion
              ? undefined
              : {
                  motion: current,
                  closeSnapshot,
                  startElapsedSec: nextElapsedSec,
                  blendDurationSec,
                },
          }
        }
      }
      hasControlSource = controlSource
      closeSnapshot = null
      interruptStart = nextInterruptStart
      phase = 'opening'
      elapsedSec = nextElapsedSec
      notify()
    },

    close(snapshot?: PopoverMorphSnapshot): void {
      if (disposed) return
      if (phase === 'closed' || phase === 'closing') {
        return
      }
      const current = buildState()
      closeSnapshot = snapshot ?? null

      if (phase === 'opening' && current.normalizedT < 1) {
        interruptStart = {
          contentOpacity: current.contentOpacity,
          contentBlurPx: snapshot ? snapshot.blurPx : current.contentBlurPx,
          triggerGlyphOpacity: Math.max(
            reducedMotion ? 0 : POPOVER_MORPH_DEFAULTS.closeGlyphStartOpacity,
            current.triggerGlyphOpacity,
          ),
          bareGlassOpacity: current.bareGlassOpacity,
        }
      } else {
        interruptStart = undefined
      }

      phase = 'closing'
      elapsedSec = 0
      notify()
    },

    reset(toPhase: 'closed' | 'open' = 'closed'): void {
      if (disposed) return
      phase = toPhase
      hasControlSource = true
      elapsedSec =
        toPhase === 'open'
          ? getPopoverPhaseDurationSec('opening', hasControlSource, reducedMotion)
          : 0
      closeSnapshot = null
      interruptStart = undefined
      notify()
    },

    seek(
      targetPhase: PopoverMorphPhase,
      normalizedT: number,
      controlSource?: boolean,
    ): PopoverMotionState {
      if (disposed) return buildState()
      if (controlSource !== undefined) {
        hasControlSource = controlSource
      }
      phase = targetPhase
      interruptStart = undefined
      if (targetPhase === 'closed' || targetPhase === 'open') {
        elapsedSec =
          targetPhase === 'open'
            ? getPopoverPhaseDurationSec('opening', hasControlSource, reducedMotion)
            : 0
        if (targetPhase === 'closed') {
          closeSnapshot = null
        }
      } else {
        const duration = getPopoverPhaseDurationSec(targetPhase, hasControlSource, reducedMotion)
        elapsedSec = clamp(normalizedT, 0, 1) * duration
      }
      const next = buildState()
      notify()
      return next
    },

    step(dtSec: number): PopoverMotionState {
      if (disposed || !Number.isFinite(dtSec) || dtSec <= 0) {
        return buildState()
      }
      if (phase === 'opening' || phase === 'closing') {
        const duration = getPopoverPhaseDurationSec(phase, hasControlSource, reducedMotion)
        elapsedSec += dtSec
        if (elapsedSec >= duration) {
          if (phase === 'opening') {
            phase = 'open'
            elapsedSec = duration
            interruptStart = undefined
          } else {
            phase = 'closed'
            elapsedSec = 0
            closeSnapshot = null
            interruptStart = undefined
          }
        }
        notify()
      }
      return buildState()
    },

    subscribe(listener: (state: PopoverMotionState) => void): () => void {
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
