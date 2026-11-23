/**
 * Generic N-primitive SVG iso-contour extractor.
 * Emits analytic rounded-rectangle paths for single or unblended primitives, and uses
 * adaptive Marching Squares (24..128 grid, 3 bisection refinements, saddle disambiguation,
 * and directed-edge loop chaining) to extract watertight closed paths with multi-island support.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { GlassFieldState, GlassPrimitive, Point } from './contracts.ts'
import { createPreparedField, evaluateFieldDistance, prepareField, type PreparedField } from './sdf.ts'

const MAX_GRID_STEPS = 128
const MIN_GRID_STEPS = 24
const MAX_GRID_NODES = MAX_GRID_STEPS + 1
const MAX_CELLS = MAX_GRID_STEPS * MAX_GRID_STEPS
const MIN_ACTIVE_SIZE = 0.01

// Preallocated module-level buffers to avoid per-frame TypedArray GC during 60/120fps morphing.
const fieldBuf = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const hEdgeX = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const hEdgeY = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const vEdgeX = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const vEdgeY = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)

// Unique directed-edge ID mapping:
// Horizontal edge (ix, iy) -> id = iy * MAX_GRID_NODES + ix
// Vertical edge   (ix, iy) -> id = TOTAL_H + iy * MAX_GRID_NODES + ix
const TOTAL_H = MAX_GRID_NODES * MAX_GRID_NODES
const TOTAL_EDGES = TOTAL_H * 2
const nextEdgeBuf = new Int32Array(TOTAL_EDGES)
const activeEdgeList = new Int32Array(MAX_CELLS * 2)
const visitedBuf = new Uint8Array(TOTAL_EDGES)

// Reusable SoA field buffer, clustering scratch buffers, and string builders.
const sharedPreparedField: PreparedField = createPreparedField(16)
let clusterCapacity = 16
let activeOrigIndicesBuf = new Int32Array(clusterCapacity)
let clusterQueueBuf = new Int32Array(clusterCapacity)
let clusterVisitedBuf = new Int32Array(clusterCapacity)
let clusterMemberMarkBuf = new Int32Array(clusterCapacity)
let clusterPreparedField: PreparedField = createPreparedField(clusterCapacity)
const reusableLoopStrings: string[] = []
const reusableLoopParts: string[] = []

function ensureClusterCapacity(needed: number): void {
  if (needed <= clusterCapacity) {
    return
  }
  let nextCap = clusterCapacity
  while (nextCap < needed) {
    nextCap *= 2
  }
  clusterCapacity = nextCap
  activeOrigIndicesBuf = new Int32Array(nextCap)
  clusterQueueBuf = new Int32Array(nextCap)
  clusterVisitedBuf = new Int32Array(nextCap)
  clusterMemberMarkBuf = new Int32Array(nextCap)
  clusterPreparedField = createPreparedField(nextCap)
}

/**
 * Packs members of the cluster marked with `clusterTag` in ascending original
 * primitive order so non-associative `smin` folding matches `GlassFieldState.primitives`.
 */
function packClusterPreparedField(
  prepared: PreparedField,
  activeCount: number,
  clusterTag: number,
): PreparedField {
  const dst = clusterPreparedField
  let writeIdx = 0
  for (let i = 0; i < activeCount; i++) {
    if (clusterMemberMarkBuf[i]! !== clusterTag) {
      continue
    }
    dst.cx[writeIdx] = prepared.cx[i]!
    dst.cy[writeIdx] = prepared.cy[i]!
    dst.halfW[writeIdx] = prepared.halfW[i]!
    dst.halfH[writeIdx] = prepared.halfH[i]!
    dst.radius[writeIdx] = prepared.radius[i]!
    dst.innerW[writeIdx] = prepared.innerW[i]!
    dst.innerH[writeIdx] = prepared.innerH[i]!
    dst.minX[writeIdx] = prepared.minX[i]!
    dst.maxX[writeIdx] = prepared.maxX[i]!
    dst.minY[writeIdx] = prepared.minY[i]!
    dst.maxY[writeIdx] = prepared.maxY[i]!
    writeIdx++
  }
  dst.count = writeIdx
  dst.blendK = prepared.blendK
  return dst
}

