/**
 * Per-surface adaptive legibility state: goal, telemetry sampling, asymmetric smoothing and the
 * resolved material response that `GlassSurfaceController` applies to its layers.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  LEGIBILITY_SMOOTHING,
  computeBackdropRisk,
  createAsymmetricSmoother,
  createLegibilityParams,
  createTelemetryAccumulator,
  resolveLegibilityGoal,
  resolveLegibilityParams,
  type BackdropTelemetry,
  type BackdropVeilOptics,
  type GlassFieldState,
  type LegibilityGoal,
  type LegibilityParams,
  type LegibilityRisk,
  type LegibilityTarget,
  type Rect,
} from '@sessile/core'
import type { BackdropProbe } from './backdropProbe.ts'

export interface GlassLegibilityOptions extends LegibilityTarget {
  /** Live telemetry source; injected telemetry (`setBackdropTelemetry`) takes precedence. */
  probe?: BackdropProbe | null
}

const MIN_ACTIVE_SIZE = 0.01
const RISK_CHANNELS = 3
/**
 * Smoothed risk closer than this to the committed value does not re-resolve the response.
 * Measured against `resolveLegibilityParams` across tiers and polarities: 0.02 of risk moves no
 * output by more than ~1.1/255 (table, film, hairline alpha) or 0.12px of blur, about one 8-bit
 * step on a translucent film over moving content. Without it a scrolling backdrop nudges the
 * risk every frame, and each nudge rewrites the filter (Chromium rebuilds it) and redraws the
 * edge overlay.
 */
const RISK_DEADBAND = 0.02

export class LegibilityDriver {
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
    }
  }

  /**
   * Advances smoothing by `dtMs`; returns whether the layers need the response re-resolved.
   * Comparing against the committed risk rather than the pre-step value also reports the snap
   * `sample` applies outside the loop.
   */
  advance(dtMs: number): boolean {
    this.settled = this.smoother.step(this.target, dtMs)
    return this.pendingCommit()
  }

  /** Small moves wait in the deadband; settling commits the exact target so nothing rests short. */
  private pendingCommit(): boolean {
    const values = this.smoother.values
    let distance = 0
    for (let i = 0; i < RISK_CHANNELS; i++) {
      distance = Math.max(distance, Math.abs(values[i]! - this.committed[i]!))
    }
    return distance > 0 && (distance >= RISK_DEADBAND || this.settled)
  }

  resolve(baseVeil: ArrayLike<number>): LegibilityParams {
    if (this.pendingCommit()) this.committed.set(this.smoother.values)
    const values = this.committed
    this.smoothedRisk.luma = values[0]!
    this.smoothedRisk.chroma = values[1]!
    this.smoothedRisk.detail = values[2]!
    resolveLegibilityParams(this.goal, this.smoothedRisk, baseVeil, this.params)
    return this.params
  }
}
