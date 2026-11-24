/**
 * Shared LRU-cached 9-slice Stored-PNG (`BTYPE=00`) displacement & alpha tile generator
 * for single-primitive rounded-rectangle glass lenses.
 *
 * Encodes only the 4 `tilePx x tilePx` corner patches and 4 1D edge strips (`1 x tilePx`
 * horizontal / `tilePx x 1` vertical) using Snell's Law LUT refraction and exact
 * `cornerBend` (`radius < bezel`) geometry, letting Chromium SVG `<feMerge>` stretch edges
 * and `<feFlood>` fill the plateau interior with zero rasterization during size animations
 * and across shared radii.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  clampAmp,
  clampChannel,
  computeCornerGeometry,
  encodeStoredRgbaPngDataUrl,
  ensureScanlineCapacity,
  tmpCornerGeom,
} from './refractMap.ts'
import {
  DEFAULT_REFRACTION_IOR,
  getRefractionProfileKey,
  resolveRefractionProfileLut,
  sampleRefractionLut,
  type RefractionProfileSpec,
} from './refractProfile.ts'

export const MAX_REFRACT_TILE_PX = 128

const DEFAULT_THICKNESS_RATIO = 1
const TILE_CACHE_MAX_ENTRIES = 64
const SQRT1_2 = Math.SQRT1_2

export interface RefractTileParams {
  /** Corner radius in CSS px. */
  radius: number
  /** Effective lens bezel width in CSS px. */
  bezel: number
  /** Optional logical CSS corner tile size; defaults to `ceil(max(radius, bezel))`. */
  slice?: number
  /** Refraction cross-section profile (`'squircle'`, `'circle'`, `'parabolic'`, `'lip'`, or custom height fn). */
  profile?: RefractionProfileSpec
  /** Index of refraction (`1` = air, `1.5` = glass; defaults to `1.5`). */
  ior?: number
  /** Glass plateau thickness divided by bezel width (defaults to `1`). */
  thicknessRatio?: number
  /** Allow steep-edge caustic folds (defaults to `false`). */
  caustics?: boolean
}

export interface RefractTilesResult {
  /** Quantized cache key uniquely identifying the 8 encoded tile data URLs and peak scale. */
  key: string
  /** Logical CSS px size of each corner tile and thickness of each edge strip. */
  slice: number
  /** Pixel resolution encoded along each corner tile axis and strip thickness (`<= MAX_REFRACT_TILE_PX`). */
  tilePx: number
  /** Clamped effective bezel width (`<= slice`) matching the tile displacement encoding. */
  bezel: number
  /** Peak horizontal displacement in CSS px for `feDisplacementMap` scale calibration. */
  maxDisplacementPx: number
  /** Top-left `tilePx x tilePx` Stored-PNG data URL. */
  tl: string
  /** Top-right `tilePx x tilePx` Stored-PNG data URL. */
  tr: string
  /** Bottom-left `tilePx x tilePx` Stored-PNG data URL. */
  bl: string
  /** Bottom-right `tilePx x tilePx` Stored-PNG data URL. */
  br: string
  /** Top `1 x tilePx` Stored-PNG edge strip data URL. */
  top: string
  /** Bottom `1 x tilePx` Stored-PNG edge strip data URL. */
  bottom: string
  /** Left `tilePx x 1` Stored-PNG edge strip data URL. */
  left: string
  /** Right `tilePx x 1` Stored-PNG edge strip data URL. */
  right: string
}

const tileCache = new Map<string, RefractTilesResult>()

/** Clears the module-level 9-slice Stored-PNG tile LRU cache (primarily for deterministic tests). */
export function clearRefractTilesCache(): void {
  tileCache.clear()
}

