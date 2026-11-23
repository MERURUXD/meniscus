/**
 * Generic N-primitive rounded-box smooth-union (smin) signed distance field kernel.
 * Provides zero-allocation scalar hot paths, SoA preallocated buffers, lossless AABB
 * lower-bound pruning, and pair merge detection without host-specific semantics.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type {
  GlassFieldState,
  GlassPrimitive,
  Point,
  Rect,
  SdfSample,
  SminSample,
} from './contracts.ts'

/** Minimum active primitive dimension threshold in CSS px. */
const MIN_ACTIVE_SIZE = 0.01

/** Threshold for degenerate normals and division-by-zero guards. */
const EPSILON = 1e-6

/** Default preallocated SoA capacity. */
const DEFAULT_PREPARED_CAPACITY = 16

/**
 * Preallocated Structure-of-Arrays (SoA) glass field for high-frequency per-frame sampling.
 * Stores all numeric fields in compact Float64Arrays to avoid GC pressure at 60/120fps.
 */
export interface PreparedField {
  count: number
  capacity: number
  blendK: number
  cx: Float64Array
  cy: Float64Array
  halfW: Float64Array
  halfH: Float64Array
  radius: Float64Array
  innerW: Float64Array
  innerH: Float64Array
  minX: Float64Array
  maxX: Float64Array
  minY: Float64Array
  maxY: Float64Array
}

