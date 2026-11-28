/**
 * Public entry point for `@sessile/core`.
 * Zero-dependency Live-DOM continuous glass morphing kernel.
 *
 * Only the stable surface lives here. Optional modules ship as subpaths so bundles that never
 * import them pay nothing: `@sessile/core/overlay` (WebGL2/2D edge renderer) and
 * `@sessile/core/legibility` (adaptive legibility solver and backdrop telemetry).
 * `@sessile/core/internal` serves the sibling `@sessile/*` packages and carries no semver
 * guarantee.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  DEFAULT_OPTICAL_MATERIALS,
  DEFAULT_SPRINGS,
  MAX_GPU_PRIMITIVES,
  type EdgeInsets,
  type GlassFieldState,
  type GlassPrimitive,
  type IGlassOverlayRenderer,
  type OpticalMaterial,
  type OpticalPresetVariant,
  type OverlayRenderFrame,
  type Point,
  type Rect,
  type RendererCapabilities,
  type RimMode,
  type SdfSample,
  type Size,
  type SminSample,
  type SpringParams,
  type ThemeMode,
} from './contracts.ts'

export {
  computeFieldBounds,
  computePairMergeStatus,
  computeRoundedBoxDistance,
  computeRoundedBoxSdf,
  computeSmin,
  computeSminDistance,
  createPreparedField,
  evaluateFieldDistance,
  evaluateFieldSdf,
  prepareField,
  type PairMergeStatus,
  type PreparedField,
} from './sdf.ts'

export {
  extractFieldContourPath,
  formatRoundedRectPath,
} from './contour.ts'

export type { BezelHeightProfileName, RefractionProfileName } from './refractProfile.ts'

export {
  clamp,
  computeAreaPreservingScale,
  createElasticPressController,
  createMorphTimeline,
  createSpringChannel,
  cubicBezier,
  deformSizePreservingArea,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  evaluateSpring,
  evaluateSpringState,
  lerp,
  riseAndFall,
  smoothstep,
  type AreaPreservingScale,
  type ElasticPressController,
  type ElasticPressOptions,
  type ElasticPressState,
  type MorphTimeline,
  type MorphTimelineOptions,
  type MorphTimelinePhase,
  type MorphTimelineState,
  type SpringChannel,
  type SpringChannelOptions,
  type SpringChannelState,
  type SpringSample,
} from './physics.ts'

export {
  interpolateCssGlassSurfaceToMaterial,
  interpolateOpticalMaterial,
  interpolateVeilOptics,
  parseCssBoxShadow,
  parseCssFilterOptics,
  parseCssGlassSurface,
  parseCssRgba,
  tryParseCssRgba,
  resolveOpticalMaterial,
  type BackdropVeilOptics,
  type ExtractedCssGlassSurface,
  type ParseCssGlassSurfaceInput,
  type ParsedBoxShadowLayer,
} from './optics.ts'