function encodeCornerTile(
  slice: number,
  tilePx: number,
  rad: number,
  effBezel: number,
  invBezel: number,
  interiorGate: number,
  bendCorners: boolean,
  normLut: Float32Array,
  hasDisplacement: boolean,
  sx: -1 | 1,
  sy: -1 | 1,
): string {
  const rowBytes = 1 + tilePx * 4
  const scanlines = ensureScanlineCapacity(tilePx * rowBytes)
  const step = slice / tilePx

  let offset = 0
  for (let py = 0; py < tilePx; py++) {
    scanlines[offset++] = 0 // PNG filter type 0 (None)
    const ly = (py + 0.5) * step
    // Distance inward from outer top (`sy < 0`) or bottom (`sy > 0`) edge.
    const edgeY = sy < 0 ? ly : slice - ly
    const qy = rad - edgeY
    const qyPos = qy > 0

    for (let px = 0; px < tilePx; px++) {
      const lx = (px + 0.5) * step
      // Distance inward from outer left (`sx < 0`) or right (`sx > 0`) edge.
      const edgeX = sx < 0 ? lx : slice - lx
      const qx = rad - edgeX

      let sd: number
      let gx: number
      let gy: number

      if (qx > 0 && qyPos) {
        const outLen = Math.hypot(qx, qy)
        sd = outLen - rad
        if (outLen > 1e-6) {
          const invLen = 1 / outLen
          gx = sx * qx * invLen
          gy = sy * qy * invLen
        } else {
          gx = sx * SQRT1_2
          gy = sy * SQRT1_2
        }
      } else if (qx > qy) {
        sd = qx - rad
        gx = sx
        gy = 0
      } else {
        sd = qy - rad
        gx = 0
        gy = sy
      }

      if (sd >= 0.5) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 0
      } else if (sd <= interiorGate) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 255
      } else {
        const distIn = sd < 0 ? -sd : 0
        const alpha = sd <= -0.5 ? 255 : Math.round((0.5 - sd) * 255)
        if (!hasDisplacement) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
          continue
        }
        if (bendCorners && edgeX < effBezel && edgeY < effBezel) {
          computeCornerGeometry(
            edgeX > 0 ? edgeX : 0,
            edgeY > 0 ? edgeY : 0,
            rad,
            effBezel,
          )
          const amp = clampAmp(sampleRefractionLut(normLut, tmpCornerGeom[2] * invBezel) * 127)
          scanlines[offset++] = clampChannel(Math.round(128 - sx * tmpCornerGeom[0] * amp))
          scanlines[offset++] = clampChannel(Math.round(128 - sy * tmpCornerGeom[1] * amp))
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else if (distIn >= effBezel) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else {
          const amp = clampAmp(sampleRefractionLut(normLut, distIn * invBezel) * 127)
          scanlines[offset++] = clampChannel(Math.round(128 - gx * amp))
          scanlines[offset++] = clampChannel(Math.round(128 - gy * amp))
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        }
      }
    }
  }

  return encodeStoredRgbaPngDataUrl(scanlines, tilePx, tilePx)
}

function encodeHorizontalEdgeStrip(
  slice: number,
  tilePx: number,
  effBezel: number,
  invBezel: number,
  normLut: Float32Array,
  hasDisplacement: boolean,
  sy: -1 | 1,
): string {
  // 1px wide by `tilePx` tall: 1 filter byte + 4 RGBA bytes per scanline.
  const scanlines = ensureScanlineCapacity(tilePx * 5)
  const step = slice / tilePx

  let offset = 0
  for (let py = 0; py < tilePx; py++) {
    scanlines[offset++] = 0
    const ly = (py + 0.5) * step
    const edgeY = sy < 0 ? ly : slice - ly
    const sd = -edgeY
    const alpha = sd <= -0.5 ? 255 : Math.round((0.5 - sd) * 255)
    if (!hasDisplacement || edgeY >= effBezel) {
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = alpha
    } else {
      const amp = clampAmp(sampleRefractionLut(normLut, edgeY * invBezel) * 127)
      scanlines[offset++] = 128
      scanlines[offset++] = clampChannel(Math.round(128 - sy * amp))
      scanlines[offset++] = 128
      scanlines[offset++] = alpha
    }
  }

  return encodeStoredRgbaPngDataUrl(scanlines, 1, tilePx)
}

function encodeVerticalEdgeStrip(
  slice: number,
  tilePx: number,
  effBezel: number,
  invBezel: number,
  normLut: Float32Array,
  hasDisplacement: boolean,
  sx: -1 | 1,
): string {
  // `tilePx` wide by 1px tall: 1 filter byte + `tilePx * 4` RGBA bytes.
  const scanlines = ensureScanlineCapacity(1 + tilePx * 4)
  const step = slice / tilePx

  let offset = 0
  scanlines[offset++] = 0
  for (let px = 0; px < tilePx; px++) {
    const lx = (px + 0.5) * step
    const edgeX = sx < 0 ? lx : slice - lx
    const sd = -edgeX
    const alpha = sd <= -0.5 ? 255 : Math.round((0.5 - sd) * 255)
    if (!hasDisplacement || edgeX >= effBezel) {
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = alpha
    } else {
      const amp = clampAmp(sampleRefractionLut(normLut, edgeX * invBezel) * 127)
      scanlines[offset++] = clampChannel(Math.round(128 - sx * amp))
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = alpha
    }
  }

  return encodeStoredRgbaPngDataUrl(scanlines, tilePx, 1)
}

