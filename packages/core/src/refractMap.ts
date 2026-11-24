/**
 * 0.5x Stored-PNG (`BTYPE=00`) RGBA displacement and inward-AA alpha map generator.
 *
 * Analytically evaluates the N-primitive rounded-rect `smin` SDF field for SVG
 * `feDisplacementMap` liquid glass refraction and encodes a zero-compression Stored-PNG
 * data URL using reusable TypedArray buffers, 4-table slicing CRC32, and chunked Adler32
 * to avoid per-frame GC allocations.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { GlassFieldState, GlassPrimitive, Rect } from './contracts.ts'
import {
  DEFAULT_REFRACTION_IOR,
  NORMAL_FLOOR,
  getRefractionProfileKey,
  resolveRefractionProfileLut,
  sampleRefractionLut,
  type RefractionProfileLut,
  type RefractionProfileSpec,
} from './refractProfile.ts'

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_IEND = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const MAX_DEFLATE_BLOCK = 65535
const DEFAULT_MAP_SCALE = 0.5
const DEFAULT_THICKNESS_RATIO = 1
const MIN_PRIMITIVE_SIZE = 0.01
const SQRT1_2 = Math.SQRT1_2

type Uint8ArrayWithToBase64 = Uint8Array & { toBase64?: () => string }

export interface RefractMapParams {
  bounds: Rect
  field: GlassFieldState
  bezel: number
  mapScale?: number
  /** Refraction cross-section profile (`'squircle'`, `'circle'`, `'parabolic'`, `'lip'`, or custom height fn). */
  profile?: RefractionProfileSpec
  /** Index of refraction (`1` = air, `1.5` = glass; defaults to `1.5`). */
  ior?: number
  /** Glass plateau thickness divided by bezel width (defaults to `1`). */
  thicknessRatio?: number
  /** Allow steep-edge caustic folds (defaults to `false`). */
  caustics?: boolean
}

export interface RefractMapResult {
  dataUrl: string
  width: number
  height: number
  changed: boolean
  /** Peak absolute horizontal displacement in CSS px for `feDisplacementMap` scale calibration. */
  maxDisplacementPx: number
}

export interface RefractMapBuilder {
  build(params: RefractMapParams): RefractMapResult
  reset(): void
}

// 4-table slicing IEEE 802.3 CRC32 lookup (1024 x uint32).
const CRC_TABLES = (() => {
  const tables = new Uint32Array(1024)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    tables[i] = c >>> 0
  }
  for (let t = 1; t < 4; t++) {
    const prevBase = (t - 1) * 256
    const curBase = t * 256
    for (let i = 0; i < 256; i++) {
      const prev = tables[prevBase + i]
      tables[curBase + i] = ((prev >>> 8) ^ tables[prev & 0xff]) >>> 0
    }
  }
  return tables
})()

