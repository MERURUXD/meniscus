/**
 * `@sessile/core/internal`: building blocks shared with the sibling `@sessile/*` packages
 * (displacement-map encoding, refraction LUTs, tile cache, raw shader sources).
 *
 * Not part of the public contract: these may change in any release. Siblings depend on an
 * exact core version, so they can rely on it; applications should not.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  buildRefractMapDataUrl,
  createRefractMapBuilder,
  type RefractMapBuilder,
  type RefractMapParams,
  type RefractMapResult,
} from '../refractMap.ts'

export {
  MAX_REFRACT_TILE_PX,
  clearRefractTilesCache,
  resolveRefractTiles,
  type RefractTileParams,
  type RefractTilesResult,
} from '../refractTiles.ts'

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
  type BezelRayTrace,
  type BezelRayTraceInput,
  type RefractionProfileLut,
  type RefractionProfileOptions,
  type RefractionProfileSpec,
} from '../refractProfile.ts'

export { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from '../overlayRenderer.ts'

export { buildCircularBevelTable, buildColorOpticsMatrix, buildContourAlphaDataUrl, type CircularBevelTable } from '../optics.ts'
