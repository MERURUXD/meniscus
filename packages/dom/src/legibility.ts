/**
 * Per-surface adaptive legibility state: goal, telemetry sampling, asymmetric smoothing and the
 * resolved material response that `GlassSurfaceController` applies to its layers.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { type BackdropVeilOptics, type GlassFieldState, type Rect } from '@sessile/core'
import {
  LEGIBILITY_SMOOTHING,
  computeBackdropRisk,
  createAsymmetricSmoother,
  createLegibilityParams,
  createTelemetryAccumulator,
  resolveLegibilityGoal,
  resolveLegibilityParams,
  type BackdropTelemetry,
  type LegibilityGoal,
  type LegibilityParams,
  type LegibilityRisk,
  type LegibilityTarget,
} from '@sessile/core/legibility'
import type { BackdropProbe } from './backdropProbe.ts'

export interface GlassLegibilityOptions extends LegibilityTarget {
  /** Live telemetry source; injected telemetry (`setBackdropTelemetry`) takes precedence. */
  probe?: BackdropProbe | null
}

const MIN_ACTIVE_SIZE = 0.01
const RISK_CHANNELS = 3
/**
 * Smoothed risk closer than this to the committed value does not re-resolve the response.
 * Measured on `resolveLegibilityParams` across tiers and polarities, a 0.02 step of any risk
 * channel moves the table by at most 1.14/255, the film by 0.9/255, the edge gains by 0.024
 * and blur by 0.12px: about one 8-bit step, hidden by the moving content that caused it.
 * Without it a scrolling backdrop nudges the risk every frame, and each nudge rewrites the
 * filter (Chromium rebuilds it) and redraws the edge overlay.
 */
const RISK_DEADBAND = 0.02
/**
 * Moves past the deadband commit only on the first frame of a slot of a shared clock. Every
 * surface derives the slot from the same animation-frame timestamp, so a page of glass rewrites
 * its layers in the same frame, at most this often. Each frame that writes to a backdrop-filter
 * host costs Chromium a repaint of the effect: on a library page with ~11 refracting surfaces,
 * unsynchronised commits during a wheel scroll doubled GPU and main-thread time, while one
 * batched write per ~100ms stays close to the tint-free baseline. The wait adds at most one slot
 * to the 90ms attack.
 */
export const RISK_COMMIT_INTERVAL_MS = 100

/**
 * One surface's adaptive legibility state, created by `createGlassLegibility` from
 * `@sessile/dom/legibility` and handed to `GlassSurfaceController.setLegibility`.
 *
 * The controller only sees this contract, so a page that never enables legibility never loads
 * the solver. Each instance keeps smoothing history for one surface: give every controller its
 * own, and pass a fresh one to reset that history.
 */
export interface GlassLegibility {
  readonly params: LegibilityParams
  readonly probe: BackdropProbe | null
  /** `true` once the smoothed risk has reached its target; the frame loop may then sleep. */
  readonly settled: boolean
  setTelemetry(telemetry: BackdropTelemetry | null): void
  sample(
    field: GlassFieldState,
    originX: number,
    originY: number,
    baseVeil: ArrayLike<number>,
    optics?: BackdropVeilOptics,
    saturation?: number,
  ): void
  advance(dtMs: number, nowMs: number): boolean
  resolve(baseVeil: ArrayLike<number>): LegibilityParams
}

/** Creates the legibility state for one surface with a fixed foreground. */
export function createGlassLegibility(options: GlassLegibilityOptions): GlassLegibility {
  return new LegibilityDriver(options)
}

export class LegibilityDriver implements GlassLegibility {
  readonly params: LegibilityParams = createLegibilityParams()
  readonly probe: BackdropProbe | null
  private readonly goal: LegibilityGoal
  private readonly smoother = createAsymmetricSmoother(RISK_CHANNELS, LEGIBILITY_SMOOTHING)
  private readonly target = new Float32Array(RISK_CHANNELS)
  /** The risk the published params were resolved from. */
  private readonly committed = new Float32Array(RISK_CHANNELS)
  private readonly targetRisk: LegibilityRisk = { luma: 0, chroma: 0, detail: 0 }
  private readonly smoothedRisk: LegibilityRisk = { luma: 0, chroma: 0, detail: 0 }
  private readonly accumulator = createTelemetryAccumulator()
  private readonly sampled: BackdropTelemetry = {
    lumaHigh: 0,
    lumaLow: 0,
    channelHigh: 0,
    channelLow: 0,
    chroma: 0,
    detail: 0,
  }
  private readonly rectPool: Rect[] = []
  private readonly rects: Rect[] = []
  private injected: BackdropTelemetry | null = null
  private primed = false
  /** Set by `advance` (or a snap) and consumed by the next `resolve`. */
  private commitDue = false
  private tickSlot = Number.NaN
  /** `true` once the smoothed risk has reached its target; the frame loop may then sleep. */
  settled = true

