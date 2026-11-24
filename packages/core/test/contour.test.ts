import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlassFieldState, GlassPrimitive, Point } from '../src/contracts.ts'
import {
  computeMaxSminDilationFactor,
  extractFieldContourPath,
  formatRoundedRectPath,
} from '../src/contour.ts'
import { computeFieldBounds, evaluateFieldDistance } from '../src/sdf.ts'

/** Parses vertex loops from Marching Squares polygon SVG paths (M...L...Z). */
function parsePolygonLoops(path: string): Point[][] {
  if (!path) return []
  const loops: Point[][] = []
  const subpaths = path.match(/M[^Z]*Z/g) ?? []
  for (const sub of subpaths) {
    const tokens = sub.match(/[MLZ]|-?\d+(?:\.\d+)?/g) ?? []
    const pts: Point[] = []
    let i = 0
    while (i < tokens.length) {
      const cmd = tokens[i]
      if (cmd === 'M' || cmd === 'L') {
        const x = Number(tokens[i + 1])
        const y = Number(tokens[i + 2])
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `Invalid vertex coordinates: ${sub}`)
        pts.push({ x, y })
        i += 3
      } else {
        i += 1
      }
    }
    loops.push(pts)
  }
  return loops
}

/** Asserts that all SVG subpaths are strictly closed and free of NaN. */
function assertClosedValidPath(path: string, expectedLoops?: number): void {
  assert.equal(path.includes('NaN'), false, 'Path must not contain NaN')
  const mCount = (path.match(/M/g) ?? []).length
  const zCount = (path.match(/Z/g) ?? []).length
  assert.equal(mCount, zCount, 'Each M subpath must close with Z')
  if (expectedLoops !== undefined) {
    assert.equal(mCount, expectedLoops, `Expected ${expectedLoops} loops, got ${mCount}`)
  }
}

test('N=0, 1 and blendK<=0.001 analytic path output', () => {
  // N = 0
  assert.equal(extractFieldContourPath({ primitives: [], blendK: 28 }), '')
  assert.equal(
    extractFieldContourPath({
      primitives: [{ center: { x: 10, y: 10 }, size: { width: 0.005, height: 20 }, radius: 4 }],
      blendK: 28,
    }),
    '',
  )

  // N = 1 rounded rectangle and sharp-corner fallback
  const platter: GlassPrimitive = { center: { x: 200, y: 200 }, size: { width: 120, height: 140 }, radius: 22 }
  const singlePath = extractFieldContourPath({ primitives: [platter], blendK: 28 }, { x: 100, y: 80 })
  assert.match(singlePath, /^M62 50/)
  assert.ok(singlePath.includes('A22 22 0 0 1'))
  assertClosedValidPath(singlePath, 1)

  const sharpRect: GlassPrimitive = { center: { x: 50, y: 50 }, size: { width: 40, height: 20 }, radius: 0 }
  assert.equal(formatRoundedRectPath(sharpRect), 'M30 40L70 40L70 60L30 60Z')

  // blendK <= 0.001 concatenates analytic subpaths
  const p2: GlassPrimitive = { center: { x: 400, y: 400 }, size: { width: 40, height: 40 }, radius: 12 }
  const unblended = extractFieldContourPath({ primitives: [platter, p2], blendK: 0 })
  assertClosedValidPath(unblended, 2)
  assert.ok(unblended.includes('A22 22 0 0 1'))
  assert.ok(unblended.includes('A12 12 0 0 1'))
})

test('N=2 bridged single loop and split dual islands', () => {
  const platter: GlassPrimitive = { center: { x: 200, y: 200 }, size: { width: 120, height: 140 }, radius: 22 }
  const dropletNear: GlassPrimitive = { center: { x: 200, y: 112 }, size: { width: 44, height: 44 }, radius: 22 }
  const dropletFar: GlassPrimitive = { center: { x: 200, y: 40 }, size: { width: 32, height: 32 }, radius: 16 }

  // Bridged single loop
  const bridged = extractFieldContourPath({ primitives: [platter, dropletNear], blendK: 28 }, { x: 100, y: 80 })
  assertClosedValidPath(bridged, 1)
  assert.ok(bridged.includes('L'))

  // Split dual islands
  const pinched = extractFieldContourPath({ primitives: [platter, dropletFar], blendK: 28 })
  assertClosedValidPath(pinched, 2)
})