/** Merge state between two primitives. */
export interface PairMergeStatus {
  mergeDepth: number
  isMerged: boolean
  rimOpacity: number
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min
  return value < min ? min : value > max ? max : value
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function normalizeOrFallback(vx: number, vy: number, fbX: number, fbY: number): Point {
  const len = Math.hypot(vx, vy)
  if (len <= EPSILON) {
    const fbLen = Math.hypot(fbX, fbY)
    return fbLen > EPSILON ? { x: fbX / fbLen, y: fbY / fbLen } : { x: 0, y: -1 }
  }
  return { x: vx / len, y: vy / len }
}

function isPreparedField(fieldOrPrepared: GlassFieldState | PreparedField): fieldOrPrepared is PreparedField {
  return 'cx' in fieldOrPrepared
}

function isActivePrimitive(shape: GlassPrimitive): boolean {
  return shape.size.width > MIN_ACTIVE_SIZE && shape.size.height > MIN_ACTIVE_SIZE
}

/** Shared scratch buffer for zero-GC evaluation when given a raw GlassFieldState. */
const scratchPreparedField: PreparedField = createPreparedField(DEFAULT_PREPARED_CAPACITY)

/**
 * Creates a preallocated SoA field buffer with the given initial capacity.
 */
export function createPreparedField(capacity = DEFAULT_PREPARED_CAPACITY): PreparedField {
  const cap = Math.max(1, Math.floor(capacity))
  return {
    count: 0,
    capacity: cap,
    blendK: 0,
    cx: new Float64Array(cap),
    cy: new Float64Array(cap),
    halfW: new Float64Array(cap),
    halfH: new Float64Array(cap),
    radius: new Float64Array(cap),
    innerW: new Float64Array(cap),
    innerH: new Float64Array(cap),
    minX: new Float64Array(cap),
    maxX: new Float64Array(cap),
    minY: new Float64Array(cap),
    maxY: new Float64Array(cap),
  }
}

function ensurePreparedCapacity(prepared: PreparedField, needed: number): void {
  if (needed <= prepared.capacity) {
    return
  }
  let nextCap = Math.max(1, prepared.capacity)
  while (nextCap < needed) {
    nextCap *= 2
  }
  prepared.capacity = nextCap
  prepared.cx = new Float64Array(nextCap)
  prepared.cy = new Float64Array(nextCap)
  prepared.halfW = new Float64Array(nextCap)
  prepared.halfH = new Float64Array(nextCap)
  prepared.radius = new Float64Array(nextCap)
  prepared.innerW = new Float64Array(nextCap)
  prepared.innerH = new Float64Array(nextCap)
  prepared.minX = new Float64Array(nextCap)
  prepared.maxX = new Float64Array(nextCap)
  prepared.minY = new Float64Array(nextCap)
  prepared.maxY = new Float64Array(nextCap)
}

/**
 * Packs active primitives from `GlassFieldState` into a SoA `PreparedField`,
 * doubling capacity when needed.
 */
export function prepareField(field: GlassFieldState, out?: PreparedField): PreparedField {
  const target = out ?? createPreparedField(Math.max(DEFAULT_PREPARED_CAPACITY, field.primitives.length))
  const primitives = field.primitives
  const total = primitives.length

  let activeCount = 0
  for (let i = 0; i < total; i++) {
    if (isActivePrimitive(primitives[i]!)) {
      activeCount++
    }
  }

  ensurePreparedCapacity(target, activeCount)

  const cxArr = target.cx
  const cyArr = target.cy
  const halfWArr = target.halfW
  const halfHArr = target.halfH
  const radiusArr = target.radius
  const innerWArr = target.innerW
  const innerHArr = target.innerH
  const minXArr = target.minX
  const maxXArr = target.maxX
  const minYArr = target.minY
  const maxYArr = target.maxY

  let writeIdx = 0
  for (let i = 0; i < total; i++) {
    const p = primitives[i]!
    if (!isActivePrimitive(p)) {
      continue
    }
    const cx = p.center.x
    const cy = p.center.y
    const halfW = p.size.width * 0.5
    const halfH = p.size.height * 0.5
    const r = Math.max(0, Math.min(p.radius, halfW, halfH))

    cxArr[writeIdx] = cx
    cyArr[writeIdx] = cy
    halfWArr[writeIdx] = halfW
    halfHArr[writeIdx] = halfH
    radiusArr[writeIdx] = r
    innerWArr[writeIdx] = halfW - r
    innerHArr[writeIdx] = halfH - r
    minXArr[writeIdx] = cx - halfW
    maxXArr[writeIdx] = cx + halfW
    minYArr[writeIdx] = cy - halfH
    maxYArr[writeIdx] = cy + halfH
    writeIdx++
  }

  target.count = writeIdx
  target.blendK = field.blendK
  return target
}

/**
 * Zero-allocation scalar hot path: signed distance from `(pointX, pointY)`
 * to an axis-aligned rounded rectangle.
 */
export function computeRoundedBoxDistance(
  pointX: number,
  pointY: number,
  shape: GlassPrimitive,
): number {
  const halfW = Math.max(0, shape.size.width * 0.5)
  const halfH = Math.max(0, shape.size.height * 0.5)
  const r = Math.max(0, Math.min(shape.radius, halfW, halfH))
  const qx = Math.abs(pointX - shape.center.x) - halfW + r
  const qy = Math.abs(pointY - shape.center.y) - halfH + r
  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  return Math.hypot(ox, oy) + Math.min(qx > qy ? qx : qy, 0) - r
}

/**
 * Computes the exact signed distance and outward unit normal from `point`
 * to an axis-aligned rounded rectangle.
 */
export function computeRoundedBoxSdf(point: Point, shape: GlassPrimitive): SdfSample {
  const halfW = Math.max(0, shape.size.width * 0.5)
  const halfH = Math.max(0, shape.size.height * 0.5)
  const r = Math.max(0, Math.min(shape.radius, halfW, halfH))

  const dx = point.x - shape.center.x
  const dy = point.y - shape.center.y
  const sx = dx < 0 ? -1 : 1
  const sy = dy < 0 ? -1 : 1

  const qx = Math.abs(dx) - halfW + r
  const qy = Math.abs(dy) - halfH + r

  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  const outsideDist = Math.hypot(ox, oy)
  const insideDist = Math.min(qx > qy ? qx : qy, 0)
  const distance = outsideDist + insideDist - r

  let normal: Point
  if (outsideDist > EPSILON) {
    normal = {
      x: sx * (ox / outsideDist),
      y: sy * (oy / outsideDist),
    }
  } else if (qx > qy) {
    normal = { x: sx, y: 0 }
  } else if (qy > qx) {
    normal = { x: 0, y: sy }
  } else if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) {
    normal = { x: sx * Math.SQRT1_2, y: sy * Math.SQRT1_2 }
  } else {
    normal = { x: 0, y: -1 }
  }

