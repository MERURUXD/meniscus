/**
 * @sessile/core math easing, analytical damped-harmonic-oscillator springs,
 * and interruptible morph timelines.
 *
 * Implements closed-form underdamped, critically damped, and overdamped spring
 * solvers, interruptible 1D spring channels, a 0<->1 morph timeline state machine,
 * and a generic elastic press/drag controller without host-specific semantics.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_SPRINGS,
  type Point,
  type Size,
  type SpringParams,
} from './contracts.ts'

const ZETA_CRITICAL_EPSILON = 1e-6
const DEFAULT_SETTLE_POS_EPS = 1e-4
const DEFAULT_SETTLE_VEL_EPS = 1e-3

const DEFAULT_OPEN_DURATION_SEC = 0.45
const DEFAULT_CLOSE_DURATION_SEC = 0.5
const DEFAULT_CORNER_DELAY_SEC = 0.07
const DEFAULT_REDUCED_MOTION_DURATION_SEC = 0.15

const DEFAULT_ELASTIC_DRAG_TRACK_SEC = 0.12
const DEFAULT_ELASTIC_MAX_GROWTH_RATIO = 0.25
const DEFAULT_ELASTIC_MAX_GROWTH_PX = 16
const DEFAULT_ELASTIC_DRAG_MAX_RATIO = 7 / 32
const DEFAULT_ELASTIC_DRAG_STRETCH_RATIO = 0.12
const DEFAULT_MAX_AREA_STRETCH = 1.6

/** Instantaneous spring sample (position and velocity). */
export interface SpringSample {
  value: number
  velocity: number
}

/** Configuration options for an interruptible 1D spring channel. */
export interface SpringChannelOptions {
  params?: SpringParams
  initialValue?: number
  initialVelocity?: number
  initialTarget?: number
  settlePosEps?: number
  settleVelEps?: number
}

/** Instantaneous state of a 1D spring channel. */
export interface SpringChannelState {
  value: number
  velocity: number
  target: number
  settled: boolean
}

/** Interruptible 1D analytical spring channel interface. */
export interface SpringChannel {
  setTarget(target: number): void
  impulse(deltaVelocity: number): void
  snap(value: number, velocity?: number): void
  step(dtSec: number): SpringChannelState
  seek(elapsedSec: number): SpringChannelState
  setParams(params: SpringParams): void
  getState(): SpringChannelState
}

/** Phase of a generic 0<->1 morph timeline. */
export type MorphTimelinePhase = 'closed' | 'opening' | 'open' | 'closing'

/** Configuration options for a generic 0<->1 morph timeline. */
export interface MorphTimelineOptions {
  openDurationSec?: number
  closeDurationSec?: number
  cornerDelaySec?: number
  reducedMotionDurationSec?: number
  spring?: SpringParams
  cornerSpring?: SpringParams
  reducedMotion?: boolean
  initialPhase?: 'closed' | 'open'
}

/** Instantaneous output state of a 0<->1 morph timeline. */
export interface MorphTimelineState {
  phase: MorphTimelinePhase
  elapsedSec: number
  normalizedT: number
  progress: number
  cornerProgress: number
  styleMix: number
  isAnimating: boolean
  reducedMotion: boolean
}

/** Controller interface for a generic 0<->1 morph timeline. */
export interface MorphTimeline {
  open(): void
  close(): void
  reset(toPhase?: 'closed' | 'open'): void
  step(dtSec: number): MorphTimelineState
  seek(phase: MorphTimelinePhase, normalizedT: number): MorphTimelineState
  setReducedMotion(reduced: boolean): void
  getState(): MorphTimelineState
  subscribe(listener: (state: MorphTimelineState) => void): () => void
  dispose(): void
}

/** Axis-aligned 2D squash-and-stretch scale factors preserving area (`scaleX * scaleY === 1`). */
export interface AreaPreservingScale {
  scaleX: number
  scaleY: number
}

/** Configuration options for the elastic press and rubber-band drag controller. */
export interface ElasticPressOptions {
  spring?: SpringParams
  dragTrackSec?: number
  maxGrowthRatio?: number
  maxGrowthPx?: number
  dragMaxRatio?: number
  /** Directional area-preserving squash-and-stretch intensity during rubber-band drag (`0` disables; defaults to `0.12`). */
  dragStretchRatio?: number
  reducedMotion?: boolean
}

