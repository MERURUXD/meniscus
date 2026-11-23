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

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_IEND = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const MAX_DEFLATE_BLOCK = 65535
const DEFAULT_MAP_SCALE = 0.5
const DEFAULT_FALLOFF = 2.6
const MIN_PRIMITIVE_SIZE = 0.01
const SQRT1_2 = Math.SQRT1_2

type Uint8ArrayWithToBase64 = Uint8Array & { toBase64?: () => string }

export interface RefractMapParams {
  bounds: Rect
  field: GlassFieldState
  bezel: number
  falloff?: number
  mapScale?: number
}

export interface RefractMapResult {
  dataUrl: string
  width: number
  height: number
  changed: boolean
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
let soaMinX = new Float64Array(0)
let soaMaxX = new Float64Array(0)
let soaMinY = new Float64Array(0)
let soaMaxY = new Float64Array(0)
let rowDySigned = new Float64Array(0)
let rowQy = new Float64Array(0)
let rowSy = new Float64Array(0)

// Reusable index buffer for active primitives per build, avoiding per-frame array allocations.
let activeIndicesBuf = new Int32Array(0)

function ensureScanlineCapacity(needed: number): Uint8Array {
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
  soaMinX = new Float64Array(nextCap)
  soaMaxX = new Float64Array(nextCap)
  soaMinY = new Float64Array(nextCap)
  soaMaxY = new Float64Array(nextCap)
  rowDySigned = new Float64Array(nextCap)
  rowQy = new Float64Array(nextCap)
  rowSy = new Float64Array(nextCap)
}

function encodeStoredRgbaPngDataUrl(
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

function quant4(v: number): number {
  return Math.round(v * 4)
}

function quant100(v: number): number {
  return Math.round(v * 100)
}

function cornerBend(
  x: number,
  y: number,
  radius: number,
  bezel: number,
  falloff: number,
): [number, number] {
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
  const weight = Math.pow(Math.max(0, 1 - lo / bezel), falloff)
  if (normal <= 1e-6) return x < y ? [weight, 0] : [0, weight]
  return [(nx / normal) * weight, (ny / normal) * weight]
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
  falloff: number,
): string {
  const base =
    `${cssW}:${cssH}:${pngW}:${pngH}:${quant4(bounds.x)}:${quant4(bounds.y)}:` +
    `${quant4(bezel)}:${quant100(falloff)}:${quant4(blendK)}`
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
  safeFalloff: number,
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
        const edgeX = halfW - absDx
        if (bendCorners && edgeX < effBezel && edgeY < effBezel) {
          const [ox, oy] = cornerBend(
            edgeX > 0 ? edgeX : 0,
            edgeY > 0 ? edgeY : 0,
            rad,
            effBezel,
            safeFalloff,
          )
          scanlines[offset++] = Math.round(128 - sx * ox * 127)
          scanlines[offset++] = Math.round(128 - sy * oy * 127)
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else if (distIn >= effBezel) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else {
          const m = Math.pow(Math.max(0, 1 - distIn * invBezel), safeFalloff)
          const amp = m * 127
          scanlines[offset++] = Math.round(128 - gx * amp)
          scanlines[offset++] = Math.round(128 - gy * amp)
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
  safeFalloff: number,
): void {
  const pCx = shapeA.center.x
  const pCy = shapeA.center.y
  const pHalfW = Math.max(0.001, shapeA.size.width * 0.5)
  const pHalfH = Math.max(0.001, shapeA.size.height * 0.5)
  const pRad = Math.max(0, Math.min(shapeA.radius, pHalfW, pHalfH))
  const pInnerW = pHalfW - pRad
  const pInnerH = pHalfH - pRad

  const dCx = shapeB.center.x
  const dCy = shapeB.center.y
  const dHalfW = Math.max(0.001, shapeB.size.width * 0.5)
  const dHalfH = Math.max(0.001, shapeB.size.height * 0.5)
  const dRad = Math.max(0, Math.min(shapeB.radius, dHalfW, dHalfH))
  const dInnerW = dHalfW - dRad
  const dInnerH = dHalfH - dRad
  const effBezel = Math.max(1e-3, Math.min(safeBezel, Math.max(pHalfW, dHalfW), Math.max(pHalfH, dHalfH)))

  const smoothUnion = blendK > 0.001
  const inv2K = smoothUnion ? 0.5 / blendK : 0
  const invBezel = 1 / effBezel
  const interiorGate = -Math.max(effBezel, 0.5)

  let offset = 0
  for (let py = 0; py < pngH; py++) {
    scanlines[offset++] = 0
    const wy = originY + py * stepY
    const pDy = wy - pCy
    const pSy = pDy >= 0 ? 1 : -1
    const pQy = (pDy < 0 ? -pDy : pDy) - pInnerH
    const pQyPos = pQy > 0

    const dDy = wy - dCy
    const dSy = dDy >= 0 ? 1 : -1
    const dQy = (dDy < 0 ? -dDy : dDy) - dInnerH
    const dQyPos = dQy > 0

    for (let px = 0; px < pngW; px++) {
      const wx = originX + px * stepX
      const pDx = wx - pCx
      const pSx = pDx >= 0 ? 1 : -1
      const pQx = (pDx < 0 ? -pDx : pDx) - pInnerW

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
      const dSx = dDx >= 0 ? 1 : -1
      const dQx = (dDx < 0 ? -dDx : dDx) - dInnerW

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
      if (smoothUnion) {
        const h = clamp01(0.5 + (sdB - sdA) * inv2K)
        sd = sdB + (sdA - sdB) * h - blendK * h * (1 - h)
        gx = gBx + (gAx - gBx) * h
        gy = gBy + (gAy - gBy) * h
      } else if (sdA <= sdB) {
        sd = sdA
        gx = gAx
        gy = gAy
      } else {
        sd = sdB
        gx = gBx
        gy = gBy
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
        if (distIn >= effBezel) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else {
          const gLen = Math.hypot(gx, gy)
          let nx = 0
          let ny = 0
          if (gLen > 1e-6) {
            const invG = -1 / gLen
            nx = gx * invG
            ny = gy * invG
          }
          const m = Math.pow(Math.max(0, 1 - distIn * invBezel), safeFalloff)
          const amp = m * 127
          scanlines[offset++] = Math.round(128 + nx * amp)
          scanlines[offset++] = Math.round(128 + ny * amp)
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
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
  safeFalloff: number,
): void {
  ensureSoaCapacity(activeCount)

  let maxHalfW = 0.001
  let maxHalfH = 0.001
  for (let i = 0; i < activeCount; i++) {
    const p = primitives[activeIndicesBuf[i]]
    const cx = p.center.x
    const cy = p.center.y
    const halfW = Math.max(0.001, p.size.width * 0.5)
    const halfH = Math.max(0.001, p.size.height * 0.5)
    const rad = Math.max(0, Math.min(p.radius, halfW, halfH))
    soaCx[i] = cx
    soaCy[i] = cy
    soaHalfW[i] = halfW
    soaHalfH[i] = halfH
    soaRad[i] = rad
    soaInnerW[i] = halfW - rad
    soaInnerH[i] = halfH - rad
    soaMinX[i] = cx - halfW
    soaMaxX[i] = cx + halfW
    soaMinY[i] = cy - halfH
    soaMaxY[i] = cy + halfH
    if (halfW > maxHalfW) maxHalfW = halfW
    if (halfH > maxHalfH) maxHalfH = halfH
  }

  const effBezel = Math.max(1e-3, Math.min(safeBezel, maxHalfW, maxHalfH))
  const smoothUnion = blendK > 0.001
  const effectiveBlendK = smoothUnion ? blendK : 0
  const inv2K = smoothUnion ? 0.5 / blendK : 0
  const invBezel = 1 / effBezel
  const interiorGate = -Math.max(effBezel, 0.5)
  const outerThreshold = 0.5 + effectiveBlendK
  const outerThresholdSq = outerThreshold * outerThreshold

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
      const sx0 = dx0 >= 0 ? 1 : -1
      const qx0 = (dx0 < 0 ? -dx0 : dx0) - soaInnerW[0]
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
          accDist = sdB + (accDist - sdB) * h - blendK * h * (1 - h)
          const mx = gBx + (accGx - gBx) * h
          const my = gBy + (accGy - gBy) * h
          const mLen = Math.hypot(mx, my)
          if (mLen > 1e-6) {
            const invM = 1 / mLen
            accGx = mx * invM
            accGy = my * invM
          } else {
            accGx = 0
            accGy = 0
          }
        } else if (sdB < accDist) {
          accDist = sdB
          accGx = gBx
          accGy = gBy
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
        if (distIn >= effBezel) {
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = 128
          scanlines[offset++] = alpha
        } else {
          const gLen = Math.hypot(accGx, accGy)
          let nx = 0
          let ny = 0
          if (gLen > 1e-6) {
            const invG = -1 / gLen
            nx = accGx * invG
            ny = accGy * invG
          }
          const m = Math.pow(Math.max(0, 1 - distIn * invBezel), safeFalloff)
          const amp = m * 127
          scanlines[offset++] = Math.round(128 + nx * amp)
          scanlines[offset++] = Math.round(128 + ny * amp)
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

  return {
    build(params: RefractMapParams): RefractMapResult {
      const safeBezel = Math.max(1, params.bezel)
      const safeFalloff =
        params.falloff !== undefined && Number.isFinite(params.falloff) && params.falloff >= 0
          ? params.falloff
          : DEFAULT_FALLOFF
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
        safeFalloff,
      )

      if (key === prevKey && prevDataUrl) {
        return {
          dataUrl: prevDataUrl,
          width: prevWidth,
          height: prevHeight,
          changed: false,
        }
      }

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
          safeFalloff,
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
          safeFalloff,
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
          safeFalloff,
        )
      }

      const dataUrl = encodeStoredRgbaPngDataUrl(scanlines, pngW, pngH)
      prevKey = key
      prevDataUrl = dataUrl
      prevWidth = cssW
      prevHeight = cssH

      return {
        dataUrl,
        width: cssW,
        height: cssH,
        changed: true,
      }
    },

    reset(): void {
      prevKey = ''
      prevDataUrl = ''
      prevWidth = 0
      prevHeight = 0
    },
  }
}

/** Stateless one-shot build; prefer `createRefractMapBuilder()` for multi-frame reuse. */
export function buildRefractMapDataUrl(params: RefractMapParams): string {
  return createRefractMapBuilder().build(params).dataUrl
}