  return { distance, normal }
}

/**
 * Computes the quadratic polynomial smooth-minimum (`smin`) scalar distance.
 */
export function computeSminDistance(distA: number, distB: number, k: number): number {
  if (k <= EPSILON) {
    return distA <= distB ? distA : distB
  }
  const h = clamp(0.5 + (0.5 * (distB - distA)) / k, 0, 1)
  return lerp(distB, distA, h) - k * h * (1 - h)
}

/**
 * Computes the quadratic polynomial `smin` union with smooth normal blending and normalization.
 */
export function computeSmin(
  distA: number,
  distB: number,
  normalA: Point,
  normalB: Point,
  k: number,
): SminSample {
  if (k <= EPSILON) {
    if (distA <= distB) {
      return {
        distance: distA,
        normal: normalizeOrFallback(normalA.x, normalA.y, 0, -1),
        blendH: 1,
      }
    }
    return {
      distance: distB,
      normal: normalizeOrFallback(normalB.x, normalB.y, 0, -1),
      blendH: 0,
    }
  }

  const blendH = clamp(0.5 + (0.5 * (distB - distA)) / k, 0, 1)
  const distance = lerp(distB, distA, blendH) - k * blendH * (1 - blendH)
  const blendedX = lerp(normalB.x, normalA.x, blendH)
  const blendedY = lerp(normalB.y, normalA.y, blendH)
  const fb = blendH >= 0.5 ? normalA : normalB
  const normal = normalizeOrFallback(blendedX, blendedY, fb.x, fb.y)

  return { distance, normal, blendH }
}

/**
 * Computes the combined axis-aligned bounding box of all active primitives
 * (`size.width > 0.01 && size.height > 0.01`), expanded by `padding`.
 * Returns `{ x: 0, y: 0, width: 0, height: 0 }` when no primitive is active.
 */
export function computeFieldBounds(field: GlassFieldState, padding = 0): Rect {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let hasActive = false

  const primitives = field.primitives
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i]!
    if (!isActivePrimitive(p)) {
      continue
    }
    const halfW = p.size.width * 0.5
    const halfH = p.size.height * 0.5
    const pMinX = p.center.x - halfW
    const pMaxX = p.center.x + halfW
    const pMinY = p.center.y - halfH
    const pMaxY = p.center.y + halfH

    if (pMinX < minX) minX = pMinX
    if (pMaxX > maxX) maxX = pMaxX
    if (pMinY < minY) minY = pMinY
    if (pMaxY > maxY) maxY = pMaxY
    hasActive = true
  }

  if (!hasActive) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(0, maxX - minX + padding * 2),
    height: Math.max(0, maxY - minY + padding * 2),
  }
}

/**
 * Detects full absorption of primitive `b` into `a` by probing `b`'s four corners
 * against `a`'s SDF, returning the merge depth and rim opacity weight.
 */