function crc32(bytes: Uint8Array, start: number, length: number): number {
  let crc = 0xffffffff
  let i = start
  const end4 = start + (length & ~3)
  while (i < end4) {
    const w =
      (crc ^
        (bytes[i] |
          (bytes[i + 1] << 8) |
          (bytes[i + 2] << 16) |
          (bytes[i + 3] << 24))) >>>
      0
    crc =
      (CRC_TABLES[768 + (w & 0xff)] ^
        CRC_TABLES[512 + ((w >>> 8) & 0xff)] ^
        CRC_TABLES[256 + ((w >>> 16) & 0xff)] ^
        CRC_TABLES[(w >>> 24) & 0xff]) >>>
      0
    i += 4
  }
  const end = start + length
  while (i < end) {
    crc = (CRC_TABLES[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0
    i++
  }
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array, length: number): number {
  let s1 = 1
  let s2 = 0
  let i = 0
  while (i < length) {
    let chunkEnd = i + 5550
    if (chunkEnd > length) chunkEnd = length
    while (i < chunkEnd) {
      s1 += bytes[i++]
      s2 += s1
    }
    s1 %= 65521
    s2 %= 65521
  }
  return ((s2 << 16) | s1) >>> 0
}

function writeU32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff
  buf[offset + 1] = (val >>> 16) & 0xff
  buf[offset + 2] = (val >>> 8) & 0xff
  buf[offset + 3] = val & 0xff
}

function uint8ToBase64(bytes: Uint8Array, length: number): string {
  const view = bytes.subarray(0, length) as Uint8ArrayWithToBase64
  if (typeof view.toBase64 === 'function') {
    return view.toBase64()
  }
  const chunkSize = 0x2000
  const chunks: string[] = []
  for (let i = 0; i < length; i += chunkSize) {
    const end = Math.min(i + chunkSize, length)
    chunks.push(String.fromCharCode(...view.subarray(i, end)))
  }
  return btoa(chunks.join(''))
}

// Module-level reusable buffers to avoid per-frame GC churn at 60/120fps.
let scanlineBuf = new Uint8Array(0)
let pngOutBuf = new Uint8Array(0)

// Pre-allocated SoA buffers for the N >= 3 multi-primitive path, doubling capacity on growth.
let soaCapacity = 0
let soaCx = new Float64Array(0)
let soaCy = new Float64Array(0)
let soaHalfW = new Float64Array(0)
let soaHalfH = new Float64Array(0)
let soaRad = new Float64Array(0)
let soaInnerW = new Float64Array(0)
let soaInnerH = new Float64Array(0)
let soaBezel = new Float64Array(0)
let soaInvBezel = new Float64Array(0)
let soaMinX = new Float64Array(0)
let soaMaxX = new Float64Array(0)
let soaMinY = new Float64Array(0)
let soaMaxY = new Float64Array(0)
let rowDySigned = new Float64Array(0)
let rowAbsDy = new Float64Array(0)
let rowQy = new Float64Array(0)
let rowSy = new Float64Array(0)

/** @internal Reusable 3-element scratch vector [ux, uy, distIn] for corner-bend geometry without heap allocation. */
export const tmpCornerGeom = new Float64Array(3)
// Reusable 2-element scratch vector for corner-bend outward unit gradient without heap allocation.
const tmpCornerDir = new Float64Array(2)

// Reusable index buffer for active primitives per build, avoiding per-frame array allocations.
let activeIndicesBuf = new Int32Array(0)

/** @internal */
export function ensureScanlineCapacity(needed: number): Uint8Array {
  if (scanlineBuf.length < needed) {
    scanlineBuf = new Uint8Array(Math.max(needed, scanlineBuf.length * 2, 16384))
  }
  return scanlineBuf
}

function ensurePngOutCapacity(needed: number): Uint8Array {
  if (pngOutBuf.length < needed) {
    pngOutBuf = new Uint8Array(Math.max(needed, pngOutBuf.length * 2, 32768))
  }
  return pngOutBuf
}

function ensureActiveIndicesCapacity(needed: number): Int32Array {
  if (activeIndicesBuf.length < needed) {
    activeIndicesBuf = new Int32Array(Math.max(needed, activeIndicesBuf.length * 2, 16))
  }
  return activeIndicesBuf
}

function ensureSoaCapacity(needed: number): void {
  if (soaCapacity >= needed) return
  const nextCap = Math.max(needed, soaCapacity * 2, 16)
  soaCapacity = nextCap
  soaCx = new Float64Array(nextCap)
  soaCy = new Float64Array(nextCap)
  soaHalfW = new Float64Array(nextCap)
  soaHalfH = new Float64Array(nextCap)
  soaRad = new Float64Array(nextCap)
  soaInnerW = new Float64Array(nextCap)
  soaInnerH = new Float64Array(nextCap)
  soaBezel = new Float64Array(nextCap)
  soaInvBezel = new Float64Array(nextCap)
  soaMinX = new Float64Array(nextCap)
  soaMaxX = new Float64Array(nextCap)
  soaMinY = new Float64Array(nextCap)
  soaMaxY = new Float64Array(nextCap)
  rowDySigned = new Float64Array(nextCap)
  rowAbsDy = new Float64Array(nextCap)
  rowQy = new Float64Array(nextCap)
  rowSy = new Float64Array(nextCap)
}

/** @internal */
export function encodeStoredRgbaPngDataUrl(
  scanlines: Uint8Array,
  pngW: number,
  pngH: number,
): string {
  const rowBytes = 1 + pngW * 4
  const rawLen = pngH * rowBytes
  const numBlocks = Math.max(1, Math.ceil(rawLen / MAX_DEFLATE_BLOCK))
  const zlibLen = 2 + rawLen + numBlocks * 5 + 4
  // 8 (signature) + 25 (IHDR) + 12 + zlibLen (IDAT) + 12 (IEND)
  const totalLen = 57 + zlibLen
  const out = ensurePngOutCapacity(totalLen)

  // PNG signature (0..7)
  out.set(PNG_SIGNATURE, 0)

  // IHDR chunk (8..32)
  writeU32BE(out, 8, 13)
  out[12] = 73 // 'I'
  out[13] = 72 // 'H'
  out[14] = 68 // 'D'
  out[15] = 82 // 'R'
  writeU32BE(out, 16, pngW)
  writeU32BE(out, 20, pngH)
  out[24] = 8 // 8-bit depth
  out[25] = 6 // RGBA color type
  out[26] = 0 // compression method
  out[27] = 0 // filter method
  out[28] = 0 // non-interlaced
  writeU32BE(out, 29, crc32(out, 12, 17))

  // IDAT chunk header (33..40)
  writeU32BE(out, 33, zlibLen)
  out[37] = 73 // 'I'
  out[38] = 68 // 'D'
  out[39] = 65 // 'A'
  out[40] = 84 // 'T'

  // Zlib header (CMF=0x78, FLG=0x01)
  out[41] = 0x78
  out[42] = 0x01

  let dst = 43
  let src = 0
  let remaining = rawLen
  while (remaining > 0 || src === 0) {
    const blockLen = remaining > MAX_DEFLATE_BLOCK ? MAX_DEFLATE_BLOCK : remaining
    const isFinal = remaining - blockLen <= 0
    out[dst++] = isFinal ? 0x01 : 0x00
    out[dst++] = blockLen & 0xff
    out[dst++] = (blockLen >>> 8) & 0xff
    const nlen = (~blockLen) & 0xffff
    out[dst++] = nlen & 0xff
    out[dst++] = (nlen >>> 8) & 0xff
    if (blockLen > 0) {
      out.set(scanlines.subarray(src, src + blockLen), dst)
      dst += blockLen
      src += blockLen
      remaining -= blockLen
    } else {
      break
    }
  }

  // Adler32 trailer + IDAT CRC32
  writeU32BE(out, dst, adler32(scanlines, rawLen))
  dst += 4
  writeU32BE(out, dst, crc32(out, 37, 4 + zlibLen))
  dst += 4

  // IEND chunk
  out.set(PNG_IEND, dst)
  dst += 12

  return `data:image/png;base64,${uint8ToBase64(out, dst)}`
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/** @internal */
export function clampAmp(v: number): number {
  return v <= -127 ? -127 : v >= 127 ? 127 : v
}

/** @internal */
export function clampChannel(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : v
}

function quant4(v: number): number {
  return Math.round(v * 4)
}

function quant100(v: number): number {
  return Math.round(v * 100)
}

/**
 * @internal
 * Solves corner-bend inward distance and first-quadrant outward unit direction
 * into `tmpCornerGeom` (`[ux, uy, distIn]`) without heap allocations.
 */
export function computeCornerGeometry(
  x: number,
  y: number,
  radius: number,
  bezel: number,
): void {
  let lo = 0
  let hi = Math.min(x, y, bezel)
  for (let i = 0; i < 10; i++) {
    const distance = (lo + hi) * 0.5
    const u = 1 - distance / bezel
    const centerCoord = bezel - (bezel - radius) * u * u
    const dx = centerCoord - x
    const dy = centerCoord - y
    const cx = dx > 0 ? dx : 0
    const cy = dy > 0 ? dy : 0
    if (Math.hypot(cx, cy) <= centerCoord - distance) {
      lo = distance
    } else {
      hi = distance
    }
  }
  const u = 1 - lo / bezel
  const centerCoord = bezel - (bezel - radius) * u * u
  const nx = centerCoord - x > 0 ? centerCoord - x : 0
  const ny = centerCoord - y > 0 ? centerCoord - y : 0
  const normal = Math.hypot(nx, ny)
  if (normal <= 1e-6) {
    tmpCornerGeom[0] = x < y ? 1 : 0
    tmpCornerGeom[1] = x < y ? 0 : 1
  } else {
    const invN = 1 / normal
    tmpCornerGeom[0] = nx * invN
    tmpCornerGeom[1] = ny * invN
  }
  tmpCornerGeom[2] = lo
}

/**
 * Computes the unit outward gradient matching `computeCornerGeometry` inward deflection,
 * stored into `tmpCornerDir` to avoid per-pixel allocations in blend zones.
 */
function computeCornerBendOutwardDir(
  edgeX: number,
  edgeY: number,
  rad: number,
  bezel: number,
  sx: number,
  sy: number,
): void {
  computeCornerGeometry(
    edgeX > 0 ? edgeX : 0,
    edgeY > 0 ? edgeY : 0,
    rad,
    bezel,
  )
  tmpCornerDir[0] = sx * tmpCornerGeom[0]
  tmpCornerDir[1] = sy * tmpCornerGeom[1]
}

function collectActivePrimitiveIndices(primitives: readonly GlassPrimitive[]): number {
  const len = primitives.length
  const indices = ensureActiveIndicesCapacity(len)
  let count = 0
  for (let i = 0; i < len; i++) {
    const p = primitives[i]
    if (p.size.width > MIN_PRIMITIVE_SIZE && p.size.height > MIN_PRIMITIVE_SIZE) {
      indices[count++] = i
    }
  }
  return count
}

function buildQuantizedKey(
  cssW: number,
  cssH: number,
  pngW: number,
  pngH: number,
  bounds: Rect,
  primitives: readonly GlassPrimitive[],
  activeCount: number,
  blendK: number,
  bezel: number,
  profileKey: string,
  ior: number,
  thicknessRatio: number,
  caustics: boolean,
): string {
  const base =
    `${cssW}:${cssH}:${pngW}:${pngH}:${quant4(bounds.x)}:${quant4(bounds.y)}:` +
    `${quant4(bezel)}:${quant4(blendK)}:` +
    `${profileKey}:${quant100(ior)}:${quant100(thicknessRatio)}:${caustics ? 1 : 0}`
  if (activeCount === 0) {
    return `${base}:EMPTY`
  }
  let key = base
  for (let i = 0; i < activeCount; i++) {
    const p = primitives[activeIndicesBuf[i]]
    key +=
      `:${quant4(p.center.x)}:${quant4(p.center.y)}:` +
      `${quant4(p.size.width)}:${quant4(p.size.height)}:${quant4(p.radius)}`
  }
  return key
}

function rasterizeEmptyScanlines(
  scanlines: Uint8Array,
  pngW: number,
  pngH: number,
): void {
  let offset = 0
  for (let py = 0; py < pngH; py++) {
    scanlines[offset++] = 0 // PNG filter type 0 (None)
    for (let px = 0; px < pngW; px++) {
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = 128
      scanlines[offset++] = 0
    }
  }
}

function rasterizeSingleRectScanlines(
  scanlines: Uint8Array,
  pngW: number,
  pngH: number,
  originX: number,
  originY: number,
  stepX: number,
  stepY: number,
  shape: GlassPrimitive,
  safeBezel: number,
  lut: RefractionProfileLut,
): void {
  const cx = shape.center.x
  const cy = shape.center.y
  const halfW = Math.max(0.001, shape.size.width * 0.5)
  const halfH = Math.max(0.001, shape.size.height * 0.5)
  const effBezel = Math.max(1e-3, Math.min(safeBezel, halfW, halfH))
  const rad = Math.max(0, Math.min(shape.radius, halfW, halfH))
  const innerW = halfW - rad
  const innerH = halfH - rad
  const invBezel = 1 / effBezel
  const interiorGate = -Math.max(effBezel, 0.5)
  const bendCorners = rad > 0 && rad < effBezel
  const normLut = lut.normalizedDisplacement
  const hasDisplacement = lut.maxDisplacementRatio > 1e-6
  const localScale = effBezel / safeBezel

  let offset = 0
  for (let py = 0; py < pngH; py++) {
    scanlines[offset++] = 0 // PNG filter type 0 (None)
    const dy = originY + py * stepY - cy
    const absDy = dy < 0 ? -dy : dy
    const sy = dy >= 0 ? 1 : -1
    const qy = absDy - innerH
    const qyPos = qy > 0
    const edgeY = halfH - absDy

    for (let px = 0; px < pngW; px++) {
      const dx = originX + px * stepX - cx
      const absDx = dx < 0 ? -dx : dx
      const sx = dx >= 0 ? 1 : -1
      const qx = absDx - innerW

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
        const edgeX = halfW - absDx
        if (bendCorners && edgeX < effBezel && edgeY < effBezel) {
          computeCornerGeometry(
            edgeX > 0 ? edgeX : 0,
            edgeY > 0 ? edgeY : 0,
            rad,
            effBezel,
          )
          const m = sampleRefractionLut(normLut, tmpCornerGeom[2] * invBezel) * localScale
          const amp = clampAmp(m * 127)
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
          const m = sampleRefractionLut(normLut, distIn * invBezel) * localScale
          const amp = clampAmp(m * 127)
          scanlines[offset++] = clampChannel(Math.round(128 - gx * amp))
          scanlines[offset++] = clampChannel(Math.round(128 - gy * amp))
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        }
      }
    }
  }
}

function rasterizeDualShapeScanlines(
  scanlines: Uint8Array,
  pngW: number,
  pngH: number,
  originX: number,
  originY: number,
  stepX: number,
  stepY: number,
  shapeA: GlassPrimitive,
  shapeB: GlassPrimitive,
  blendK: number,
  safeBezel: number,
  lut: RefractionProfileLut,
): void {
  const pCx = shapeA.center.x
  const pCy = shapeA.center.y
  const pHalfW = Math.max(0.001, shapeA.size.width * 0.5)
  const pHalfH = Math.max(0.001, shapeA.size.height * 0.5)
  const pRad = Math.max(0, Math.min(shapeA.radius, pHalfW, pHalfH))
  const pInnerW = pHalfW - pRad
  const pInnerH = pHalfH - pRad
  const pBezel = Math.max(1e-3, Math.min(safeBezel, pHalfW, pHalfH))
  const pInvBezel = 1 / pBezel
  const pBendCorners = pRad > 0 && pRad < pBezel

  const dCx = shapeB.center.x
  const dCy = shapeB.center.y
  const dHalfW = Math.max(0.001, shapeB.size.width * 0.5)
  const dHalfH = Math.max(0.001, shapeB.size.height * 0.5)
  const dRad = Math.max(0, Math.min(shapeB.radius, dHalfW, dHalfH))
  const dInnerW = dHalfW - dRad
  const dInnerH = dHalfH - dRad
  const dBezel = Math.max(1e-3, Math.min(safeBezel, dHalfW, dHalfH))
  const dInvBezel = 1 / dBezel
  const dBendCorners = dRad > 0 && dRad < dBezel

  const maxBezel = pBezel > dBezel ? pBezel : dBezel
  const smoothUnion = blendK > 0.001
  const inv2K = smoothUnion ? 0.5 / blendK : 0
  const interiorGate = -Math.max(maxBezel, 0.5)
  const normLut = lut.normalizedDisplacement
  const hasDisplacement = lut.maxDisplacementRatio > 1e-6
  const invSafeBezel = 1 / safeBezel

  let offset = 0
  for (let py = 0; py < pngH; py++) {
    scanlines[offset++] = 0
    const wy = originY + py * stepY
    const pDy = wy - pCy
    const pAbsDy = pDy < 0 ? -pDy : pDy
    const pSy = pDy >= 0 ? 1 : -1
    const pQy = pAbsDy - pInnerH
    const pQyPos = pQy > 0
    const pEdgeY = pHalfH - pAbsDy

    const dDy = wy - dCy
    const dAbsDy = dDy < 0 ? -dDy : dDy
    const dSy = dDy >= 0 ? 1 : -1
    const dQy = dAbsDy - dInnerH
    const dQyPos = dQy > 0
    const dEdgeY = dHalfH - dAbsDy

    for (let px = 0; px < pngW; px++) {
      const wx = originX + px * stepX
      const pDx = wx - pCx
      const pAbsDx = pDx < 0 ? -pDx : pDx
      const pSx = pDx >= 0 ? 1 : -1
      const pQx = pAbsDx - pInnerW

      let sdA: number
      let gAx: number
      let gAy: number
      if (pQx > 0 && pQyPos) {
        const outLen = Math.hypot(pQx, pQy)
        sdA = outLen - pRad
        if (outLen > 1e-6) {
          const invLen = 1 / outLen
          gAx = pSx * pQx * invLen
          gAy = pSy * pQy * invLen
        } else {
          gAx = pSx * SQRT1_2
          gAy = pSy * SQRT1_2
        }
      } else if (pQx > pQy) {
        sdA = pQx - pRad
        gAx = pSx
        gAy = 0
      } else {
        sdA = pQy - pRad
        gAx = 0
        gAy = pSy
      }

      const dDx = wx - dCx
      const dAbsDx = dDx < 0 ? -dDx : dDx
      const dSx = dDx >= 0 ? 1 : -1
      const dQx = dAbsDx - dInnerW

      let sdB: number
      let gBx: number
      let gBy: number
      if (dQx > 0 && dQyPos) {
        const outLen = Math.hypot(dQx, dQy)
        sdB = outLen - dRad
        if (outLen > 1e-6) {
          const invLen = 1 / outLen
          gBx = dSx * dQx * invLen
          gBy = dSy * dQy * invLen
        } else {
          gBx = dSx * SQRT1_2
          gBy = dSy * SQRT1_2
        }
      } else if (dQx > dQy) {
        sdB = dQx - dRad
        gBx = dSx
        gBy = 0
      } else {
        sdB = dQy - dRad
        gBx = 0
        gBy = dSy
      }

      let sd: number
      let gx: number
      let gy: number
      let blended = false
      let winIsA = true
      let blendH = 1

      if (smoothUnion) {
        const h = clamp01(0.5 + (sdB - sdA) * inv2K)
        if (h > 0 && h < 1) {
          blended = true
          blendH = h
          sd = sdB + (sdA - sdB) * h - blendK * h * (1 - h)

          let mixAx = gAx
          let mixAy = gAy
          if (pBendCorners && sdA < 0 && -sdA < pBezel) {
            const pEdgeX = pHalfW - pAbsDx
            if (pEdgeX < pBezel && pEdgeY < pBezel) {
              computeCornerBendOutwardDir(pEdgeX, pEdgeY, pRad, pBezel, pSx, pSy)
              mixAx = tmpCornerDir[0]
              mixAy = tmpCornerDir[1]
            }
          }

          let mixBx = gBx
          let mixBy = gBy
          if (dBendCorners && sdB < 0 && -sdB < dBezel) {
            const dEdgeX = dHalfW - dAbsDx
            if (dEdgeX < dBezel && dEdgeY < dBezel) {
              computeCornerBendOutwardDir(dEdgeX, dEdgeY, dRad, dBezel, dSx, dSy)
              mixBx = tmpCornerDir[0]
              mixBy = tmpCornerDir[1]
            }
          }

          gx = mixBx + (mixAx - mixBx) * h
          gy = mixBy + (mixAy - mixBy) * h
        } else if (h >= 1) {
          sd = sdA
          gx = gAx
          gy = gAy
          winIsA = true
        } else {
          sd = sdB
          gx = gBx
          gy = gBy
          winIsA = false
        }
      } else if (sdA <= sdB) {
        sd = sdA
        gx = gAx
        gy = gAy
        winIsA = true
      } else {
        sd = sdB
        gx = gBx
        gy = gBy
        winIsA = false
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
        if (!blended) {
          const winBezel = winIsA ? pBezel : dBezel
          const winInvBezel = winIsA ? pInvBezel : dInvBezel
          const winScale = winBezel * invSafeBezel
          const winRad = winIsA ? pRad : dRad
          const winEdgeX = winIsA ? pHalfW - pAbsDx : dHalfW - dAbsDx
          const winEdgeY = winIsA ? pEdgeY : dEdgeY
          const winSx = winIsA ? pSx : dSx
          const winSy = winIsA ? pSy : dSy
          if (winRad > 0 && winRad < winBezel && winEdgeX < winBezel && winEdgeY < winBezel) {
            computeCornerGeometry(
              winEdgeX > 0 ? winEdgeX : 0,
              winEdgeY > 0 ? winEdgeY : 0,
              winRad,
              winBezel,
            )
            const m = sampleRefractionLut(normLut, tmpCornerGeom[2] * winInvBezel) * winScale
            const amp = clampAmp(m * 127)
            scanlines[offset++] = clampChannel(Math.round(128 - winSx * tmpCornerGeom[0] * amp))
            scanlines[offset++] = clampChannel(Math.round(128 - winSy * tmpCornerGeom[1] * amp))
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          } else if (distIn >= winBezel) {
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          } else {
            const m = sampleRefractionLut(normLut, distIn * winInvBezel) * winScale
            const amp = clampAmp(m * 127)
            scanlines[offset++] = clampChannel(Math.round(128 - gx * amp))
            scanlines[offset++] = clampChannel(Math.round(128 - gy * amp))
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          }
        } else {
          const blendBezel = dBezel + (pBezel - dBezel) * blendH
          if (distIn >= blendBezel) {
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          } else {
            const gLen = Math.hypot(gx, gy)
            const denom = gLen > NORMAL_FLOOR ? gLen : NORMAL_FLOOR
            const invG = -1 / denom
            const nx = gx * invG
            const ny = gy * invG
            const blendScale = blendBezel * invSafeBezel
            const m = sampleRefractionLut(normLut, distIn / blendBezel) * blendScale
            const amp = clampAmp(m * 127)
            scanlines[offset++] = clampChannel(Math.round(128 + nx * amp))
            scanlines[offset++] = clampChannel(Math.round(128 + ny * amp))
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          }
        }
      }
    }
  }
}

function rasterizeMultiShapeScanlines(
  scanlines: Uint8Array,
  pngW: number,
  pngH: number,
  originX: number,
  originY: number,
  stepX: number,
  stepY: number,
  primitives: readonly GlassPrimitive[],
  activeCount: number,
  blendK: number,
  safeBezel: number,
  lut: RefractionProfileLut,
): void {
  ensureSoaCapacity(activeCount)

  let maxBezel = 1e-3
  for (let i = 0; i < activeCount; i++) {
    const p = primitives[activeIndicesBuf[i]]
    const cx = p.center.x
    const cy = p.center.y
    const halfW = Math.max(0.001, p.size.width * 0.5)
    const halfH = Math.max(0.001, p.size.height * 0.5)
    const rad = Math.max(0, Math.min(p.radius, halfW, halfH))
    const localBezel = Math.max(1e-3, Math.min(safeBezel, halfW, halfH))
    soaCx[i] = cx
    soaCy[i] = cy
    soaHalfW[i] = halfW
    soaHalfH[i] = halfH
    soaRad[i] = rad
    soaInnerW[i] = halfW - rad
    soaInnerH[i] = halfH - rad
    soaBezel[i] = localBezel
    soaInvBezel[i] = 1 / localBezel
    soaMinX[i] = cx - halfW
    soaMaxX[i] = cx + halfW
    soaMinY[i] = cy - halfH
    soaMaxY[i] = cy + halfH
    if (localBezel > maxBezel) maxBezel = localBezel
  }

  const smoothUnion = blendK > 0.001
  const effectiveBlendK = smoothUnion ? blendK : 0
  const inv2K = smoothUnion ? 0.5 / blendK : 0
  const interiorGate = -Math.max(maxBezel, 0.5)
  const outerThreshold = 0.5 + effectiveBlendK
  const outerThresholdSq = outerThreshold * outerThreshold
  const normLut = lut.normalizedDisplacement
  const hasDisplacement = lut.maxDisplacementRatio > 1e-6
  const invSafeBezel = 1 / safeBezel

  let offset = 0
  for (let py = 0; py < pngH; py++) {
    scanlines[offset++] = 0
    const wy = originY + py * stepY

    // Precompute per-primitive vertical lower bounds and horizontal reach for this row to skip empty rows/columns.
    let rowActive = false
    let rowXMin = Infinity
    let rowXMax = -Infinity
    for (let i = 0; i < activeCount; i++) {
      const dy = wy - soaCy[i]
      const absDy = dy < 0 ? -dy : dy
      rowAbsDy[i] = absDy
      rowSy[i] = dy >= 0 ? 1 : -1
      rowQy[i] = absDy - soaInnerH[i]
      const dySigned = absDy - soaHalfH[i]
      rowDySigned[i] = dySigned
      const dyGap = dySigned > 0 ? dySigned : 0
      if (dyGap < outerThreshold) {
        rowActive = true
        const reachX = Math.sqrt(Math.max(0, outerThresholdSq - dyGap * dyGap))
        const x0 = soaMinX[i] - reachX
        const x1 = soaMaxX[i] + reachX
        if (x0 < rowXMin) rowXMin = x0
        if (x1 > rowXMax) rowXMax = x1
      }
    }

    if (!rowActive) {
      for (let px = 0; px < pngW; px++) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 0
      }
      continue
    }

    for (let px = 0; px < pngW; px++) {
      const wx = originX + px * stepX
      if (wx < rowXMin || wx > rowXMax) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 0
        continue
      }

      // Initialize accumulator with primitive 0.
      const dx0 = wx - soaCx[0]
      const absDx0 = dx0 < 0 ? -dx0 : dx0
      const sx0 = dx0 >= 0 ? 1 : -1
      const qx0 = absDx0 - soaInnerW[0]
      const qy0 = rowQy[0]
      const sy0 = rowSy[0]
      const rad0 = soaRad[0]

      let accDist: number
      let accGx: number
      let accGy: number
      if (qx0 > 0 && qy0 > 0) {
        const outLen = Math.hypot(qx0, qy0)
        accDist = outLen - rad0
        if (outLen > 1e-6) {
          const invLen = 1 / outLen
          accGx = sx0 * qx0 * invLen
          accGy = sy0 * qy0 * invLen
        } else {
          accGx = sx0 * SQRT1_2
          accGy = sy0 * SQRT1_2
        }
      } else if (qx0 > qy0) {
        accDist = qx0 - rad0
        accGx = sx0
        accGy = 0
      } else {
        accDist = qy0 - rad0
        accGx = 0
        accGy = sy0
      }

      let blended = false
      let winIdx = 0
      let winAbsDx = absDx0
      let winSx = sx0
      let accBezel = soaBezel[0]

      // Fold remaining primitives in order after signed AABB lower-bound pruning.
      for (let i = 1; i < activeCount; i++) {
        const dx = wx - soaCx[i]
        const absDx = dx < 0 ? -dx : dx
        const dxSigned = absDx - soaHalfW[i]
        const dySigned = rowDySigned[i]
        let lb: number
        if (dxSigned > 0 || dySigned > 0) {
          lb =
            dxSigned > 0
              ? dySigned > 0
                ? Math.hypot(dxSigned, dySigned)
                : dxSigned
              : dySigned
        } else {
          lb = dxSigned > dySigned ? dxSigned : dySigned
        }
        if (smoothUnion ? lb >= accDist + blendK : lb >= accDist) {
          continue
        }

        const sx = dx >= 0 ? 1 : -1
        const qx = absDx - soaInnerW[i]
        const qy = rowQy[i]
        const sy = rowSy[i]
        const rad = soaRad[i]

        let sdB: number
        let gBx: number
        let gBy: number
        if (qx > 0 && qy > 0) {
          const outLen = Math.hypot(qx, qy)
          sdB = outLen - rad
          if (outLen > 1e-6) {
            const invLen = 1 / outLen
            gBx = sx * qx * invLen
            gBy = sy * qy * invLen
          } else {
            gBx = sx * SQRT1_2
            gBy = sy * SQRT1_2
          }
        } else if (qx > qy) {
          sdB = qx - rad
          gBx = sx
          gBy = 0
        } else {
          sdB = qy - rad
          gBx = 0
          gBy = sy
        }

        if (smoothUnion) {
          const h = clamp01(0.5 + (sdB - accDist) * inv2K)
          if (h > 0 && h < 1) {
            // Apply cornerBend to the previously dominant single primitive when entering a blend zone.
            if (!blended) {
              const wBezel = soaBezel[winIdx]
              const wRad = soaRad[winIdx]
              if (wRad > 0 && wRad < wBezel && accDist < 0 && -accDist < wBezel) {
                const wEdgeX = soaHalfW[winIdx] - winAbsDx
                const wEdgeY = soaHalfH[winIdx] - rowAbsDy[winIdx]
                if (wEdgeX < wBezel && wEdgeY < wBezel) {
                  computeCornerBendOutwardDir(
                    wEdgeX,
                    wEdgeY,
                    wRad,
                    wBezel,
                    winSx,
                    rowSy[winIdx],
                  )
                  accGx = tmpCornerDir[0]
                  accGy = tmpCornerDir[1]
                }
              }
              blended = true
            }

            const bBezel = soaBezel[i]
            if (rad > 0 && rad < bBezel && sdB < 0 && -sdB < bBezel) {
              const bEdgeX = soaHalfW[i] - absDx
              const bEdgeY = soaHalfH[i] - rowAbsDy[i]
              if (bEdgeX < bBezel && bEdgeY < bBezel) {
                computeCornerBendOutwardDir(bEdgeX, bEdgeY, rad, bBezel, sx, sy)
                gBx = tmpCornerDir[0]
                gBy = tmpCornerDir[1]
              }
            }

            accDist = sdB + (accDist - sdB) * h - blendK * h * (1 - h)
            accBezel = bBezel + (accBezel - bBezel) * h
            // Preserve unnormalized gradient length so opposing saddle normals soften smoothly via NORMAL_FLOOR.
            accGx = gBx + (accGx - gBx) * h
            accGy = gBy + (accGy - gBy) * h
          } else if (h <= 0) {
            accDist = sdB
            accGx = gBx
            accGy = gBy
            accBezel = soaBezel[i]
            winIdx = i
            winAbsDx = absDx
            winSx = sx
            blended = false
          }
        } else if (sdB < accDist) {
          accDist = sdB
          accGx = gBx
          accGy = gBy
          accBezel = soaBezel[i]
          winIdx = i
          winAbsDx = absDx
          winSx = sx
        }
      }

      if (accDist >= 0.5) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 0
      } else if (accDist <= interiorGate) {
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 128
        scanlines[offset++] = 255
      } else {
        const distIn = accDist < 0 ? -accDist : 0
        const alpha = accDist <= -0.5 ? 255 : Math.round((0.5 - accDist) * 255)
        if (!hasDisplacement) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
          continue
        }
        if (!blended) {
          const winBezel = soaBezel[winIdx]
          const winScale = winBezel * invSafeBezel
          const winRad = soaRad[winIdx]
          const winEdgeX = soaHalfW[winIdx] - winAbsDx
          const winEdgeY = soaHalfH[winIdx] - rowAbsDy[winIdx]
          if (winRad > 0 && winRad < winBezel && winEdgeX < winBezel && winEdgeY < winBezel) {
            computeCornerGeometry(
              winEdgeX > 0 ? winEdgeX : 0,
              winEdgeY > 0 ? winEdgeY : 0,
              winRad,
              winBezel,
            )
            const m = sampleRefractionLut(normLut, tmpCornerGeom[2] * soaInvBezel[winIdx]) * winScale
            const amp = clampAmp(m * 127)
            scanlines[offset++] = clampChannel(Math.round(128 - winSx * tmpCornerGeom[0] * amp))
            scanlines[offset++] = clampChannel(Math.round(128 - rowSy[winIdx] * tmpCornerGeom[1] * amp))
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          } else if (distIn >= winBezel) {
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          } else {
            const m = sampleRefractionLut(normLut, distIn * soaInvBezel[winIdx]) * winScale
            const amp = clampAmp(m * 127)
            scanlines[offset++] = clampChannel(Math.round(128 - accGx * amp))
            scanlines[offset++] = clampChannel(Math.round(128 - accGy * amp))
            scanlines[offset++] = 128
            scanlines[offset++] = alpha
          }
        } else if (distIn >= accBezel) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else {
          const gLen = Math.hypot(accGx, accGy)
          const denom = gLen > NORMAL_FLOOR ? gLen : NORMAL_FLOOR
          const invG = -1 / denom
          const nx = accGx * invG
          const ny = accGy * invG
          const blendScale = accBezel * invSafeBezel
          const m = sampleRefractionLut(normLut, distIn / accBezel) * blendScale
          const amp = clampAmp(m * 127)
          scanlines[offset++] = clampChannel(Math.round(128 + nx * amp))
          scanlines[offset++] = clampChannel(Math.round(128 + ny * amp))
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        }
      }
    }
  }
}