/**
 * Computes the tight upper bound `u_n` on cumulative quadratic `smin` outward dilation
 * (in multiples of `blendK`) for `count` primitives via the recurrence
 * `u_1 = 0`, `u_{n+1} = (1 + u_n)^2 / 4 < 1`.
 */
export function computeMaxSminDilationFactor(count: number): number {
  if (count <= 1) {
    return 0
  }
  let u = 0
  for (let i = 1; i < count; i++) {
    u = ((1 + u) * (1 + u)) * 0.25
  }
  return u
}

const ZERO_POINT: Point = { x: 0, y: 0 }

function fmt(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function isActivePrimitive(shape: GlassPrimitive): boolean {
  return shape.size.width > MIN_ACTIVE_SIZE && shape.size.height > MIN_ACTIVE_SIZE
}

/** Samples the field at a grid node, nudging near-zero values inward so every crossing edge lies strictly within (0, 1). */
function evalContourFieldPoint(x: number, y: number, prepared: PreparedField): number {
  const val = evaluateFieldDistance(x, y, prepared)
  return val > -1e-6 && val < 1e-6 ? -1e-6 : val
}

function addSegment(edgeFrom: number, edgeTo: number, activeCount: number): number {
  nextEdgeBuf[edgeFrom] = edgeTo
  activeEdgeList[activeCount] = edgeFrom
  return activeCount + 1
}

/**
 * Formats a single rounded-rectangle primitive as an analytic SVG path (`M...A...Z`),
 * falling back to sharp corners for degenerate radii or `''` for inactive sizes.
 * Outputs coordinates local to `offset`.
 */
export function formatRoundedRectPath(
  primitive: GlassPrimitive,
  offset: Point = ZERO_POINT,
): string {
  const w = primitive.size.width
  const h = primitive.size.height
  if (w <= MIN_ACTIVE_SIZE || h <= MIN_ACTIVE_SIZE) {
    return ''
  }

  const x0 = fmt(primitive.center.x - w * 0.5 - offset.x)
  const y0 = fmt(primitive.center.y - h * 0.5 - offset.y)
  const x1 = fmt(x0 + w)
  const y1 = fmt(y0 + h)
  const r = fmt(Math.max(0, Math.min(primitive.radius, w * 0.5, h * 0.5)))

  if (r <= MIN_ACTIVE_SIZE) {
    return `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`
  }

  const xl = fmt(x0 + r)
  const xr = fmt(x1 - r)
  const yt = fmt(y0 + r)
  const yb = fmt(y1 - r)

  const parts: string[] = [`M${xl} ${y0}`]
  if (xr > xl) parts.push(`L${xr} ${y0}`)
  parts.push(`A${r} ${r} 0 0 1 ${x1} ${yt}`)
  if (yb > yt) parts.push(`L${x1} ${yb}`)
  parts.push(`A${r} ${r} 0 0 1 ${xr} ${y1}`)
  if (xr > xl) parts.push(`L${xl} ${y1}`)
  parts.push(`A${r} ${r} 0 0 1 ${x0} ${yb}`)
  if (yb > yt) parts.push(`L${x0} ${yt}`)
  parts.push(`A${r} ${r} 0 0 1 ${xl} ${y0}Z`)
  return parts.join('')
}

/**
 * Extracts closed SVG zero-isosurface contour paths for an N-primitive glass field,
 * translated by `-offset` into container-local coordinates.
 * - 0 active primitives: returns `''`.
 * - 1 active primitive: emits an analytic rounded-rectangle path.
 * - `blendK <= 0.001`: concatenates space-separated analytic paths for all active primitives.
 * - `activeCount >= 2 && blendK > 0.001`: extracts smooth merged/split contours via adaptive Marching Squares.
 */
export function extractFieldContourPath(
  field: GlassFieldState,
  offset: Point = ZERO_POINT,
): string {
  const prepared = prepareField(field, sharedPreparedField)
  const activeCount = prepared.count

  if (activeCount === 0) {
    return ''
  }

  if (activeCount === 1) {
    const primitives = field.primitives
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i]!
      if (isActivePrimitive(p)) {
        return formatRoundedRectPath(p, offset)
      }
    }
    return ''
  }

  const blendK = field.blendK
  if (blendK <= 0.001) {
    reusableLoopStrings.length = 0
    const primitives = field.primitives
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i]!
      if (isActivePrimitive(p)) {
        const sub = formatRoundedRectPath(p, offset)
        if (sub) {
          reusableLoopStrings.push(sub)
        }
      }
    }
    const result = reusableLoopStrings.join(' ')
    reusableLoopStrings.length = 0
    return result
  }

  ensureClusterCapacity(activeCount)

  const primitives = field.primitives
  let activeIdx = 0
  for (let i = 0; i < primitives.length; i++) {
    if (isActivePrimitive(primitives[i]!)) {
      activeOrigIndicesBuf[activeIdx++] = i
    }
  }

  for (let i = 0; i < activeCount; i++) {
    clusterVisitedBuf[i] = 0
    clusterMemberMarkBuf[i] = 0
  }

  const minXArr = prepared.minX
  const maxXArr = prepared.maxX
  const minYArr = prepared.minY
  const maxYArr = prepared.maxY
  const maxDilation = computeMaxSminDilationFactor(activeCount)
  const connectThreshold = (1 + 2 * maxDilation) * blendK + 4

  reusableLoopStrings.length = 0
  let clusterTag = 0

  // Partition active primitives into connected clusters using the cumulative smin dilation bound.
  for (let start = 0; start < activeCount; start++) {
    if (clusterVisitedBuf[start]!) {
      continue
    }
    clusterTag++
    clusterVisitedBuf[start] = 1
    clusterMemberMarkBuf[start] = clusterTag
    let head = 0
    let tail = 0
    clusterQueueBuf[tail++] = start

    let cMinX = minXArr[start]!
    let cMaxX = maxXArr[start]!
    let cMinY = minYArr[start]!
    let cMaxY = maxYArr[start]!

    while (head < tail) {
      const u = clusterQueueBuf[head++]!
      const uMinX = minXArr[u]!
      const uMaxX = maxXArr[u]!
      const uMinY = minYArr[u]!
      const uMaxY = maxYArr[u]!

      for (let v = 0; v < activeCount; v++) {
        if (clusterVisitedBuf[v]!) {
          continue
        }
        const vMinX = minXArr[v]!
        const vMaxX = maxXArr[v]!
        const vMinY = minYArr[v]!
        const vMaxY = maxYArr[v]!
        const gx = Math.max(0, uMinX - vMaxX, vMinX - uMaxX)
        const gy = Math.max(0, uMinY - vMaxY, vMinY - uMaxY)
        if (gx <= connectThreshold && gy <= connectThreshold && Math.hypot(gx, gy) <= connectThreshold) {
          clusterVisitedBuf[v] = 1
          clusterMemberMarkBuf[v] = clusterTag
          clusterQueueBuf[tail++] = v
          if (vMinX < cMinX) cMinX = vMinX
          if (vMaxX > cMaxX) cMaxX = vMaxX
          if (vMinY < cMinY) cMinY = vMinY
          if (vMaxY > cMaxY) cMaxY = vMaxY
        }
      }
    }

    if (tail === 1) {
      // Isolated primitive (> connectThreshold from all others) has an exact analytic rounded-rect zero isosurface.
      const origIdx = activeOrigIndicesBuf[start]!
      const sub = formatRoundedRectPath(primitives[origIdx]!, offset)
      if (sub) {
        reusableLoopStrings.push(sub)
      }
    } else {
      // Pack only this cluster's primitives in original order so disconnected islands are neither duplicated nor reordered.
      const clusterPrepared =
        tail === activeCount
          ? prepared
          : packClusterPreparedField(prepared, activeCount, clusterTag)
      appendClusterMarchingSquaresLoops(
        cMinX,
        cMaxX,
        cMinY,
        cMaxY,
        tail,
        blendK,
        clusterPrepared,
        offset,
        reusableLoopStrings,
      )
    }
  }

  const result = reusableLoopStrings.join(' ')
  reusableLoopStrings.length = 0
  reusableLoopParts.length = 0
  return result
}