test('N=3, 8, 16 contour closure, multi-island support, zero-isosurface accuracy, and anti-clipping', () => {
  // N = 3: two nearby + one distant primitive (2 islands: a 2-body bridge + an isolated capsule)
  const field3: GlassFieldState = {
    primitives: [
      { center: { x: 100, y: 100 }, size: { width: 80, height: 60 }, radius: 18 },
      { center: { x: 175, y: 100 }, size: { width: 48, height: 48 }, radius: 24 },
      { center: { x: 340, y: 100 }, size: { width: 50, height: 40 }, radius: 16 },
    ],
    blendK: 28,
  }
  const path3 = extractFieldContourPath(field3)
  assertClosedValidPath(path3, 2)

  // N = 8: ring cluster merging into a closed loop (with optional interior hole)
  const primitives8: GlassPrimitive[] = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI * 2) / 8
    return {
      center: { x: 200 + Math.cos(angle) * 52, y: 200 + Math.sin(angle) * 52 },
      size: { width: 44, height: 44 },
      radius: 22,
    }
  })
  const field8: GlassFieldState = { primitives: primitives8, blendK: 28 }
  const path8 = extractFieldContourPath(field8)
  // At least 1-2 valid closed loops (outer rim + optional inner hole)
  assertClosedValidPath(path8)
  const loops8 = parsePolygonLoops(path8)
  assert.ok(loops8.length >= 1)

  // N = 16: dense cluster with large blendK to verify anti-dilation clipping margin
  const primitives16: GlassPrimitive[] = Array.from({ length: 16 }, (_, i) => {
    const col = i % 4
    const row = Math.floor(i / 4)
    return {
      center: { x: 100 + col * 58, y: 100 + row * 58 },
      size: { width: 48, height: 48 },
      radius: 16,
    }
  })
  const blendK16 = 40
  const field16: GlassFieldState = { primitives: primitives16, blendK: blendK16 }
  const path16 = extractFieldContourPath(field16)
  assertClosedValidPath(path16, 1)

  const padding16 = computeMaxSminDilationFactor(16) * blendK16 + 4
  const bounds16 = computeFieldBounds(field16, padding16)
  const step16 = Math.max(bounds16.width, bounds16.height) / 128

  const loops16 = parsePolygonLoops(path16)
  assert.equal(loops16.length, 1)
  assert.ok(loops16[0]!.length >= 20)

  let maxIsoError = 0
  for (const pt of loops16[0]!) {
    // Vertices must stay strictly inside the sampling bounds (no boundary clipping)
    assert.ok(
      pt.x > bounds16.x + 0.5 &&
        pt.x < bounds16.x + bounds16.width - 0.5 &&
        pt.y > bounds16.y + 0.5 &&
        pt.y < bounds16.y + bounds16.height - 0.5,
      `N=16 contour vertex (${pt.x}, ${pt.y}) touches or exceeds sampling bounds`,
    )
    const d = Math.abs(evaluateFieldDistance(pt.x, pt.y, field16))
    if (d > maxIsoError) {
      maxIsoError = d
    }
  }

  // After 3 bisection steps and fmt(0.01) rounding, isosurface error is well below grid step
  assert.ok(
    maxIsoError < step16 * 0.1,
    `Max zero-isosurface error ${maxIsoError} should be well below grid step ${step16}`,
  )
})

test('N=3 and N=8 extracted vertices against evaluateFieldDistance with offset', () => {
  const offset: Point = { x: 40, y: 25 }
  const field: GlassFieldState = {
    primitives: [
      { center: { x: 140, y: 120 }, size: { width: 90, height: 50 }, radius: 16 },
      { center: { x: 205, y: 140 }, size: { width: 56, height: 56 }, radius: 28 },
      { center: { x: 170, y: 185 }, size: { width: 70, height: 42 }, radius: 14 },
    ],
    blendK: 24,
  }
  const path = extractFieldContourPath(field, offset)
  assertClosedValidPath(path, 1)

  const bounds = computeFieldBounds(field, computeMaxSminDilationFactor(3) * 24 + 4)
  const gridStep = Math.max(bounds.width, bounds.height) / 128
  const loops = parsePolygonLoops(path)

  let maxErr = 0
  for (const pt of loops[0]!) {
    const worldX = pt.x + offset.x
    const worldY = pt.y + offset.y
    const err = Math.abs(evaluateFieldDistance(worldX, worldY, field))
    if (err > maxErr) maxErr = err
  }
  assert.ok(maxErr < gridStep * 0.1, `Max zero-isosurface error with offset (${maxErr}) should be well below grid step ${gridStep}`)
})