/** Creates a Stored-PNG displacement map builder with quantized caching; reuse the instance across frames. */
export function createRefractMapBuilder(): RefractMapBuilder {
  let prevKey = ''
  let prevDataUrl = ''
  let prevWidth = 0
  let prevHeight = 0
  let prevMaxDisplacementPx = 0

  return {
    build(params: RefractMapParams): RefractMapResult {
      const safeBezel = Math.max(1, params.bezel)
      const safeIor =
        params.ior !== undefined && Number.isFinite(params.ior)
          ? Math.max(1, params.ior)
          : DEFAULT_REFRACTION_IOR
      const safeRatio =
        params.thicknessRatio !== undefined && Number.isFinite(params.thicknessRatio)
          ? Math.max(0, params.thicknessRatio)
          : DEFAULT_THICKNESS_RATIO
      const safeCaustics = Boolean(params.caustics)
      const profileSpec = params.profile ?? 'squircle'
      const profileKey = getRefractionProfileKey(profileSpec)

      const mapScale = params.mapScale && params.mapScale > 0 ? params.mapScale : DEFAULT_MAP_SCALE
      const cssW = Math.max(1, Math.round(params.bounds.width))
      const cssH = Math.max(1, Math.round(params.bounds.height))
      const pngW = Math.max(1, Math.round(cssW * mapScale))
      const pngH = Math.max(1, Math.round(cssH * mapScale))

      const { primitives, blendK } = params.field
      const activeCount = collectActivePrimitiveIndices(primitives)

      const key = buildQuantizedKey(
        cssW,
        cssH,
        pngW,
        pngH,
        params.bounds,
        primitives,
        activeCount,
        blendK,
        safeBezel,
        profileKey,
        safeIor,
        safeRatio,
        safeCaustics,
      )

      if (key === prevKey && prevDataUrl) {
        return {
          dataUrl: prevDataUrl,
          width: prevWidth,
          height: prevHeight,
          changed: false,
          maxDisplacementPx: prevMaxDisplacementPx,
        }
      }

      const lut = resolveRefractionProfileLut({
        profile: profileSpec,
        ior: safeIor,
        thicknessRatio: safeRatio,
        caustics: safeCaustics,
      })
      const maxDisplacementPx = safeBezel * lut.maxDisplacementRatio

      const rowBytes = 1 + pngW * 4
      const scanlines = ensureScanlineCapacity(pngH * rowBytes)
      const stepX = cssW / pngW
      const stepY = cssH / pngH
      const originX = params.bounds.x + 0.5 * stepX
      const originY = params.bounds.y + 0.5 * stepY

      if (activeCount === 0) {
        rasterizeEmptyScanlines(scanlines, pngW, pngH)
      } else if (activeCount === 1) {
        rasterizeSingleRectScanlines(
          scanlines,
          pngW,
          pngH,
          originX,
          originY,
          stepX,
          stepY,
          primitives[activeIndicesBuf[0]],
          safeBezel,
          lut,
        )
      } else if (activeCount === 2) {
        rasterizeDualShapeScanlines(
          scanlines,
          pngW,
          pngH,
          originX,
          originY,
          stepX,
          stepY,
          primitives[activeIndicesBuf[0]],
          primitives[activeIndicesBuf[1]],
          blendK,
          safeBezel,
          lut,
        )
      } else {
        rasterizeMultiShapeScanlines(
          scanlines,
          pngW,
          pngH,
          originX,
          originY,
          stepX,
          stepY,
          primitives,
          activeCount,
          blendK,
          safeBezel,
          lut,
        )
      }

      const dataUrl = encodeStoredRgbaPngDataUrl(scanlines, pngW, pngH)
      prevKey = key
      prevDataUrl = dataUrl
      prevWidth = cssW
      prevHeight = cssH
      prevMaxDisplacementPx = maxDisplacementPx

      return {
        dataUrl,
        width: cssW,
        height: cssH,
        changed: true,
        maxDisplacementPx,
      }
    },

    reset(): void {
      prevKey = ''
      prevDataUrl = ''
      prevWidth = 0
      prevHeight = 0
      prevMaxDisplacementPx = 0
    },
  }
}

/** Stateless one-shot build; prefer `createRefractMapBuilder()` for multi-frame reuse. */
export function buildRefractMapDataUrl(params: RefractMapParams): string {
  return createRefractMapBuilder().build(params).dataUrl
}