  constructor(options: GlassLegibilityOptions) {
    this.goal = resolveLegibilityGoal(options)
    this.probe = options.probe ?? null
    this.smoother.reset(this.goal.policy.assumedRisk)
    this.committed.set(this.smoother.values)
  }

  setTelemetry(telemetry: BackdropTelemetry | null): void {
    this.injected = telemetry
  }

  /**
   * Updates the target risk for `field` placed at viewport offset (`originX`, `originY`).
   * Each active primitive is sampled separately and area-weighted, so the aggregate moves
   * continuously while N >= 2 primitives slide, merge or split; the AABB would count the gap.
   * `optics` and `saturation` are the host's backdrop adjustments, applied before the veil.
   */
  sample(
    field: GlassFieldState,
    originX: number,
    originY: number,
    baseVeil: ArrayLike<number>,
    optics?: BackdropVeilOptics,
    saturation?: number,
  ): void {
    let telemetry = this.injected
    if (!telemetry && this.probe) {
      const rects = this.rects
      rects.length = 0
      for (let i = 0; i < field.primitives.length; i++) {
        const p = field.primitives[i]!
        if (p.size.width <= MIN_ACTIVE_SIZE || p.size.height <= MIN_ACTIVE_SIZE) continue
        const rect = (this.rectPool[rects.length] ??= { x: 0, y: 0, width: 0, height: 0 })
        rect.x = originX + p.center.x - p.size.width * 0.5
        rect.y = originY + p.center.y - p.size.height * 0.5
        rect.width = p.size.width
        rect.height = p.size.height
        rects.push(rect)
      }
      this.accumulator.reset()
      this.probe.sample(rects, this.accumulator)
      if (this.accumulator.resolve(this.sampled)) telemetry = this.sampled
    }

    if (telemetry) {
      const risk = computeBackdropRisk(telemetry, this.goal, baseVeil, this.targetRisk, optics, saturation)
      this.target[0] = risk.luma
      this.target[1] = risk.chroma
      this.target[2] = risk.detail
    } else {
      this.target.fill(this.goal.policy.assumedRisk)
    }
    this.settled = false
    if (telemetry && !this.primed) {
      // The first real sample snaps instead of easing from the assumed risk, so a calm page
      // does not open with a film that then takes a full release to fade.
      this.smoother.reset(this.target)
      this.primed = true
      this.commitDue = true
    }
  }

  /**
   * Advances smoothing by `dtMs` at animation-frame time `nowMs`; returns whether the layers need
   * the response re-resolved. A due commit stays due until `resolve` consumes it, so a commit
   * deferred to a host render that never comes is still made on a later tick.
   */
  advance(dtMs: number, nowMs: number): boolean {
    this.settled = this.smoother.step(this.target, dtMs)
    const distance = this.distanceFromCommitted()
    const slot = Math.floor(nowMs / RISK_COMMIT_INTERVAL_MS)
    const slotStarted = slot !== this.tickSlot
    this.tickSlot = slot
    // Settling commits the exact target at once so nothing rests a deadband short.
    if (distance > 0 && (this.settled || (distance >= RISK_DEADBAND && slotStarted))) {
      this.commitDue = true
    }
    return this.commitDue
  }

  private distanceFromCommitted(): number {
    const values = this.smoother.values
    let distance = 0
    for (let i = 0; i < RISK_CHANNELS; i++) {
      distance = Math.max(distance, Math.abs(values[i]! - this.committed[i]!))
    }
    return distance
  }

  resolve(baseVeil: ArrayLike<number>): LegibilityParams {
    if (this.commitDue) {
      this.committed.set(this.smoother.values)
      this.commitDue = false
    }
    const values = this.committed
    this.smoothedRisk.luma = values[0]!
    this.smoothedRisk.chroma = values[1]!
    this.smoothedRisk.detail = values[2]!
    resolveLegibilityParams(this.goal, this.smoothedRisk, baseVeil, this.params)
    return this.params
  }
}