/** Current state of the elastic press and drag controller. */
export interface ElasticPressState {
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  lift: number
  active: boolean
  isAnimating: boolean
}

/** Controller interface for elastic press and rubber-band drag interactions. */
export interface ElasticPressController {
  pressStart(targetSize: Size): void
  pressMove(delta: Point, targetSize: Size): void
  pressRelease(): void
  step(dtSec: number): ElasticPressState
  reset(): void
  setReducedMotion(reduced: boolean): void
  getState(): ElasticPressState
}

/**
 * Clamps `value` to the inclusive range `[min, max]`. An inverted range
 * (`max < min`) resolves to `min`, matching CSS `clamp()`, so content larger
 * than its container pins to the leading edge instead of overflowing it.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Linearly interpolates `a + (b - a) * t` without clamping `t` so spring overshoot is preserved. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Standard Hermite smoothstep; degrades to a step function when `edge1 <= edge0`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Quadratic ease-in curve. */
export function easeInQuad(t: number): number {
  const u = clamp(t, 0, 1)
  return u * u
}

/** Cubic ease-out curve. */
export function easeOutCubic(t: number): number {
  const u = clamp(t, 0, 1)
  const inv = 1 - u
  return 1 - inv * inv * inv
}

/** Cubic ease-in-out curve. */
export function easeInOutCubic(t: number): number {
  const u = clamp(t, 0, 1)
  if (u < 0.5) {
    return 4 * u * u * u
  }
  const k = -2 * u + 2
  return 1 - (k * k * k) / 2
}

/**
 * Evaluates a 1D cubic Bezier timing curve `B_y(s)` where `B_x(s) = t`.
 * Uses Newton-Raphson iteration with bisection fallback to guarantee convergence.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): number {
  if (t <= 0) return 0
  if (t >= 1) return 1

  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx

  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  let lo = 0
  let hi = 1
  let s = t

  for (let i = 0; i < 12; i += 1) {
    const x = ((ax * s + bx) * s + cx) * s - t
    if (Math.abs(x) < 1e-7) {
      break
    }
    if (x < 0) {
      lo = s
    } else {
      hi = s
    }
    const dx = (3 * ax * s + 2 * bx) * s + cx
    if (Math.abs(dx) > 1e-6) {
      const next = s - x / dx
      s = next > lo && next < hi ? next : 0.5 * (lo + hi)
    } else {
      s = 0.5 * (lo + hi)
    }
  }

  return ((ay * s + by) * s + cy) * s
}

/**
 * Normalized impulse envelope that peaks at exactly `1.0` when `t === peak`:
 * `(t / peak)^sharpness * exp(sharpness * (1 - t / peak))`.
 */
export function riseAndFall(t: number, peak: number, sharpness: number): number {
  if (t <= 0 || peak <= 0 || !Number.isFinite(t)) {
    return 0
  }
  const ratio = t / peak
  return Math.pow(ratio, sharpness) * Math.exp(sharpness * (1 - ratio))
}

/**
 * Closed-form damped-harmonic-oscillator solver returning both position and velocity.
 * Handles underdamped (`zeta < 1`), critically damped (`zeta == 1`), and overdamped (`zeta > 1`) regimes.
 */
