/**
 * @meniscus/core 通用数学缓动、解析阻尼谐振弹簧与可打断形变时间线。
 *
 * 实现解析法欠阻尼/临界阻尼/过阻尼弹簧求解器、可打断 1D 弹簧通道、
 * 0↔1 形变时间线状态机及通用弹性按压/拖拽控制器。
 * 不包含任何特定宿主业务或菜单交互语义。
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

/** 弹簧瞬时采样结果（位置与速度）。 */
export interface SpringSample {
  value: number
  velocity: number
}

/** 1D 可打断弹簧通道配置选项。 */
export interface SpringChannelOptions {
  params?: SpringParams
  initialValue?: number
  initialVelocity?: number
  initialTarget?: number
  settlePosEps?: number
  settleVelEps?: number
}

/** 1D 可打断弹簧通道瞬时状态。 */
export interface SpringChannelState {
  value: number
  velocity: number
  target: number
  settled: boolean
}

/** 1D 可打断弹簧通道接口。 */
export interface SpringChannel {
  setTarget(target: number): void
  impulse(deltaVelocity: number): void
  snap(value: number, velocity?: number): void
  step(dtSec: number): SpringChannelState
  seek(elapsedSec: number): SpringChannelState
  setParams(params: SpringParams): void
  getState(): SpringChannelState
}

/** 通用 0↔1 形变时间线阶段。 */
export type MorphTimelinePhase = 'closed' | 'opening' | 'open' | 'closing'

/** 通用 0↔1 形变时间线配置选项。 */
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

/** 通用 0↔1 形变时间线瞬时输出状态。 */
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

/** 通用 0↔1 形变时间线控制器接口。 */
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

/** 通用弹性按压与拖拽控制器配置选项。 */
export interface ElasticPressOptions {
  spring?: SpringParams
  dragTrackSec?: number
  maxGrowthRatio?: number
  maxGrowthPx?: number
  dragMaxRatio?: number
  reducedMotion?: boolean
}

/** 通用弹性按压与拖拽控制器状态。 */
export interface ElasticPressState {
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  lift: number
  active: boolean
  isAnimating: boolean
}

/** 通用弹性按压与拖拽控制器接口。 */
export interface ElasticPressController {
  pressStart(targetSize: Size): void
  pressMove(delta: Point, targetSize: Size): void
  pressRelease(): void
  step(dtSec: number): ElasticPressState
  reset(): void
  setReducedMotion(reduced: boolean): void
  getState(): ElasticPressState
}

/** 将数值限制在 [min, max] 区间内。 */
export function clamp(value: number, min: number, max: number): number {
  if (value <= min) return min
  if (value >= max) return max
  return value
}

/** 线性插值 `a + (b - a) * t`（不限制 `t` 范围以支持过冲插值）。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 标准 Hermite 平滑阶跃函数，当 `edge1 <= edge0` 时退化为阶跃。 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 二次缓入曲线。 */
export function easeInQuad(t: number): number {
  const u = clamp(t, 0, 1)
  return u * u
}

/** 三次缓出曲线。 */
export function easeOutCubic(t: number): number {
  const u = clamp(t, 0, 1)
  const inv = 1 - u
  return 1 - inv * inv * inv
}

/** 三次缓入缓出曲线。 */
export function easeInOutCubic(t: number): number {
  const u = clamp(t, 0, 1)
  if (u < 0.5) {
    return 4 * u * u * u
  }
  const k = -2 * u + 2
  return 1 - (k * k * k) / 2
}

/**
 * 求解标准 1D 三次贝塞尔时间曲线 B_y(s)，其中 B_x(s) = t。
 * 使用带区间二分兜底的牛顿迭代法保证收敛。
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
 * 归一化脉冲包络函数：在 `t === peak` 时精确达到峰值 `1.0`。
 * 公式：`(t / peak)^sharpness * exp(sharpness * (1 - t / peak))`。
 */
export function riseAndFall(t: number, peak: number, sharpness: number): number {
  if (t <= 0 || peak <= 0 || !Number.isFinite(t)) {
    return 0
  }
  const ratio = t / peak
  return Math.pow(ratio, sharpness) * Math.exp(sharpness * (1 - ratio))
}

/**
 * 解析阻尼谐振弹簧求解器，返回任意时刻的位置与速度。
 * 完整支持欠阻尼（zeta < 1）、临界阻尼（zeta == 1）与过阻尼（zeta > 1）分支。
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

/** 解析阻尼谐振弹簧求值器，仅返回位移 `x(t)`。 */
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
 * 创建可打断的 1D 解析弹簧通道。
 * 每次修改目标或参数时从当前 `(value, velocity)` 重新锚定解析解，确保无跳变连续性。
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
 * 创建通用可打断 0↔1 形变时间线。
 * 在 `opening` / `closing` 飞行中途打断反向时，直接从当前位置与速度重新锚定解析弹簧，
 * 确保主形变进度与延迟圆角曲线均连续无突变。
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

  // 用于飞行中途打断与连续求值的锚点状态
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
      return { progress: p, velocity: v, cornerProgress: p, cornerVelocity: v }
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
      // 延迟等待期内保持当前圆角值并平滑衰减已有速度
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
    const normalizedT = duration > 0 ? clamp(elapsedSec / duration, 0, 1) : phase === 'open' ? 1 : 0
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
      // 打断反向或关闭阶段不额外插入圆角延迟，直接连续过渡
      cornerDelayRemainingSec = 0
    }

    phase = nextPhase
    const duration = getActiveDuration()
    // 估算与当前进度对应的名义 elapsedSec，用于进度查询一致性
    const target = nextPhase === 'opening' ? 1 : 0
    const approxFraction = nextPhase === 'opening' ? clamp(current.progress, 0, 1) : clamp(1 - current.progress, 0, 1)
    elapsedSec = approxFraction * duration
    if (phase === 'opening' && target === 1 && current.progress === 0) {
      elapsedSec = 0
    }
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
        elapsedSec = Math.min(duration, elapsedSec + dtSec)
        if (segmentElapsedSec >= duration || elapsedSec >= duration) {
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
        const duration = getActiveDuration()
        elapsedSec = Math.min(elapsedSec, duration)
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
 * 创建通用弹性按压与橡胶带拖拽控制器。
 * 对齐弹性按压物理比例，在拖拽期间使用临界阻尼快速跟随，松手后使用弹性弹簧回弹。
 */
export function createElasticPressController(
  options: ElasticPressOptions = {},
): ElasticPressController {
  const spring = options.spring ?? DEFAULT_SPRINGS.elasticPress
  const dragTrackSec = Math.max(1e-3, options.dragTrackSec ?? DEFAULT_ELASTIC_DRAG_TRACK_SEC)
  const maxGrowthRatio = options.maxGrowthRatio ?? DEFAULT_ELASTIC_MAX_GROWTH_RATIO
  const maxGrowthPx = options.maxGrowthPx ?? DEFAULT_ELASTIC_MAX_GROWTH_PX
  const dragMaxRatio = options.dragMaxRatio ?? DEFAULT_ELASTIC_DRAG_MAX_RATIO

  // 临界阻尼追踪弹簧：在 dragTrackSec 内完成约 95% 收敛（w0 * t ≈ 4.744）
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
    return {
      scaleX: scale,
      scaleY: scale,
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