export function computePairMergeStatus(
  a: GlassPrimitive,
  b: GlassPrimitive,
  blendK: number,
  fadeDepth = 8,
): PairMergeStatus {
  if (b.size.width <= 0 || b.size.height <= 0) {
    return {
      mergeDepth: fadeDepth,
      isMerged: true,
      rimOpacity: 1,
    }
  }

  const hw = b.size.width * 0.5
  const hh = b.size.height * 0.5
  const dTL = computeRoundedBoxDistance(b.center.x - hw, b.center.y - hh, a)
  const dTR = computeRoundedBoxDistance(b.center.x + hw, b.center.y - hh, a)
  const dBL = computeRoundedBoxDistance(b.center.x - hw, b.center.y + hh, a)
  const dBR = computeRoundedBoxDistance(b.center.x + hw, b.center.y + hh, a)
  const maxCornerDist = Math.max(dTL, dTR, dBL, dBR)

  const mergeDepth = -maxCornerDist - blendK
  const isMerged = mergeDepth >= 0
  const rimOpacity = isMerged
    ? fadeDepth > 0
      ? clamp(mergeDepth / fadeDepth, 0, 1)
      : 1
    : 0

  return { mergeDepth, isMerged, rimOpacity }
}

/** Evaluates the scalar signed distance to the `i`-th active primitive from SoA fields. */
function evalPreparedPrimitiveDistance(
  pointX: number,
  pointY: number,
  prepared: PreparedField,
  i: number,
): number {
  const qx = Math.abs(pointX - prepared.cx[i]!) - prepared.innerW[i]!
  const qy = Math.abs(pointY - prepared.cy[i]!) - prepared.innerH[i]!
  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  const out = ox > 0 ? (oy > 0 ? Math.hypot(ox, oy) : ox) : oy
  const maxQ = qx > qy ? qx : qy
  return out + (maxQ < 0 ? maxQ : 0) - prepared.radius[i]!
}

/**
 * Exact signed distance lower bound to the `i`-th primitive's AABB.
 * Since a rounded box is a subset of its AABB, `d_i >= lb` holds everywhere.
 */
function evalPreparedAabbLowerBound(
  pointX: number,
  pointY: number,
  prepared: PreparedField,
  i: number,
): number {
  const dx = Math.abs(pointX - prepared.cx[i]!) - prepared.halfW[i]!
  const dy = Math.abs(pointY - prepared.cy[i]!) - prepared.halfH[i]!
  if (dx > 0 || dy > 0) {
    const ox = dx > 0 ? dx : 0
    const oy = dy > 0 ? dy : 0
    return ox > 0 ? (oy > 0 ? Math.hypot(ox, oy) : ox) : oy
  }
  // Inside the AABB, return the signed interior bound max(dx, dy) <= 0 so comparisons against negative (accDist + k) never falsely prune.
  return dx > dy ? dx : dy
}

/**
 * Evaluates the scalar signed distance of an N-primitive glass field at `(pointX, pointY)`
 * on a zero-allocation hot path, using lossless AABB lower-bound pruning for `N >= 3`.
 */
export function evaluateFieldDistance(
  pointX: number,
  pointY: number,
  fieldOrPrepared: GlassFieldState | PreparedField,
  blendK?: number,
): number {
  const prepared = isPreparedField(fieldOrPrepared)
    ? fieldOrPrepared
    : prepareField(fieldOrPrepared, scratchPreparedField)
  const count = prepared.count

  if (count === 0) {
    return Infinity
  }

  if (count === 1) {
    return evalPreparedPrimitiveDistance(pointX, pointY, prepared, 0)
  }

  const k = blendK ?? prepared.blendK

  if (count === 2) {
    const d0 = evalPreparedPrimitiveDistance(pointX, pointY, prepared, 0)
    const d1 = evalPreparedPrimitiveDistance(pointX, pointY, prepared, 1)
    return computeSminDistance(d0, d1, k)
  }

  let accDist = evalPreparedPrimitiveDistance(pointX, pointY, prepared, 0)

  if (k <= EPSILON) {
    for (let i = 1; i < count; i++) {
      const lb = evalPreparedAabbLowerBound(pointX, pointY, prepared, i)
      if (lb >= accDist) {
        continue
      }
      const di = evalPreparedPrimitiveDistance(pointX, pointY, prepared, i)
      if (di < accDist) {
        accDist = di
      }
    }
    return accDist
  }

  const inv2K = 0.5 / k
  for (let i = 1; i < count; i++) {
    const lb = evalPreparedAabbLowerBound(pointX, pointY, prepared, i)
    if (lb >= accDist + k) {
      continue
    }
    const di = evalPreparedPrimitiveDistance(pointX, pointY, prepared, i)
    let h = 0.5 + (di - accDist) * inv2K
    if (h <= 0) {
      accDist = di
    } else if (h < 1) {
      accDist = di + (accDist - di) * h - k * h * (1 - h)
    }
  }

  return accDist
}