export function evaluateSpringState(
  timeSec: number,
  params: SpringParams,
  initialValue = 0,
  initialVelocity = 0,
  targetValue = 1,
): SpringSample {
  if (timeSec <= 0) {
    return { value: initialValue, velocity: initialVelocity }
  }
  if (!Number.isFinite(timeSec) || params.mass <= 0 || params.stiffness <= 0) {
    return { value: targetValue, velocity: 0 }
  }

  const omega0 = Math.sqrt(params.stiffness / params.mass)
  const zeta = Math.max(0, params.dampingRatio)
  const y0 = initialValue - targetValue
  const v0 = initialVelocity

  if (y0 === 0 && v0 === 0) {
    return { value: targetValue, velocity: 0 }
  }

  if (Math.abs(zeta - 1) <= ZETA_CRITICAL_EPSILON) {
    const decay = Math.exp(-omega0 * timeSec)
    const b = v0 + omega0 * y0
    const y = decay * (y0 + b * timeSec)
    const v = decay * (v0 - omega0 * b * timeSec)
    return { value: targetValue + y, velocity: v }
  }

  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-zeta * omega0 * timeSec)
    const a = y0
    const b = (v0 + zeta * omega0 * y0) / omegaD
    const cos = Math.cos(omegaD * timeSec)
    const sin = Math.sin(omegaD * timeSec)
    const y = decay * (a * cos + b * sin)
    const v =
      decay *
      ((-zeta * omega0 * a + omegaD * b) * cos + (-zeta * omega0 * b - omegaD * a) * sin)
    return { value: targetValue + y, velocity: v }
  }

  const gamma = omega0 * Math.sqrt(zeta * zeta - 1)
  const r1 = -omega0 * zeta + gamma
  const r2 = -omega0 * zeta - gamma
  const c1 = (v0 - r2 * y0) / (2 * gamma)
  const c2 = y0 - c1
  const e1 = Math.exp(r1 * timeSec)
  const e2 = Math.exp(r2 * timeSec)
  return {
    value: targetValue + c1 * e1 + c2 * e2,
    velocity: c1 * r1 * e1 + c2 * r2 * e2,
  }
}

/** Evaluates an analytical damped-harmonic-oscillator spring and returns position `x(t)`. */
export function evaluateSpring(
  timeSec: number,
  params: SpringParams,
  initialValue = 0,
  initialVelocity = 0,
  targetValue = 1,
): number {
  return evaluateSpringState(timeSec, params, initialValue, initialVelocity, targetValue).value
}

/**
 * Creates an interruptible 1D analytical spring channel.
 * Re-anchors the closed-form solution from the current `(value, velocity)` on every
 * target or parameter change to guarantee C1 continuity without discontinuities.
 */
export function createSpringChannel(options: SpringChannelOptions = {}): SpringChannel {
  let params: SpringParams = options.params ?? DEFAULT_SPRINGS.standard
  const settlePosEps = options.settlePosEps ?? DEFAULT_SETTLE_POS_EPS
  const settleVelEps = options.settleVelEps ?? DEFAULT_SETTLE_VEL_EPS

  let anchorValue = options.initialValue ?? 0
  let anchorVelocity = options.initialVelocity ?? 0
  let target = options.initialTarget ?? anchorValue
  let elapsedSec = 0

  let currentValue = anchorValue
  let currentVelocity = anchorVelocity

  function isWithinSettle(val: number, vel: number): boolean {
    return Math.abs(val - target) < settlePosEps && Math.abs(vel) < settleVelEps
  }

  let settled = isWithinSettle(currentValue, currentVelocity)
  if (settled) {
    currentValue = target
    currentVelocity = 0
  }

  function reanchor(nextValue: number, nextVelocity: number): void {
    anchorValue = nextValue
    anchorVelocity = nextVelocity
    elapsedSec = 0
    if (isWithinSettle(nextValue, nextVelocity)) {
      currentValue = target
      currentVelocity = 0
      settled = true
    } else {
      currentValue = nextValue
      currentVelocity = nextVelocity
      settled = false
    }
  }

  function evaluateAt(timeSec: number): SpringChannelState {
    const safeT = Math.max(0, timeSec)
    elapsedSec = safeT
    const sample = evaluateSpringState(safeT, params, anchorValue, anchorVelocity, target)
    if (isWithinSettle(sample.value, sample.velocity)) {
      currentValue = target
      currentVelocity = 0
      settled = true
    } else {
      currentValue = sample.value
      currentVelocity = sample.velocity
      settled = false
    }
    return {
      value: currentValue,
      velocity: currentVelocity,
      target,
      settled,
    }
  }

  return {
    setTarget(nextTarget: number): void {
      if (!Number.isFinite(nextTarget)) return
      if (nextTarget === target && settled) return
      target = nextTarget
      reanchor(currentValue, currentVelocity)
    },

    impulse(deltaVelocity: number): void {
      if (!Number.isFinite(deltaVelocity) || deltaVelocity === 0) return
      reanchor(currentValue, currentVelocity + deltaVelocity)
    },

    snap(value: number, velocity = 0): void {
      if (!Number.isFinite(value) || !Number.isFinite(velocity)) return
      reanchor(value, velocity)
    },

    step(dtSec: number): SpringChannelState {
      if (settled || !Number.isFinite(dtSec) || dtSec <= 0) {
        return { value: currentValue, velocity: currentVelocity, target, settled }
      }
      return evaluateAt(elapsedSec + dtSec)
    },

    seek(targetElapsedSec: number): SpringChannelState {
      if (!Number.isFinite(targetElapsedSec)) {
        return { value: currentValue, velocity: currentVelocity, target, settled }
      }
      return evaluateAt(targetElapsedSec)
    },

    setParams(nextParams: SpringParams): void {
      params = nextParams
      reanchor(currentValue, currentVelocity)
    },

    getState(): SpringChannelState {
      return { value: currentValue, velocity: currentVelocity, target, settled }
    },
  }
}

