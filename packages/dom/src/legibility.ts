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

export class LegibilityDriver {
  readonly params: LegibilityParams = createLegibilityParams()
  readonly probe: BackdropProbe | null
  private readonly goal: LegibilityGoal
  private readonly smoother = createAsymmetricSmoother(RISK_CHANNELS, LEGIBILITY_SMOOTHING)
  private readonly target = new Float32Array(RISK_CHANNELS)
  private readonly previous = new Float32Array(RISK_CHANNELS)
  private readonly targetRisk: LegibilityRisk = { luma: 0, chroma: 0, detail: 0 }
  private readonly smoothedRisk: LegibilityRisk = { luma: 0, chroma: 0, detail: 0 }
  private readonly accumulator = createTelemetryAccumulator()
  private readonly sampled: BackdropTelemetry = { lumaHigh: 0, lumaLow: 0, chroma: 0, detail: 0 }
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
    this.previous.set(this.smoother.values)
  }

  setTelemetry(telemetry: BackdropTelemetry | null): void {
    this.injected = telemetry
  }

  /**
   * Updates the target risk for `field` placed at viewport offset (`originX`, `originY`).
   * Each active primitive is sampled separately and area-weighted, so the aggregate moves
   * continuously while N >= 2 primitives slide, merge or split; the AABB would count the gap.
   * `optics` is the host's backdrop brightness/contrast, which the glass applies before the veil.
   */
  sample(
    field: GlassFieldState,
    originX: number,
    originY: number,
    baseVeil: ArrayLike<number>,
    optics?: BackdropVeilOptics,
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
      const risk = computeBackdropRisk(telemetry, this.goal, baseVeil, this.targetRisk, optics)
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
   * Advances smoothing by `dtMs`; returns whether the smoothed risk changed since the previous
   * advance. Comparing against that value rather than the pre-step one also reports the snap
   * `sample` applies outside the loop, which would otherwise never reach the layers.
   */
  advance(dtMs: number): boolean {
    const values = this.smoother.values
    this.settled = this.smoother.step(this.target, dtMs)
    let changed = false
    for (let i = 0; i < RISK_CHANNELS; i++) {
      if (values[i] !== this.previous[i]) changed = true
    }
    this.previous.set(values)
    return changed
  }

  resolve(baseVeil: ArrayLike<number>): LegibilityParams {
    const values = this.smoother.values
    this.smoothedRisk.luma = values[0]!
    this.smoothedRisk.chroma = values[1]!
    this.smoothedRisk.detail = values[2]!
    resolveLegibilityParams(this.goal, this.smoothedRisk, baseVeil, this.params)
    return this.params
  }
}