/**
 * Generates (or retrieves from the 64-entry LRU cache) the 8 Stored-PNG 9-slice tiles
 * (`tl`, `tr`, `bl`, `br`, `top`, `bottom`, `left`, `right`) for a single rounded-rect lens.
 */
export function resolveRefractTiles(params: RefractTileParams): RefractTilesResult {
  const rawRad = Number.isFinite(params.radius) ? Math.max(0, params.radius) : 0
  const rawBezel = Number.isFinite(params.bezel) ? Math.max(1e-3, params.bezel) : 1
  const slice =
    params.slice !== undefined && Number.isFinite(params.slice)
      ? Math.max(2, params.slice)
      : Math.max(2, Math.ceil(Math.max(rawRad, rawBezel)))
  const rad = Math.min(rawRad, slice)
  const effBezel = Math.min(rawBezel, slice)
  const tilePx = Math.max(2, Math.min(MAX_REFRACT_TILE_PX, Math.ceil(slice)))

  const safeIor =
    params.ior !== undefined && Number.isFinite(params.ior)
      ? Math.max(1, params.ior)
      : DEFAULT_REFRACTION_IOR
  const safeRatio =
    params.thicknessRatio !== undefined && Number.isFinite(params.thicknessRatio)
      ? Math.max(0, params.thicknessRatio)
      : DEFAULT_THICKNESS_RATIO
  const caustics = Boolean(params.caustics)
  const profileSpec = params.profile ?? 'squircle'
  const profileKey = getRefractionProfileKey(profileSpec)

  const key =
    `${Math.round(slice * 100)}:${tilePx}:${Math.round(rad * 4)}:${Math.round(effBezel * 4)}:` +
    `${profileKey}:${Math.round(safeIor * 100)}:${Math.round(safeRatio * 100)}:${caustics ? 1 : 0}`

  const cached = tileCache.get(key)
  if (cached) {
    tileCache.delete(key)
    tileCache.set(key, cached)
    return cached
  }

  const lut = resolveRefractionProfileLut({
    profile: profileSpec,
    ior: safeIor,
    thicknessRatio: safeRatio,
    caustics,
  })
  const normLut = lut.normalizedDisplacement
  const hasDisplacement = lut.maxDisplacementRatio > 1e-6
  const maxDisplacementPx = effBezel * lut.maxDisplacementRatio
  const invBezel = 1 / effBezel
  const bendCorners = rad > 0 && rad < effBezel
  const interiorGate = -Math.max(effBezel, 0.5)

  const result: RefractTilesResult = {
    key,
    slice,
    tilePx,
    bezel: effBezel,
    maxDisplacementPx,
    tl: encodeCornerTile(slice, tilePx, rad, effBezel, invBezel, interiorGate, bendCorners, normLut, hasDisplacement, -1, -1),
    tr: encodeCornerTile(slice, tilePx, rad, effBezel, invBezel, interiorGate, bendCorners, normLut, hasDisplacement, 1, -1),
    bl: encodeCornerTile(slice, tilePx, rad, effBezel, invBezel, interiorGate, bendCorners, normLut, hasDisplacement, -1, 1),
    br: encodeCornerTile(slice, tilePx, rad, effBezel, invBezel, interiorGate, bendCorners, normLut, hasDisplacement, 1, 1),
    top: encodeHorizontalEdgeStrip(slice, tilePx, effBezel, invBezel, normLut, hasDisplacement, -1),
    bottom: encodeHorizontalEdgeStrip(slice, tilePx, effBezel, invBezel, normLut, hasDisplacement, 1),
    left: encodeVerticalEdgeStrip(slice, tilePx, effBezel, invBezel, normLut, hasDisplacement, -1),
    right: encodeVerticalEdgeStrip(slice, tilePx, effBezel, invBezel, normLut, hasDisplacement, 1),
  }

  if (tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
    const oldestKey = tileCache.keys().next().value
    if (oldestKey !== undefined) {
      tileCache.delete(oldestKey)
    }
  }
  tileCache.set(key, result)
  return result
}