/** Parses command endpoints from M/L/A/Z SVG subpaths. */
function parseSubpathEndpoints(sub: string): Point[] {
  const tokens = sub.match(/[MLAZ]|-?\d+(?:\.\d+)?/g) ?? []
  const pts: Point[] = []
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i]
    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i + 1])
      const y = Number(tokens[i + 2])
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `Invalid coordinates: ${sub}`)
      pts.push({ x, y })
      i += 3
    } else if (cmd === 'A') {
      const x = Number(tokens[i + 6])
      const y = Number(tokens[i + 7])
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `Invalid arc endpoint: ${sub}`)
      pts.push({ x, y })
      i += 8
    } else {
      i += 1
    }
  }
  return pts
}

test('distant small primitive is preserved without grid undersampling (Codex P1 regression)', () => {
  const field: GlassFieldState = {
    primitives: [
      { center: { x: 100, y: 100 }, size: { width: 80, height: 60 }, radius: 16 },
      { center: { x: 3840, y: 100 }, size: { width: 16, height: 16 }, radius: 8 },
    ],
    blendK: 28,
  }

  const path = extractFieldContourPath(field)
  assertClosedValidPath(path, 2)

  const subpaths = path.match(/M[^Z]*Z/g) ?? []
  assert.equal(subpaths.length, 2)

  const capsulePts = parseSubpathEndpoints(subpaths[1]!)
  assert.ok(capsulePts.length >= 4)
  for (const pt of capsulePts) {
    assert.ok(
      pt.x >= 3832 && pt.x <= 3848 && pt.y >= 92 && pt.y <= 108,
      `Expected small capsule endpoint near (3840, 100), got (${pt.x}, ${pt.y})`,
    )
  }
})

test('mixed bridged cluster plus distant small capsule extracts 2 valid closed loops', () => {
  const field: GlassFieldState = {
    primitives: [
      { center: { x: 100, y: 100 }, size: { width: 80, height: 60 }, radius: 16 },
      { center: { x: 165, y: 100 }, size: { width: 44, height: 44 }, radius: 22 },
      { center: { x: 3840, y: 100 }, size: { width: 16, height: 16 }, radius: 8 },
    ],
    blendK: 28,
  }

  const path = extractFieldContourPath(field)
  assertClosedValidPath(path, 2)

  const subpaths = path.match(/M[^Z]*Z/g) ?? []
  assert.equal(subpaths.length, 2)

  // First loop is the Marching Squares bridged contour covering both left primitives.
  const bridgePts = parsePolygonLoops(subpaths[0]!)[0]!
  assert.ok(bridgePts.length >= 12)
  for (const pt of bridgePts) {
    assert.ok(pt.x > 40 && pt.x < 210, `Unexpected bridge vertex x=${pt.x}`)
  }

  // Second loop is the distant 16x16 capsule around (3840, 100).
  const capsulePts = parseSubpathEndpoints(subpaths[1]!)
  assert.ok(capsulePts.length >= 4)
  for (const pt of capsulePts) {
    assert.ok(
      pt.x >= 3832 && pt.x <= 3848 && pt.y >= 92 && pt.y <= 108,
      `Expected small capsule endpoint near (3840, 100), got (${pt.x}, ${pt.y})`,
    )
  }
})

test('isolated island inside concave L-shaped cluster AABB is not duplicated', () => {
  const field: GlassFieldState = {
    primitives: [
      { center: { x: 0, y: 0 }, size: { width: 40, height: 40 }, radius: 10 },
      { center: { x: 0, y: 50 }, size: { width: 40, height: 40 }, radius: 10 },
      { center: { x: 50, y: 0 }, size: { width: 40, height: 40 }, radius: 10 },
      { center: { x: 65, y: 65 }, size: { width: 20, height: 20 }, radius: 10 },
    ],
    blendK: 28,
  }

  const path = extractFieldContourPath(field)
  assertClosedValidPath(path, 2)
})

