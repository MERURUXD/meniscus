import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlassFieldState, GlassPrimitive, Point } from '../src/contracts.ts'
import {
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
} from '../src/sdf.ts'

function approx(actual: number, expected: number, eps = 1e-12, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label ? `${label}: ` : ''}expected ${actual} ≈ ${expected} (±${eps})`,
  )
}

/** Unpruned brute-force iterative smin reference to verify lossless AABB lower-bound pruning. */
function bruteForceIterativeDistance(
  pointX: number,
  pointY: number,
  primitives: readonly GlassPrimitive[],
  blendK: number,
): number {
  const active = primitives.filter((p) => p.size.width > 0.01 && p.size.height > 0.01)
  if (active.length === 0) return Infinity
  let acc = computeRoundedBoxDistance(pointX, pointY, active[0]!)
  for (let i = 1; i < active.length; i++) {
    const di = computeRoundedBoxDistance(pointX, pointY, active[i]!)
    acc = computeSminDistance(acc, di, blendK)
  }
  return acc
}

function bruteForceIterativeSdf(
  point: Point,
  primitives: readonly GlassPrimitive[],
  blendK: number,
) {
  const active = primitives.filter((p) => p.size.width > 0.01 && p.size.height > 0.01)
  if (active.length === 0) {
    return { distance: Infinity, normal: { x: 0, y: -1 } }
  }
  let acc = computeRoundedBoxSdf(point, active[0]!)
  for (let i = 1; i < active.length; i++) {
    const si = computeRoundedBoxSdf(point, active[i]!)
    const blended = computeSmin(acc.distance, si.distance, acc.normal, si.normal, blendK)
    acc = { distance: blended.distance, normal: blended.normal }
  }
  return acc
}

test('single-primitive SDF and basic smin identities', () => {
  const box: GlassPrimitive = { center: { x: 100, y: 100 }, size: { width: 80, height: 40 }, radius: 12 }

  // Top edge midpoint (100, 80) -> distance = 0, normal = (0, -1)
  const topEdge = computeRoundedBoxSdf({ x: 100, y: 80 }, box)
  approx(topEdge.distance, 0, 1e-12, 'topEdge.distance')
  approx(topEdge.normal.x, 0, 1e-12)
  approx(topEdge.normal.y, -1, 1e-12)
  approx(computeRoundedBoxDistance(100, 80, box), 0, 1e-12)

  // Outside right (150, 100) -> distance = 10, normal = (1, 0)
  const rightOut = computeRoundedBoxSdf({ x: 150, y: 100 }, box)
  approx(rightOut.distance, 10, 1e-12)
  approx(rightOut.normal.x, 1, 1e-12)
  approx(rightOut.normal.y, 0, 1e-12)

  // Wide box center (100, 100) -> distance = -20, nearest edge is top/bottom (0, 1)
  const center = computeRoundedBoxSdf({ x: 100, y: 100 }, box)
  approx(center.distance, -20, 1e-12)
  assert.deepEqual(center.normal, { x: 0, y: 1 })

  // Degenerate square center normal fallback (0, -1)
  const square: GlassPrimitive = { center: { x: 100, y: 100 }, size: { width: 40, height: 40 }, radius: 12 }
  const squareCenter = computeRoundedBoxSdf({ x: 100, y: 100 }, square)
  approx(squareCenter.distance, -20, 1e-12)
  assert.deepEqual(squareCenter.normal, { x: 0, y: -1 })

  // Diagonal normal outside rounded corner
  const cornerOut = computeRoundedBoxSdf({ x: 140, y: 120 }, box)
  const expectedCornerDist = Math.hypot(12, 12) - 12
  approx(cornerOut.distance, expectedCornerDist, 1e-12)
  approx(cornerOut.normal.x, Math.SQRT1_2, 1e-12)
  approx(cornerOut.normal.y, Math.SQRT1_2, 1e-12)

  // Equidistant smin identity: dA == dB == 4, k = 28 -> 4 - 28 * 0.25 = -3
  const eq = computeSmin(4, 4, { x: 1, y: 0 }, { x: 0, y: 1 }, 28)
  approx(eq.blendH, 0.5, 1e-12)
  approx(eq.distance, -3, 1e-12)
  approx(Math.hypot(eq.normal.x, eq.normal.y), 1, 1e-12)
  approx(eq.normal.x, Math.SQRT1_2, 1e-12)
  approx(computeSminDistance(4, 4, 28), -3, 1e-12)

  // k = 0 reduces to exact min
  const hard = computeSmin(2, 5, { x: -1, y: 0 }, { x: 0, y: 1 }, 0)
  assert.equal(hard.distance, 2)
  assert.deepEqual(hard.normal, { x: -1, y: 0 })
  assert.equal(computeSminDistance(2, 5, 0), 2)
})

test('computeFieldBounds and computePairMergeStatus', () => {
  const emptyField: GlassFieldState = {
    primitives: [{ center: { x: 50, y: 50 }, size: { width: 0.005, height: 20 }, radius: 4 }],
    blendK: 20,
  }
  assert.deepEqual(computeFieldBounds(emptyField, 10), { x: 0, y: 0, width: 0, height: 0 })

  const platter: GlassPrimitive = { center: { x: 200, y: 200 }, size: { width: 120, height: 140 }, radius: 22 }
  const dropletNear: GlassPrimitive = { center: { x: 200, y: 180 }, size: { width: 30, height: 30 }, radius: 15 }
  const dropletFar: GlassPrimitive = { center: { x: 200, y: 40 }, size: { width: 32, height: 32 }, radius: 16 }

  assert.deepEqual(computeFieldBounds({ primitives: [platter, dropletFar], blendK: 28 }, 8), {
    x: 132,
    y: 16,
    width: 136,
    height: 262,
  })

  // Full absorption detection
  const merged = computePairMergeStatus(platter, dropletNear, 28, 8)
  assert.equal(merged.isMerged, true)
  assert.ok(merged.mergeDepth > 0)
  assert.ok(merged.rimOpacity > 0 && merged.rimOpacity <= 1)

  const separated = computePairMergeStatus(platter, dropletFar, 28, 8)
  assert.equal(separated.isMerged, false)
  assert.equal(separated.rimOpacity, 0)

  const collapsed = computePairMergeStatus(platter, { center: { x: 0, y: 0 }, size: { width: 0, height: 0 }, radius: 0 }, 28, 8)
  assert.equal(collapsed.isMerged, true)
  assert.equal(collapsed.rimOpacity, 1)
})

test('N=0, 1, 2 field evaluation and PreparedField capacity doubling', () => {
  // N = 0
  const field0: GlassFieldState = { primitives: [], blendK: 24 }
  assert.equal(evaluateFieldDistance(10, 20, field0), Infinity)
  const sdf0 = evaluateFieldSdf({ x: 10, y: 20 }, field0)
  assert.equal(sdf0.distance, Infinity)
  assert.deepEqual(sdf0.normal, { x: 0, y: -1 })

  // N = 1 (with one inactive primitive filtered out)
  const p1: GlassPrimitive = { center: { x: 60, y: 80 }, size: { width: 50, height: 30 }, radius: 10 }
  const inactive: GlassPrimitive = { center: { x: 0, y: 0 }, size: { width: 0.01, height: 40 }, radius: 0 }
  const field1: GlassFieldState = { primitives: [inactive, p1], blendK: 24 }
  approx(evaluateFieldDistance(100, 80, field1), computeRoundedBoxDistance(100, 80, p1), 1e-12)
  const sdf1 = evaluateFieldSdf({ x: 100, y: 80 }, field1)
  const ref1 = computeRoundedBoxSdf({ x: 100, y: 80 }, p1)
  approx(sdf1.distance, ref1.distance, 1e-12)
  approx(sdf1.normal.x, ref1.normal.x, 1e-12)
  approx(sdf1.normal.y, ref1.normal.y, 1e-12)

  // N = 2 (pair fast path)
  const p2: GlassPrimitive = { center: { x: 110, y: 80 }, size: { width: 40, height: 40 }, radius: 20 }
  const field2: GlassFieldState = { primitives: [p1, p2], blendK: 28 }
  const preparedSmall = createPreparedField(2)
  prepareField(field2, preparedSmall)
  assert.equal(preparedSmall.count, 2)
  assert.equal(preparedSmall.capacity, 2)

  for (const pt of [
    { x: 85, y: 80 },
    { x: 85, y: 55 },
    { x: 200, y: 200 },
    { x: 60, y: 80 },
  ]) {
    const dEval = evaluateFieldDistance(pt.x, pt.y, preparedSmall)
    const dRef = bruteForceIterativeDistance(pt.x, pt.y, field2.primitives, 28)
    approx(dEval, dRef, 1e-12, `N=2 dist (${pt.x},${pt.y})`)

    const sEval = evaluateFieldSdf(pt, preparedSmall)
    const sRef = bruteForceIterativeSdf(pt, field2.primitives, 28)
    approx(sEval.distance, sRef.distance, 1e-12, `N=2 sdf.dist (${pt.x},${pt.y})`)
    approx(sEval.normal.x, sRef.normal.x, 1e-12, `N=2 sdf.nx (${pt.x},${pt.y})`)
    approx(sEval.normal.y, sRef.normal.y, 1e-12, `N=2 sdf.ny (${pt.x},${pt.y})`)
  }

  // Verify capacity doubling when insufficient
  const many: GlassPrimitive[] = Array.from({ length: 7 }, (_, i) => ({
    center: { x: i * 40, y: 0 },
    size: { width: 30, height: 30 },
    radius: 8,
  }))
  prepareField({ primitives: many, blendK: 16 }, preparedSmall)
  assert.equal(preparedSmall.count, 7)
  assert.equal(preparedSmall.capacity, 8)
})

test('N=3, 8, 16 AABB lower-bound pruning matches brute-force within 1e-12 (including nested deep-interior case)', () => {
  const counts = [3, 8, 16]
  const blendKs = [0, 12, 28]

  for (const n of counts) {
    const primitives: GlassPrimitive[] = Array.from({ length: n }, (_, i) => {
      const col = i % 4
      const row = Math.floor(i / 4)
      return {
        center: { x: 80 + col * 68 + (row % 2) * 18, y: 80 + row * 64 },
        size: { width: 44 + (i % 3) * 12, height: 36 + (i % 4) * 8 },
        radius: 10 + (i % 3) * 4,
      }
    })
    // For N=8/16, include a large enclosing box to ensure deep-interior points are not falsely pruned.
    if (n >= 8) {
      primitives[0] = { center: { x: 120, y: 120 }, size: { width: 40, height: 40 }, radius: 10 }
      primitives[n - 1] = { center: { x: 120, y: 120 }, size: { width: 240, height: 240 }, radius: 24 }
    }

    for (const blendK of blendKs) {
      const field: GlassFieldState = { primitives, blendK }
      const prepared = prepareField(field)

      // Uniform sample grid including near and far test points.
      for (let gy = -40; gy <= 360; gy += 37) {
        for (let gx = -40; gx <= 360; gx += 41) {
          const dPruned = evaluateFieldDistance(gx, gy, prepared)
          const dBrute = bruteForceIterativeDistance(gx, gy, primitives, blendK)
          approx(dPruned, dBrute, 1e-12, `N=${n} k=${blendK} dist (${gx},${gy})`)

          const sPruned = evaluateFieldSdf({ x: gx, y: gy }, prepared)
          const sBrute = bruteForceIterativeSdf({ x: gx, y: gy }, primitives, blendK)
          approx(sPruned.distance, sBrute.distance, 1e-12, `N=${n} k=${blendK} sdf.dist (${gx},${gy})`)
          approx(sPruned.normal.x, sBrute.normal.x, 1e-12, `N=${n} k=${blendK} sdf.nx (${gx},${gy})`)
          approx(sPruned.normal.y, sBrute.normal.y, 1e-12, `N=${n} k=${blendK} sdf.ny (${gx},${gy})`)
        }
      }
    }
  }
})
