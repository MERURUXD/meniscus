/**
 * Public entry point for `@sessile/core`.
 * Zero-dependency Live-DOM continuous glass morphing kernel.
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

export {
  buildRefractMapDataUrl,
  createRefractMapBuilder,
  type RefractMapBuilder,
  type RefractMapParams,
  type RefractMapResult,
} from './refractMap.ts'

export {
  MAX_REFRACT_TILE_PX,
  clearRefractTilesCache,
  resolveRefractTiles,
  type RefractTileParams,
  type RefractTilesResult,
} from './refractTiles.ts'

export {
  BEZEL_HEIGHT_PROFILES,
  CAUSTIC_FOLD_LIMIT,
  DEFAULT_REFRACTION_IOR,
  DEFAULT_REFRACTION_SAMPLES,
  NORMAL_FLOOR,
  computeRefractionProfileLut,
  getRefractionProfileKey,
  resolveRefractionProfileLut,
  sampleRefractionLut,
  traceBezelRay,
  type BezelHeightFn,
  type BezelHeightProfileName,
  type BezelRayTrace,
  type BezelRayTraceInput,
  type RefractionProfileLut,
  type RefractionProfileName,
  type RefractionProfileOptions,
  type RefractionProfileSpec,
} from './refractProfile.ts'

export {
  OVERLAY_FRAGMENT_SHADER,
  OVERLAY_VERTEX_SHADER,
  createGlassOverlayRenderer,
} from './overlayRenderer.ts'

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
  buildCircularBevelTable,
  buildColorOpticsMatrix,
  buildContourAlphaDataUrl,
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
  type CircularBevelTable,
  type ExtractedCssGlassSurface,
  type ParseCssGlassSurfaceInput,
  type ParsedBoxShadowLayer,
} from './optics.ts'

export {
  LEGIBILITY_CALM_KNEE,
  LEGIBILITY_LIMIT_MARGIN,
  LEGIBILITY_POLICIES,
  LEGIBILITY_SMOOTHING,
  LEGIBILITY_STAGES,
  LEGIBILITY_TABLE_SIZE,
  TELEMETRY_STRIDE,
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
} from './legibility.ts'
