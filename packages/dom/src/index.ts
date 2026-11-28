/**
 * Public entry point for `@sessile/dom`.
 * Framework-agnostic headless Live-DOM glass surface driver built on `@sessile/core`.
 *
 * Two levels are public and stable here: `GlassSurfaceController` for resting and simple
 * animated surfaces, and the building blocks hosts use to drive their own morph layers
 * (`createRefractFilterController`, `buildBackdropFilterCss`, `computeClampedRefractBounds`,
 * the CSS surface readers and the frame helpers). Backdrop probes for the legibility solver
 * ship as `@sessile/dom/legibility`; `@sessile/dom/internal` carries no semver guarantee.
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
  formatRgbaCss,
  readElementGlassSurface,
  resolveElementTheme,
  type BuildBackdropFilterCssParams,
  type BuildMaterialFromCssSurfaceOptions,
  type MeasuredCssGlassSurface,
  type ReadElementGlassSurfaceOptions,
  type ResolveElementThemeOptions,
} from './cssSurface.ts'

export {
  createRefractFilterController,
  type RefractFilterConfig,
  type RefractFilterController,
  type RefractFilterControllerOptions,
  type RefractFilterFrame,
} from './refractFilter.ts'

export {
  GlassSurfaceController,
  computeClampedRefractBounds,
  createGlassSurfaceController,
  type GlassSurfaceCapabilities,
  type GlassSurfaceControllerOptions,
  type GlassSurfaceElements,
  type GlassSurfaceFrame,
  type GlassSurfaceZIndex,
  type SurfaceFrameProducer,
} from './surfaceController.ts'

export type { BackdropProbe } from './backdropProbe.ts'

export type { GlassLegibilityOptions } from './legibility.ts'