/**
 * Creates a generic interruptible 0<->1 morph timeline.
 * Re-anchors the analytical springs from the instantaneous `(progress, velocity)` on
 * mid-flight reversals so both the primary morph and delayed corner curves remain C1-continuous.
 */
export function createMorphTimeline(options: MorphTimelineOptions = {}): MorphTimeline {
  const openDurationSec = Math.max(1e-4, options.openDurationSec ?? DEFAULT_OPEN_DURATION_SEC)
  const closeDurationSec = Math.max(1e-4, options.closeDurationSec ?? DEFAULT_CLOSE_DURATION_SEC)
  const cornerDelaySec = Math.max(0, options.cornerDelaySec ?? DEFAULT_CORNER_DELAY_SEC)
  const reducedMotionDurationSec = Math.max(
    1e-4,
    options.reducedMotionDurationSec ?? DEFAULT_REDUCED_MOTION_DURATION_SEC,
  )
  const mainSpring = options.spring ?? DEFAULT_SPRINGS.standard
  const cornerSpring = options.cornerSpring ?? DEFAULT_SPRINGS.corners

  let reducedMotion = options.reducedMotion ?? false
  let phase: MorphTimelinePhase = options.initialPhase ?? 'closed'
  let elapsedSec = phase === 'open' ? openDurationSec : 0
  let disposed = false

  // Anchor state for mid-flight interruption and deterministic re-evaluation.
  let mainAnchorValue = phase === 'open' ? 1 : 0
  let mainAnchorVelocity = 0
  let cornerAnchorValue = phase === 'open' ? 1 : 0
  let cornerAnchorVelocity = 0
  let segmentElapsedSec = 0
  let cornerDelayRemainingSec = 0

  const listeners = new Set<(state: MorphTimelineState) => void>()

  function getActiveDuration(): number {
    if (phase === 'closed' || phase === 'open') return 0
    if (reducedMotion) return reducedMotionDurationSec
    return phase === 'opening' ? openDurationSec : closeDurationSec
  }

  function evaluateCurves(): { progress: number; velocity: number; cornerProgress: number; cornerVelocity: number } {
    if (phase === 'closed') {
      return { progress: 0, velocity: 0, cornerProgress: 0, cornerVelocity: 0 }
    }
    if (phase === 'open') {
      return { progress: 1, velocity: 0, cornerProgress: 1, cornerVelocity: 0 }
    }

    const target = phase === 'opening' ? 1 : 0
    if (reducedMotion) {
      const t = clamp(segmentElapsedSec / reducedMotionDurationSec, 0, 1)
      const p = lerp(mainAnchorValue, target, t)
      const v = (target - mainAnchorValue) / reducedMotionDurationSec
      const cp = lerp(cornerAnchorValue, target, t)
      const cv = (target - cornerAnchorValue) / reducedMotionDurationSec
      return { progress: p, velocity: v, cornerProgress: cp, cornerVelocity: cv }
    }

    const mainSample = evaluateSpringState(
      segmentElapsedSec,
      mainSpring,
      mainAnchorValue,
      mainAnchorVelocity,
      target,
    )

    let cornerProgress = cornerAnchorValue
    let cornerVelocity = cornerAnchorVelocity
    if (segmentElapsedSec > cornerDelayRemainingSec) {
      const cornerSample = evaluateSpringState(
        segmentElapsedSec - cornerDelayRemainingSec,
        cornerSpring,
        cornerAnchorValue,
        cornerAnchorVelocity,
        target,
      )
      cornerProgress = cornerSample.value
      cornerVelocity = cornerSample.velocity
    } else if (cornerDelayRemainingSec > 0) {
      // Hold corner progress during the initial delay window and zero out residual velocity.
      cornerProgress = cornerAnchorValue
      cornerVelocity = 0
    }

    return {
      progress: mainSample.value,
      velocity: mainSample.velocity,
      cornerProgress,
      cornerVelocity,
    }
  }

  function buildState(): MorphTimelineState {
    const duration = getActiveDuration()
    const normalizedT =
      duration > 0 ? clamp(segmentElapsedSec / duration, 0, 1) : phase === 'open' ? 1 : 0
    const { progress, cornerProgress } = evaluateCurves()
    return {
      phase,
      elapsedSec,
      normalizedT,
      progress,
      cornerProgress,
      styleMix: clamp(progress, 0, 1),
      isAnimating: phase === 'opening' || phase === 'closing',
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

  function startTransition(nextPhase: 'opening' | 'closing'): void {
    if (disposed) return
    if (phase === nextPhase) return
    if (phase === 'open' && nextPhase === 'opening') return
    if (phase === 'closed' && nextPhase === 'closing') return

    const current = evaluateCurves()
    mainAnchorValue = current.progress
    mainAnchorVelocity = current.velocity
    cornerAnchorValue = current.cornerProgress
    cornerAnchorVelocity = current.cornerVelocity
    segmentElapsedSec = 0

    if (nextPhase === 'opening' && phase === 'closed') {
      cornerDelayRemainingSec = cornerDelaySec
    } else {
      // Skip the corner delay on mid-flight reversals and closes so corners respond immediately.
      cornerDelayRemainingSec = 0
    }

    phase = nextPhase
    elapsedSec = 0
    notify()
  }

  return {
    open(): void {
      startTransition('opening')
    },

    close(): void {
      startTransition('closing')
    },

    reset(toPhase: 'closed' | 'open' = 'closed'): void {
      if (disposed) return
      phase = toPhase
      const val = toPhase === 'open' ? 1 : 0
      mainAnchorValue = val
      mainAnchorVelocity = 0
      cornerAnchorValue = val
      cornerAnchorVelocity = 0
      segmentElapsedSec = 0
      cornerDelayRemainingSec = 0
      elapsedSec = toPhase === 'open' ? openDurationSec : 0
      notify()
    },

    step(dtSec: number): MorphTimelineState {
      if (disposed || !Number.isFinite(dtSec) || dtSec <= 0) {
        return buildState()
      }
      if (phase === 'opening' || phase === 'closing') {
        const duration = getActiveDuration()
        segmentElapsedSec += dtSec
        elapsedSec = Math.min(duration, segmentElapsedSec)
        if (segmentElapsedSec >= duration) {
          if (phase === 'opening') {
            phase = 'open'
            mainAnchorValue = 1
            cornerAnchorValue = 1
            elapsedSec = duration
          } else {
            phase = 'closed'
            mainAnchorValue = 0
            cornerAnchorValue = 0
            elapsedSec = 0
          }
          mainAnchorVelocity = 0
          cornerAnchorVelocity = 0
          segmentElapsedSec = 0
          cornerDelayRemainingSec = 0
        }
        notify()
      }
      return buildState()
    },

    seek(targetPhase: MorphTimelinePhase, normalizedT: number): MorphTimelineState {
      if (disposed) return buildState()
      const u = clamp(Number.isFinite(normalizedT) ? normalizedT : 0, 0, 1)
      phase = targetPhase
      mainAnchorVelocity = 0
      cornerAnchorVelocity = 0

      if (targetPhase === 'closed') {
        mainAnchorValue = 0
        cornerAnchorValue = 0
        segmentElapsedSec = 0
        cornerDelayRemainingSec = 0
        elapsedSec = 0
      } else if (targetPhase === 'open') {
        mainAnchorValue = 1
        cornerAnchorValue = 1
        segmentElapsedSec = 0
        cornerDelayRemainingSec = 0
        elapsedSec = openDurationSec
      } else {
        const duration = getActiveDuration()
        const anchor = targetPhase === 'opening' ? 0 : 1
        mainAnchorValue = anchor
        cornerAnchorValue = anchor
        cornerDelayRemainingSec = targetPhase === 'opening' ? cornerDelaySec : 0
        segmentElapsedSec = u * duration
        elapsedSec = segmentElapsedSec
      }
      const next = buildState()
      notify()
      return next
    },

    setReducedMotion(reduced: boolean): void {
      if (disposed || reducedMotion === reduced) return
      const current = evaluateCurves()
      reducedMotion = reduced
      if (phase === 'opening' || phase === 'closing') {
        mainAnchorValue = current.progress
        mainAnchorVelocity = current.velocity
        cornerAnchorValue = current.cornerProgress
        cornerAnchorVelocity = current.cornerVelocity
        segmentElapsedSec = 0
        cornerDelayRemainingSec = 0
        elapsedSec = 0
      }
      notify()
    },

    getState(): MorphTimelineState {
      return buildState()
    },

    subscribe(listener: (state: MorphTimelineState) => void): () => void {
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

/**
 * Computes axis-aligned 2D squash-and-stretch scale factors preserving area (`scaleX * scaleY === 1`)
 * along direction `(dirX, dirY)`. Using `alpha = (dirX^2 - dirY^2) / (dirX^2 + dirY^2) = cos(2*theta)`
 * gives `(s, 1/s)` horizontally, `(1/s, s)` vertically, and `(1, 1)` on 45-degree diagonals with smooth
 * rotational continuity.
 */
export function computeAreaPreservingScale(
  stretch: number,
  dirX: number,
  dirY: number,
  maxStretch = DEFAULT_MAX_AREA_STRETCH,
): AreaPreservingScale {
  if (!Number.isFinite(stretch) || stretch <= 0) {
    return { scaleX: 1, scaleY: 1 }
  }
  const safeMax = Number.isFinite(maxStretch) && maxStretch >= 1 ? maxStretch : DEFAULT_MAX_AREA_STRETCH
  const s = clamp(stretch, 1 / safeMax, safeMax)
  if (Math.abs(s - 1) <= 1e-9) {
    return { scaleX: 1, scaleY: 1 }
  }
  const lenSq = dirX * dirX + dirY * dirY
  if (!Number.isFinite(lenSq) || lenSq <= 1e-12) {
    return { scaleX: 1, scaleY: 1 }
  }
  const alpha = (dirX * dirX - dirY * dirY) / lenSq
  const scaleX = Math.pow(s, alpha)
  return { scaleX, scaleY: 1 / scaleX }
}

/**
 * Applies `computeAreaPreservingScale` to a 2D `Size` so `result.width * result.height === size.width * size.height`.
 */
export function deformSizePreservingArea(
  size: Size,
  stretch: number,
  dirX: number,
  dirY: number,
  maxStretch = DEFAULT_MAX_AREA_STRETCH,
): Size {
  const { scaleX, scaleY } = computeAreaPreservingScale(stretch, dirX, dirY, maxStretch)
  return {
    width: Math.max(0, size.width * scaleX),
    height: Math.max(0, size.height * scaleY),
  }
}

/**
 * Creates a generic elastic press and rubber-band drag controller.
 * Uses a critically damped tracking spring while dragging for tight pointer follow,
 * then switches back to the underdamped elastic spring on release.
 */
export function createElasticPressController(
  options: ElasticPressOptions = {},
): ElasticPressController {
  const spring = options.spring ?? DEFAULT_SPRINGS.elasticPress
  const dragTrackSec = Math.max(1e-3, options.dragTrackSec ?? DEFAULT_ELASTIC_DRAG_TRACK_SEC)
  const maxGrowthRatio = options.maxGrowthRatio ?? DEFAULT_ELASTIC_MAX_GROWTH_RATIO
  const maxGrowthPx = options.maxGrowthPx ?? DEFAULT_ELASTIC_MAX_GROWTH_PX
  const dragMaxRatio = options.dragMaxRatio ?? DEFAULT_ELASTIC_DRAG_MAX_RATIO
  const dragStretchRatio = clamp(
    options.dragStretchRatio ?? DEFAULT_ELASTIC_DRAG_STRETCH_RATIO,
    0,
    0.45,
  )

  // Critically damped tracking spring (~95% settled in dragTrackSec):
  // derived from 1 - exp(-w0 * t) * (1 + w0 * t) = 0.95 at w0 * t ≈ 4.744.
  const dragTrackSpring: SpringParams = {
    mass: 1,
    stiffness: Math.pow(4.744 / dragTrackSec, 2),
    dampingRatio: 1,
  }

  let reducedMotion = options.reducedMotion ?? false
  let active = false
  let targetSize: Size = { width: 44, height: 44 }

  const liftChannel = createSpringChannel({ params: spring, initialValue: 0 })
  const offsetXChannel = createSpringChannel({ params: spring, initialValue: 0 })
  const offsetYChannel = createSpringChannel({ params: spring, initialValue: 0 })

  function buildState(): ElasticPressState {
    if (reducedMotion) {
      return {
        scaleX: 1,
        scaleY: 1,
        offsetX: 0,
        offsetY: 0,
        lift: 0,
        active,
        isAnimating: false,
      }
    }
    const lift = liftChannel.getState()
    const ox = offsetXChannel.getState()
    const oy = offsetYChannel.getState()
    const longestSide = Math.max(1, targetSize.width, targetSize.height)
    const maxGrowth = Math.min(maxGrowthRatio, maxGrowthPx / longestSide)
    const scale = 1 + maxGrowth * lift.value
    let scaleX = scale
    let scaleY = scale
    if (dragStretchRatio > 0) {
      const shortestSide = Math.max(1, Math.min(targetSize.width, targetSize.height))
      const dragLimit = Math.max(1, dragMaxRatio * shortestSide)
      const dragNorm = clamp(Math.hypot(ox.value, oy.value) / dragLimit, 0, 1)
      if (dragNorm > 0) {
        const directional = computeAreaPreservingScale(
          1 + dragStretchRatio * dragNorm,
          ox.value,
          oy.value,
        )
        scaleX = scale * directional.scaleX
        scaleY = scale * directional.scaleY
      }
    }
    return {
      scaleX,
      scaleY,
      offsetX: ox.value,
      offsetY: oy.value,
      lift: lift.value,
      active,
      isAnimating: !lift.settled || !ox.settled || !oy.settled,
    }
  }

  return {
    pressStart(size: Size): void {
      targetSize = {
        width: Math.max(1, size.width),
        height: Math.max(1, size.height),
      }
      active = true
      if (!reducedMotion) {
        offsetXChannel.setParams(dragTrackSpring)
        offsetYChannel.setParams(dragTrackSpring)
        liftChannel.setTarget(1)
      }
    },

    pressMove(delta: Point, size: Size): void {
      targetSize = {
        width: Math.max(1, size.width),
        height: Math.max(1, size.height),
      }
      if (reducedMotion || !active) return
      const shortestSide = Math.max(1, Math.min(targetSize.width, targetSize.height))
      const dragLimit = dragMaxRatio * shortestSide
      const mag = Math.hypot(delta.x, delta.y)
      const bandedMag = mag > 0 ? (dragLimit * mag) / (dragLimit + mag) : 0
      offsetXChannel.setTarget(mag > 0 ? (delta.x / mag) * bandedMag : 0)
      offsetYChannel.setTarget(mag > 0 ? (delta.y / mag) * bandedMag : 0)
    },

    pressRelease(): void {
      active = false
      offsetXChannel.setParams(spring)
      offsetYChannel.setParams(spring)
      liftChannel.setTarget(0)
      offsetXChannel.setTarget(0)
      offsetYChannel.setTarget(0)
    },

    step(dtSec: number): ElasticPressState {
      if (!reducedMotion && Number.isFinite(dtSec) && dtSec > 0) {
        liftChannel.step(dtSec)
        offsetXChannel.step(dtSec)
        offsetYChannel.step(dtSec)
      }
      return buildState()
    },

    reset(): void {
      active = false
      liftChannel.setTarget(0)
      liftChannel.snap(0, 0)
      offsetXChannel.setTarget(0)
      offsetXChannel.snap(0, 0)
      offsetYChannel.setTarget(0)
      offsetYChannel.snap(0, 0)
    },

    setReducedMotion(reduced: boolean): void {
      if (reducedMotion === reduced) return
      reducedMotion = reduced
      if (reducedMotion) {
        liftChannel.setTarget(0)
        liftChannel.snap(0, 0)
        offsetXChannel.setTarget(0)
        offsetXChannel.snap(0, 0)
        offsetYChannel.setTarget(0)
        offsetYChannel.snap(0, 0)
      }
    },

    getState(): ElasticPressState {
      return buildState()
    },
  }
}
