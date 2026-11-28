/**
 * `@sessile/core/legibility`: adaptive legibility solver, backdrop telemetry and the sRGB
 * luminance helpers it is built on. Optional: surfaces that never enable legibility do not
 * need this module.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  LEGIBILITY_CALM_KNEE,
  LEGIBILITY_LIMIT_MARGIN,
  LEGIBILITY_POLICIES,
  LEGIBILITY_SMOOTHING,
  LEGIBILITY_STAGES,
  LEGIBILITY_TABLE_SIZE,
  TELEMETRY_STRIDE,
  compensateLegibilityEdges,
  computeBackdropRisk,
  contrastRatio,
  createAsymmetricSmoother,
  createLegibilityParams,
  createTelemetryAccumulator,
  linearToSrgb,
  measureTelemetryGrid,
  relativeLuminance,
  srgbLuma,
  resolveLegibilityGoal,
  resolveLegibilityParams,
  srgbToLinear,
  type AsymmetricSmoother,
  type AsymmetricSmootherOptions,
  type BackdropTelemetry,
  type BackdropTelemetryAccumulator,
  type BackdropTelemetryGrid,
  type ForegroundPolarity,
  type LegibilityGoal,
  type LegibilityParams,
  type LegibilityPolicy,
  type LegibilityRisk,
  type LegibilityTarget,
  type LegibilityTier,
} from '../legibility.ts'
