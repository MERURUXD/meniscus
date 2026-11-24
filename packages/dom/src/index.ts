/**
 * Public entry point for `@sessile/dom`.
 * Framework-agnostic headless Live-DOM glass surface driver built on `@sessile/core`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  cancelAnimationFrameSafe,
  createFrameLoop,
  detectSurfaceCapabilities,
  measureElementBorderBox,
  observeElementResize,
  observeReducedMotion,
  prefersReducedMotion,
  resetCapabilityCache,
  resolveEffectiveRenderMode,
  scheduleAnimationFrame,
  supportsSvgBackdropRefraction,
  type CapabilityEnv,
  type FrameLoop,
  type FrameScheduler,
  type ObserveElementResizeOptions,
  type SurfaceCapabilities,
  type SurfaceRenderMode,
} from './capabilities.ts'

export {
  buildBackdropFilterCss,
  buildMaterialFromCssSurface,
  formatOpaqueSolidCss,
  formatRgbaCss,
  parseCssBackdropBlur,
  parseCssBackdropSaturate,
  readElementGlassSurface,
  resolveElementTheme,
  type BuildBackdropFilterCssParams,
  type BuildMaterialFromCssSurfaceOptions,
  type MeasuredCssGlassSurface,
  type ReadElementGlassSurfaceOptions,
  type ResolveElementThemeOptions,
} from './cssSurface.ts'

export {
  DEFAULT_MAX_REFRACT_MAP_PIXELS,
  SVG_NS,
  computeAutoBezel,
  createRefractFilterController,
  resolveEffectiveMapScale,
  resolveFieldBezel,
  type RefractFilterConfig,
  type RefractFilterController,
  type RefractFilterControllerOptions,
  type RefractFilterFrame,
} from './refractFilter.ts'

export {
  GlassSurfaceController,
  computeAutoSurfaceBounds,
  computeClampedRefractBounds,
  createGlassSurfaceController,
  type GlassSurfaceCapabilities,
  type GlassSurfaceControllerOptions,
  type GlassSurfaceElements,
  type GlassSurfaceFrame,
  type GlassSurfaceZIndex,
  type SurfaceFrameProducer,
} from './surfaceController.ts'