test('dynamic cluster buffer expansion supports more than 16 active primitives', () => {
  const primitives: GlassPrimitive[] = Array.from({ length: 20 }, (_, i) => ({
    center: { x: i * 120, y: 100 },
    size: { width: 24, height: 24 },
    radius: 12,
  }))
  const path = extractFieldContourPath({ primitives, blendK: 28 })
  assertClosedValidPath(path, 20)
})

/** Checks whether `pt` lies strictly inside a closed polygon via ray casting. */
function isPointInPolygon(pt: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x
    const yi = polygon[i]!.y
    const xj = polygon[j]!.x
    const yj = polygon[j]!.y
    const intersects = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi
    if (intersects) {
      inside = !inside
    }
  }
  return inside
}

test('computeMaxSminDilationFactor follows exact u_{n+1} = (1 + u_n)^2 / 4 recurrence', () => {
  assert.equal(computeMaxSminDilationFactor(0), 0)
  assert.equal(computeMaxSminDilationFactor(1), 0)
  assert.equal(computeMaxSminDilationFactor(2), 0.25)
  assert.equal(computeMaxSminDilationFactor(3), 0.390625)

  let prev = 0
  for (let n = 2; n <= 32; n++) {
    const next = computeMaxSminDilationFactor(n)
    const expected = ((1 + prev) * (1 + prev)) * 0.25
    assert.ok(Math.abs(next - expected) < 1e-12)
    assert.ok(next > prev && next < 1)
    prev = next
  }
})

test('cluster packing preserves original primitive folding order (Codex Round 2 P1 regression)', () => {
  const clusterPrimitives: GlassPrimitive[] = [
    { center: { x: 0, y: 0 }, size: { width: 20, height: 20 }, radius: 5 },
    { center: { x: 130, y: 0 }, size: { width: 20, height: 20 }, radius: 5 },
    { center: { x: 65, y: 0 }, size: { width: 20, height: 20 }, radius: 5 },
  ]
  const isolated: GlassPrimitive = {
    center: { x: 1000, y: 1000 },
    size: { width: 20, height: 20 },
    radius: 5,
  }
  const blendK = 100
  const fieldWithIsolated: GlassFieldState = {
    primitives: [...clusterPrimitives, isolated],
    blendK,
  }
  const fieldClusterOnly: GlassFieldState = {
    primitives: clusterPrimitives,
    blendK,
  }

  const fullPath = extractFieldContourPath(fieldWithIsolated)
  assertClosedValidPath(fullPath, 2)

  const subpaths = fullPath.match(/M[^Z]*Z/g) ?? []
  assert.equal(subpaths.length, 2)

  const clusterOnlyPath = extractFieldContourPath(fieldClusterOnly)
  assert.equal(
    subpaths[0],
    clusterOnlyPath,
    'First cluster contour must be character-for-character identical regardless of distant isolated primitives',
  )

  const padding = computeMaxSminDilationFactor(3) * blendK + 4
  const bounds = computeFieldBounds(fieldClusterOnly, padding)
  const gridStep = Math.max(bounds.width, bounds.height) / 128

  const loops = parsePolygonLoops(subpaths[0]!)
  assert.equal(loops.length, 1)
  let maxErr = 0
  for (const pt of loops[0]!) {
    const err = Math.abs(evaluateFieldDistance(pt.x, pt.y, fieldWithIsolated))
    if (err > maxErr) {
      maxErr = err
    }
  }
  assert.ok(
    maxErr < gridStep * 0.1,
    `Max zero-isosurface error ${maxErr} must be well below grid step ${gridStep}`,
  )
})

