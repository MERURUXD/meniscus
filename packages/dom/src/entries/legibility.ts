/**
 * `@sessile/dom/legibility`: adaptive legibility for `GlassSurfaceController.setLegibility` and
 * the backdrop probes that feed it. Kept off the main entry so surfaces that never enable
 * legibility skip the solver.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  createRegionProbe,
  measureImageTelemetry,
  type BackdropProbe,
  type MeasureImageTelemetryOptions,
  type RegionProbe,
  type RegionProbeOptions,
} from '../backdropProbe.ts'

export {
  createGlassLegibility,
  type GlassLegibility,
  type GlassLegibilityOptions,
} from '../legibility.ts'
