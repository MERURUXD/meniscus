/**
 * @meniscus/core 统一公共入口。
 * 零外部运行时依赖的 Live-DOM 动态玻璃连续形变内核。
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
  OVERLAY_FRAGMENT_SHADER,
  OVERLAY_VERTEX_SHADER,
  createGlassOverlayRenderer,
} from './overlayRenderer.ts'

export {
  clamp,
  createElasticPressController,
  createMorphTimeline,
  createSpringChannel,
  cubicBezier,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  evaluateSpring,
  evaluateSpringState,
  lerp,
  riseAndFall,
  smoothstep,
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
  resolveOpticalMaterial,
  type BackdropVeilOptics,
  type CircularBevelTable,
  type ExtractedCssGlassSurface,
  type ParseCssGlassSurfaceInput,
  type ParsedBoxShadowLayer,
} from './optics.ts'