test('cumulative smin dilation groups 8 coincident boxes with gap=120 box without clipping (Codex Round 2 P1 regression)', () => {
  const primitives: GlassPrimitive[] = [
    ...Array.from({ length: 8 }, () => ({
      center: { x: 0, y: 0 },
      size: { width: 20, height: 20 },
      radius: 0,
    })),
    { center: { x: 140, y: 0 }, size: { width: 20, height: 20 }, radius: 0 },
  ]
  const blendK = 100
  const field: GlassFieldState = { primitives, blendK }

  const path = extractFieldContourPath(field)
  assertClosedValidPath(path, 2)
  assert.equal(
    path.includes('M130 -10L150 -10L150 10L130 10Z'),
    false,
    'Must not emit an isolated analytic rectangle for the 9th primitive',
  )

  const padding = computeMaxSminDilationFactor(9) * blendK + 4
  const bounds = computeFieldBounds(field, padding)
  const gridStep = Math.max(bounds.width, bounds.height) / 128

  const loops = parsePolygonLoops(path)
  assert.equal(loops.length, 2)
  let maxErr = 0
  for (const loop of loops) {
    assert.ok(loop.length >= 4)
    for (const pt of loop) {
      assert.ok(
        pt.x > bounds.x + 0.5 &&
          pt.x < bounds.x + bounds.width - 0.5 &&
          pt.y > bounds.y + 0.5 &&
          pt.y < bounds.y + bounds.height - 0.5,
        `Vertex (${pt.x}, ${pt.y}) must stay strictly inside sampling bounds`,
      )
      const err = Math.abs(evaluateFieldDistance(pt.x, pt.y, field))
      if (err > maxErr) {
        maxErr = err
      }
    }
  }
  assert.ok(
    maxErr < gridStep * 0.1,
    `Max zero-isosurface error ${maxErr} must be well below grid step ${gridStep}`,
  )

  const probe: Point = { x: 130, y: 0 }
  const probeDist = evaluateFieldDistance(probe.x, probe.y, field)
  assert.ok(probeDist < -5, `Expected probe distance near -5.59, got ${probeDist}`)
  assert.equal(
    loops.some((loop) => isPointInPolygon(probe, loop)),
    true,
    'Point (130, 0) must lie strictly inside an extracted contour loop rather than being isolated or clipped',
  )
})

test('moving an unmerged primitive inside a multi-primitive cluster keeps stationary contour loops bit-for-bit identical', () => {
  // Four unmerged droplets with pairwise gaps > blendK (32) and <= connectThreshold (~67px)
  // so all 4 share one Marching Squares cluster without entering smin pull range, staying on baseStep=4.
  const anchor: GlassPrimitive = { center: { x: 380, y: 188 }, size: { width: 164, height: 58 }, radius: 29 }
  const orbB: GlassPrimitive = { center: { x: 500, y: 272 }, size: { width: 102, height: 82 }, radius: 26 }
  const pillC: GlassPrimitive = { center: { x: 380, y: 362 }, size: { width: 136, height: 54 }, radius: 27 }
  const makeMovingOrb = (dx: number, dy: number): GlassPrimitive => ({
    center: { x: 248 + dx, y: 276 + dy },
    size: { width: 90, height: 90 },
    radius: 45,
  })

  const stationaryTargets: Array<{ name: string; pt: Point }> = [
    { name: 'anchor', pt: anchor.center },
    { name: 'orbB', pt: orbB.center },
    { name: 'pillC', pt: pillC.center },
  ]

  const extractStationarySubpaths = (dx: number, dy: number): string[] => {
    const path = extractFieldContourPath({
      primitives: [anchor, makeMovingOrb(dx, dy), orbB, pillC],
      blendK: 32,
    })
    assertClosedValidPath(path, 4)
    const loops = parsePolygonLoops(path)
    return stationaryTargets.map(({ name, pt }) => {
      const idx = loops.findIndex((loop) => isPointInPolygon(pt, loop))
      assert.ok(idx >= 0, `Expected closed contour containing stationary ${name}`)
      return JSON.stringify(loops[idx]!)
    })
  }

  const baseline = extractStationarySubpaths(0, 0)
  for (const [dx, dy] of [
    [0.5, 0],
    [-1, 0.5],
    [-7, 4],
    [4, -3],
  ]) {
    const shifted = extractStationarySubpaths(dx, dy)
    for (let i = 0; i < stationaryTargets.length; i++) {
      assert.equal(
        shifted[i],
        baseline[i],
        `Stationary contour for ${stationaryTargets[i]!.name} drifted at delta (${dx}, ${dy})`,
      )
    }
  }
})