/**
 * Evaluates the exact signed distance and outward unit normal of an N-primitive glass field
 * at `point`, using `N=0/1/2` fast paths and lossless AABB lower-bound pruning for `N >= 3`.
 */
export function evaluateFieldSdf(
  point: Point,
  fieldOrPrepared: GlassFieldState | PreparedField,
  blendK?: number,
): SdfSample {
  const prepared = isPreparedField(fieldOrPrepared)
    ? fieldOrPrepared
    : prepareField(fieldOrPrepared, scratchPreparedField)
  const count = prepared.count

  if (count === 0) {
    return { distance: Infinity, normal: { x: 0, y: -1 } }
  }

  const px = point.x
  const py = point.y
  const k = blendK ?? prepared.blendK
  const hardMin = k <= EPSILON
  const inv2K = hardMin ? 0 : 0.5 / k

  let accDist = 0
  let accNx = 0
  let accNy = -1

  for (let i = 0; i < count; i++) {
    if (i > 0 && count >= 3) {
      const lb = evalPreparedAabbLowerBound(px, py, prepared, i)
      if (hardMin ? lb >= accDist : lb >= accDist + k) {
        continue
      }
    }

    const dx = px - prepared.cx[i]!
    const dy = py - prepared.cy[i]!
    const sx = dx < 0 ? -1 : 1
    const sy = dy < 0 ? -1 : 1
    const qx = Math.abs(dx) - prepared.innerW[i]!
    const qy = Math.abs(dy) - prepared.innerH[i]!
    const ox = qx > 0 ? qx : 0
    const oy = qy > 0 ? qy : 0
    const outsideDist = Math.hypot(ox, oy)
    const insideDist = Math.min(qx > qy ? qx : qy, 0)
    const di = outsideDist + insideDist - prepared.radius[i]!

    let nix = 0
    let niy = -1
    if (outsideDist > EPSILON) {
      nix = sx * (ox / outsideDist)
      niy = sy * (oy / outsideDist)
    } else if (qx > qy) {
      nix = sx
      niy = 0
    } else if (qy > qx) {
      nix = 0
      niy = sy
    } else if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) {
      nix = sx * Math.SQRT1_2
      niy = sy * Math.SQRT1_2
    }

    if (i === 0) {
      accDist = di
      accNx = nix
      accNy = niy
      continue
    }

    if (hardMin) {
      if (di < accDist) {
        accDist = di
        accNx = nix
        accNy = niy
      }
      continue
    }

    const h = clamp(0.5 + (di - accDist) * inv2K, 0, 1)
    if (h >= 1) {
      continue
    }
    if (h <= 0) {
      accDist = di
      accNx = nix
      accNy = niy
      continue
    }

    accDist = di + (accDist - di) * h - k * h * (1 - h)
    const bx = nix + (accNx - nix) * h
    const by = niy + (accNy - niy) * h
    const bLen = Math.hypot(bx, by)
    if (bLen > EPSILON) {
      accNx = bx / bLen
      accNy = by / bLen
    } else if (h < 0.5) {
      const fbLen = Math.hypot(nix, niy)
      if (fbLen > EPSILON) {
        accNx = nix / fbLen
        accNy = niy / fbLen
      } else {
        accNx = 0
        accNy = -1
      }
    }
  }

  return {
    distance: accDist,
    normal: { x: accNx, y: accNy },
  }
}