function appendClusterMarchingSquaresLoops(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  clusterSize: number,
  blendK: number,
  prepared: PreparedField,
  offset: Point,
  outLoops: string[],
): void {
  // Margin compensating for multi-primitive cumulative smin dilation so outer boundary nodes stay strictly positive and form closed loops.
  const msPadding = computeMaxSminDilationFactor(clusterSize) * blendK + 4
  const boundsX = minX - msPadding
  const boundsY = minY - msPadding
  const boundsW = maxX - minX + msPadding * 2
  const boundsH = maxY - minY + msPadding * 2

  const longest = boundsW > boundsH ? boundsW : boundsH
  if (longest <= MIN_ACTIVE_SIZE) {
    return
  }

  const targetStep = longest / MAX_GRID_STEPS
  const cols = clampInt(Math.ceil(boundsW / targetStep), MIN_GRID_STEPS, MAX_GRID_STEPS)
  const rows = clampInt(Math.ceil(boundsH / targetStep), MIN_GRID_STEPS, MAX_GRID_STEPS)
  const dx = boundsW / cols
  const dy = boundsH / rows
  const stride = cols + 1
  const ox = offset.x
  const oy = offset.y

  // 1. Sample the SDF over the (cols+1) x (rows+1) adaptive grid.
  for (let iy = 0; iy <= rows; iy++) {
    const y = boundsY + iy * dy
    const rowBase = iy * stride
    for (let ix = 0; ix <= cols; ix++) {
      fieldBuf[rowBase + ix] = evalContourFieldPoint(boundsX + ix * dx, y, prepared)
    }
  }

  // 2. Refine horizontal and vertical zero-crossing edges with 3 bisection steps and linear interpolation.
  for (let iy = 0; iy <= rows; iy++) {
    const yWorld = boundsY + iy * dy
    const yLocal = yWorld - oy
    const rowBase = iy * stride
    const edgeRowBase = iy * MAX_GRID_NODES
    for (let ix = 0; ix < cols; ix++) {
      const v0 = fieldBuf[rowBase + ix]!
      const v1 = fieldBuf[rowBase + ix + 1]!
      if ((v0 < 0) !== (v1 < 0)) {
        const x0 = boundsX + ix * dx
        let lo = 0
        let hi = 1
        let vLo = v0
        let vHi = v1
        for (let iter = 0; iter < 3; iter++) {
          const mid = 0.5 * (lo + hi)
          const vm = evalContourFieldPoint(x0 + mid * dx, yWorld, prepared)
          if ((vm < 0) === (vLo < 0)) {
            lo = mid
            vLo = vm
          } else {
            hi = mid
            vHi = vm
          }
        }
        const t = lo + (hi - lo) * (vLo / (vLo - vHi))
        const eId = edgeRowBase + ix
        hEdgeX[eId] = x0 + t * dx - ox
        hEdgeY[eId] = yLocal
      }
    }
  }

  for (let iy = 0; iy < rows; iy++) {
    const y0 = boundsY + iy * dy
    const rowBase = iy * stride
    const nextRowBase = (iy + 1) * stride
    const edgeRowBase = iy * MAX_GRID_NODES
    for (let ix = 0; ix <= cols; ix++) {
      const v0 = fieldBuf[rowBase + ix]!
      const v1 = fieldBuf[nextRowBase + ix]!
      if ((v0 < 0) !== (v1 < 0)) {
        const xWorld = boundsX + ix * dx
        let lo = 0
        let hi = 1
        let vLo = v0
        let vHi = v1
        for (let iter = 0; iter < 3; iter++) {
          const mid = 0.5 * (lo + hi)
          const vm = evalContourFieldPoint(xWorld, y0 + mid * dy, prepared)
          if ((vm < 0) === (vLo < 0)) {
            lo = mid
            vLo = vm
          } else {
            hi = mid
            vHi = vm
          }
        }
        const t = lo + (hi - lo) * (vLo / (vLo - vHi))
        const eId = edgeRowBase + ix
        vEdgeX[eId] = xWorld - ox
        vEdgeY[eId] = y0 + t * dy - oy
      }
    }
  }

  // 3. Build directed cell-edge graph (clockwise around interior in Y-down coordinates), disambiguating saddle cases 5 and 10 at cell center.
  let segmentCount = 0
  for (let cy = 0; cy < rows; cy++) {
    const r0 = cy * stride
    const r1 = (cy + 1) * stride
    const eRow = cy * MAX_GRID_NODES
    const eNextRow = (cy + 1) * MAX_GRID_NODES

    for (let cx = 0; cx < cols; cx++) {
      const vTL = fieldBuf[r0 + cx]!
      const vTR = fieldBuf[r0 + cx + 1]!
      const vBR = fieldBuf[r1 + cx + 1]!
      const vBL = fieldBuf[r1 + cx]!

      const mask =
        (vTL < 0 ? 8 : 0) |
        (vTR < 0 ? 4 : 0) |
        (vBR < 0 ? 2 : 0) |
        (vBL < 0 ? 1 : 0)

      if (mask === 0 || mask === 15) {
        continue
      }

      const eT = eRow + cx
      const eR = TOTAL_H + eRow + cx + 1
      const eB = eNextRow + cx
      const eL = TOTAL_H + eRow + cx

      switch (mask) {
        case 1:
          segmentCount = addSegment(eL, eB, segmentCount)
          break
        case 2:
          segmentCount = addSegment(eB, eR, segmentCount)
          break
        case 3:
          segmentCount = addSegment(eL, eR, segmentCount)
          break
        case 4:
          segmentCount = addSegment(eR, eT, segmentCount)
          break
        case 5: {
          const centerVal = evalContourFieldPoint(
            boundsX + (cx + 0.5) * dx,
            boundsY + (cy + 0.5) * dy,
            prepared,
          )
          if (centerVal < 0) {
            segmentCount = addSegment(eL, eT, segmentCount)
            segmentCount = addSegment(eR, eB, segmentCount)
          } else {
            segmentCount = addSegment(eR, eT, segmentCount)
            segmentCount = addSegment(eL, eB, segmentCount)
          }
          break
        }
        case 6:
          segmentCount = addSegment(eB, eT, segmentCount)
          break
        case 7:
          segmentCount = addSegment(eL, eT, segmentCount)
          break
        case 8:
          segmentCount = addSegment(eT, eL, segmentCount)
          break
        case 9:
          segmentCount = addSegment(eT, eB, segmentCount)
          break
        case 10: {
          const centerVal = evalContourFieldPoint(
            boundsX + (cx + 0.5) * dx,
            boundsY + (cy + 0.5) * dy,
            prepared,
          )
          if (centerVal < 0) {
            segmentCount = addSegment(eT, eR, segmentCount)
            segmentCount = addSegment(eB, eL, segmentCount)
          } else {
            segmentCount = addSegment(eT, eL, segmentCount)
            segmentCount = addSegment(eB, eR, segmentCount)
          }
          break
        }
        case 11:
          segmentCount = addSegment(eT, eR, segmentCount)
          break
        case 12:
          segmentCount = addSegment(eR, eL, segmentCount)
          break
        case 13:
          segmentCount = addSegment(eR, eB, segmentCount)
          break
        case 14:
          segmentCount = addSegment(eB, eL, segmentCount)
          break
      }
    }
  }

  if (segmentCount === 0) {
    return
  }

  for (let i = 0; i < segmentCount; i++) {
    visitedBuf[activeEdgeList[i]!] = 0
  }

  // 4. Chain directed edges into closed loops (supporting multiple islands and interior holes).
  const maxLoopSteps = segmentCount + 1

  for (let i = 0; i < segmentCount; i++) {
    const startEdge = activeEdgeList[i]!
    if (visitedBuf[startEdge]!) {
      continue
    }

    let cur = startEdge
    let vertexCount = 0
    let lastX = Number.NaN
    let lastY = Number.NaN
    reusableLoopParts.length = 0

    for (let step = 0; step < maxLoopSteps; step++) {
      if (visitedBuf[cur]!) {
        break
      }
      visitedBuf[cur] = 1

      let px: number
      let py: number
      if (cur < TOTAL_H) {
        px = fmt(hEdgeX[cur]!)
        py = fmt(hEdgeY[cur]!)
      } else {
        const vIdx = cur - TOTAL_H
        px = fmt(vEdgeX[vIdx]!)
        py = fmt(vEdgeY[vIdx]!)
      }

      if (vertexCount === 0) {
        reusableLoopParts.push(`M${px} ${py}`)
        lastX = px
        lastY = py
        vertexCount = 1
      } else if (Math.abs(px - lastX) > 0.02 || Math.abs(py - lastY) > 0.02) {
        reusableLoopParts.push(`L${px} ${py}`)
        lastX = px
        lastY = py
        vertexCount++
      }

      cur = nextEdgeBuf[cur]!
      if (cur === startEdge || cur < 0) {
        break
      }
    }

    if (vertexCount >= 3) {
      reusableLoopParts.push('Z')
      outLoops.push(reusableLoopParts.join(''))
    }
  }
}
