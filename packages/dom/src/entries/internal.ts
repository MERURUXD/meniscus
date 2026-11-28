/**
 * `@sessile/dom/internal`: helpers shared with sibling packages and test harnesses.
 * Not part of the public contract: these may change in any release.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export { resetCapabilityCache } from '../capabilities.ts'

export { formatOpaqueSolidCss, parseCssBackdropBlur, parseCssBackdropSaturate } from '../cssSurface.ts'

export {
  DEFAULT_MAX_REFRACT_MAP_PIXELS,
  SVG_NS,
  computeAutoBezel,
  resolveEffectiveMapScale,
  resolveFieldBezel,
} from '../refractFilter.ts'

export { computeAutoSurfaceBounds } from '../surfaceController.ts'
