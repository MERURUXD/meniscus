/**
 * Unit tests for the @meniscus/core Stored-PNG displacement map generator.
 * Verifies PNG chunk structure, CRC32/Adler32 checksums, N=0/1/2/4/16/20 rasterization paths,
 * inward/outward AA alpha, edge displacement polarity, AABB pruning exactness, and quantized caching.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib'
import type { GlassPrimitive } from '../src/contracts.ts'
import { buildRefractMapDataUrl, createRefractMapBuilder } from '../src/refractMap.ts'

interface DecodedRgba {
  r: number
  g: number
  b: number
  a: number
}

function decodeStoredRgbaPng(dataUrl: string): {
  width: number
  height: number
  raw: Buffer
  pixelAt: (px: number, py: number) => DecodedRgba
} {
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'expected PNG data URL')
  const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    'valid PNG signature',
  )

  let offset = 8
  let width = 0
  let height = 0
  const idatParts: Buffer[] = []
  let sawIend = false
  while (offset < bytes.length) {
    const len = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    const storedCrc = bytes.readUInt32BE(dataEnd)
    const computedCrc = zlibCrc32(bytes.subarray(offset + 4, dataEnd)) >>> 0
    assert.equal(storedCrc, computedCrc, `CRC mismatch in PNG chunk ${type}`)
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      assert.equal(bytes[dataStart + 8], 8, '8-bit depth')
      assert.equal(bytes[dataStart + 9], 6, 'RGBA color type 6')
      assert.equal(bytes[dataStart + 10], 0, 'compression method 0')
      assert.equal(bytes[dataStart + 11], 0, 'filter method 0')
      assert.equal(bytes[dataStart + 12], 0, 'non-interlaced')
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    offset = dataEnd + 4
  }
  assert.ok(sawIend && idatParts.length > 0, 'PNG must contain IDAT and IEND')

  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = 1 + width * 4
  assert.equal(raw.length, height * stride, 'inflated scanline byte count matches dimensions')
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, `row ${y} uses PNG filter 0`)
  }
  const pixelAt = (px: number, py: number): DecodedRgba => {
    const idx = py * stride + 1 + px * 4
    return { r: raw[idx], g: raw[idx + 1], b: raw[idx + 2], a: raw[idx + 3] }
  }
  return { width, height, raw, pixelAt }
}

test('refractMap: N=0 empty & degenerate primitives produce neutral transparent PNG and share :EMPTY cache', () => {
  const builder = createRefractMapBuilder()
  const bounds = { x: 0, y: 0, width: 40, height: 30 }

  const emptyRes = builder.build({
    bounds,
    field: { primitives: [], blendK: 28 },
    bezel: 12,
    mapScale: 0.5,
  })
  assert.equal(emptyRes.changed, true)
  assert.equal(emptyRes.width, 40)
  assert.equal(emptyRes.height, 30)

  const png = decodeStoredRgbaPng(emptyRes.dataUrl)
  assert.equal(png.width, 20)
  assert.equal(png.height, 15)
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      assert.deepEqual(png.pixelAt(px, py), { r: 128, g: 128, b: 128, a: 0 })
    }
  }

  // Degenerate-only primitives should hit the same :EMPTY cache key
  const degenerateRes = builder.build({
    bounds,
    field: {
      primitives: [
        { center: { x: 20, y: 15 }, size: { width: 0.005, height: 20 }, radius: 4 },
        { center: { x: 10, y: 10 }, size: { width: 20, height: 0 }, radius: 0 },
      ],
      blendK: 28,
    },
    bezel: 12,
    mapScale: 0.5,
  })
  assert.equal(degenerateRes.changed, false)
  assert.equal(degenerateRes.dataUrl, emptyRes.dataUrl)
})

test('refractMap: N=1 multi-block stored PNG (>65535B), inward normal polarity, bevel decay, cornerBend, and AA alpha', () => {
  const builder = createRefractMapBuilder()

  // 400x400 CSS @ 0.5x => 200x200 PNG (160,200 scanline bytes, spanning multiple 65535B Stored-DEFLATE blocks)
  const bounds = { x: 0, y: 0, width: 400, height: 400 }
  const rectShape: GlassPrimitive = {
    center: { x: 200, y: 200 },
    size: { width: 240, height: 240 },
    radius: 24,
  }
  const singleRes = builder.build({
    bounds,
    field: { primitives: [rectShape], blendK: 0 },
    bezel: 20,
    mapScale: 0.5,
  })
  assert.equal(singleRes.changed, true)
  assert.equal(singleRes.width, 400)
  assert.equal(singleRes.height, 400)

  const decoded = decodeStoredRgbaPng(singleRes.dataUrl)
  assert.equal(decoded.width, 200)
  assert.equal(decoded.height, 200)

  const sampleCss = (wx: number, wy: number) => {
    const px = Math.round((wx - bounds.x) / 2 - 0.5)
    const py = Math.round((wy - bounds.y) / 2 - 0.5)
    return decoded.pixelAt(px, py)
  }

  // Inward displacement polarity along all four edges (pointing into the glass interior)
  const leftEdge = sampleCss(83, 200)
  assert.ok(leftEdge.r > 135 && Math.abs(leftEdge.g - 128) <= 1, `left expected R>135, got ${JSON.stringify(leftEdge)}`)
  const rightEdge = sampleCss(317, 200)
  assert.ok(rightEdge.r < 121 && Math.abs(rightEdge.g - 128) <= 1, `right expected R<121, got ${JSON.stringify(rightEdge)}`)
  const topEdge = sampleCss(200, 83)
  assert.ok(topEdge.g > 135 && Math.abs(topEdge.r - 128) <= 1, `top expected G>135, got ${JSON.stringify(topEdge)}`)
  const bottomEdge = sampleCss(200, 317)
  assert.ok(bottomEdge.g < 121 && Math.abs(bottomEdge.r - 128) <= 1, `bottom expected G<121, got ${JSON.stringify(bottomEdge)}`)

  // Bezel falloff and neutral deep interior
  const leftMid = sampleCss(91, 200)
  const centerPx = sampleCss(200, 200)
  assert.ok(Math.abs(leftEdge.r - 128) > Math.abs(leftMid.r - 128), 'displacement decays inward across bezel')
  assert.deepEqual(centerPx, { r: 128, g: 128, b: 128, a: 255 })
  assert.deepEqual(sampleCss(77, 200), { r: 128, g: 128, b: 128, a: 0 })

  // radius < bezel triggers cornerBend: inward displacement near top-left corner points (+X, +Y)
  const cornerBendRes = builder.build({
    bounds: { x: 0, y: 0, width: 64, height: 64 },
    field: {
      primitives: [{ center: { x: 32, y: 32 }, size: { width: 48, height: 48 }, radius: 6 }],
      blendK: 0,
    },
    bezel: 16,
    mapScale: 1,
  })
  const cornerPng = decodeStoredRgbaPng(cornerBendRes.dataUrl)
  // Top-left corner sits at (8, 8); sample (11.5, 11.5) -> px=11, py=11
  const topLeftCornerPx = cornerPng.pixelAt(11, 11)
  assert.ok(topLeftCornerPx.r > 128 && topLeftCornerPx.g > 128, `cornerBend must bend inward (+X,+Y), got ${JSON.stringify(topLeftCornerPx)}`)

  // Exact boundary AA alpha: sd=+0.5 -> 0, sd=0 -> 128, sd=-0.5 -> 255
  const aaRes = builder.build({
    bounds: { x: 0, y: 0, width: 64, height: 64 },
    field: {
      primitives: [{ center: { x: 32, y: 32 }, size: { width: 32, height: 32 }, radius: 6 }],
      blendK: 0,
    },
    bezel: 8,
    falloff: 2.6,
    mapScale: 1,
  })
  const aaPng = decodeStoredRgbaPng(aaRes.dataUrl)
  assert.equal(aaPng.pixelAt(32, 15).a, 0)
  assert.equal(aaPng.pixelAt(32, 16).a, 255)

  const midAaRes = builder.build({
    bounds: { x: 0, y: 0, width: 64, height: 64 },
    field: {
      primitives: [{ center: { x: 32, y: 32.5 }, size: { width: 32, height: 32 }, radius: 6 }],
      blendK: 0,
    },
    bezel: 8,
    falloff: 2.6,
    mapScale: 1,
  })
  const midAaPng = decodeStoredRgbaPng(midAaRes.dataUrl)
  assert.equal(midAaPng.pixelAt(32, 16).a, 128)
})

test('refractMap: N=2 smin neck vs hard union, and cache hit/reset lifecycle', () => {
  const builder = createRefractMapBuilder()
  const bounds = { x: 0, y: 0, width: 200, height: 220 }
  const shapeA: GlassPrimitive = { center: { x: 100, y: 150 }, size: { width: 120, height: 100 }, radius: 20 }
  const shapeB: GlassPrimitive = { center: { x: 100, y: 70 }, size: { width: 60, height: 40 }, radius: 20 }

  const sminRes = builder.build({
    bounds,
    field: { primitives: [shapeA, shapeB], blendK: 28 },
    bezel: 12,
    mapScale: 1,
  })
  assert.equal(sminRes.changed, true)
  const sminPng = decodeStoredRgbaPng(sminRes.dataUrl)
  assert.equal(sminPng.pixelAt(100, 95).a, 255, 'smin blendK=28 bridges 10px gap')

  // Quantized cache hit (<0.1px jitter)
  const cachedRes = builder.build({
    bounds,
    field: {
      primitives: [
        { ...shapeA, center: { x: 100.04, y: 150.03 } },
        shapeB,
      ],
      blendK: 28,
    },
    bezel: 12,
    mapScale: 1,
  })
  assert.equal(cachedRes.changed, false)
  assert.equal(cachedRes.dataUrl, sminRes.dataUrl)

  // Changing blendK must invalidate cache
  const hardRes = builder.build({
    bounds,
    field: { primitives: [shapeA, shapeB], blendK: 0 },
    bezel: 12,
    mapScale: 1,
  })
  assert.equal(hardRes.changed, true)
  const hardPng = decodeStoredRgbaPng(hardRes.dataUrl)
  assert.equal(hardPng.pixelAt(100, 95).a, 0, 'blendK=0 leaves 10px gap transparent')

  // reset() must clear cache
  builder.reset()
  const afterReset = builder.build({
    bounds,
    field: { primitives: [shapeA, shapeB], blendK: 0 },
    bezel: 12,
    mapScale: 1,
  })
  assert.equal(afterReset.changed, true)
})

test('refractMap: N=4 and N=16/20 multi-primitive SoA rasterization, AABB pruning exactness, and stateless API', () => {
  const builder = createRefractMapBuilder()

  // Verify N=4 matches N=2 pixel-for-pixel near A/B when two extra primitives are far away (zero AABB pruning error)
  const bounds4 = { x: 0, y: 0, width: 320, height: 220 }
  const p0: GlassPrimitive = { center: { x: 80, y: 140 }, size: { width: 90, height: 80 }, radius: 18 }
  const p1: GlassPrimitive = { center: { x: 80, y: 74 }, size: { width: 52, height: 34 }, radius: 17 }
  const p2: GlassPrimitive = { center: { x: 250, y: 60 }, size: { width: 60, height: 50 }, radius: 16 }
  const p3: GlassPrimitive = { center: { x: 250, y: 140 }, size: { width: 70, height: 60 }, radius: 20 }

  const res2 = builder.build({
    bounds: bounds4,
    field: { primitives: [p0, p1], blendK: 24 },
    bezel: 14,
    mapScale: 1,
  })
  const png2 = decodeStoredRgbaPng(res2.dataUrl)

  const res4 = builder.build({
    bounds: bounds4,
    field: { primitives: [p0, p1, p2, p3], blendK: 24 },
    bezel: 14,
    mapScale: 1,
  })
  const png4 = decodeStoredRgbaPng(res4.dataUrl)

  // Left region around p0-p1 (far from p2/p3) must match N=2 pixel-for-pixel
  for (let py = 40; py <= 185; py += 5) {
    for (let px = 20; px <= 130; px += 5) {
      assert.deepEqual(
        png4.pixelAt(px, py),
        png2.pixelAt(px, py),
        `N=4 pixel (${px},${py}) must match N=2 exactly under AABB pruning`,
      )
    }
  }
  // Right-side p2/p3 interiors must be opaque, while empty rows stay neutral transparent
  assert.equal(png4.pixelAt(250, 60).a, 255)
  assert.equal(png4.pixelAt(250, 140).a, 255)
  assert.deepEqual(png4.pixelAt(10, 5), { r: 128, g: 128, b: 128, a: 0 })

  // Verify N=16 and N=20 (exercises SoA buffer capacity doubling from initial 16 to 32)
  const buildGrid = (count: number): GlassPrimitive[] => {
    const out: GlassPrimitive[] = []
    for (let i = 0; i < count; i++) {
      const col = i % 5
      const row = Math.floor(i / 5)
      out.push({
        center: { x: 30 + col * 36, y: 30 + row * 36 },
        size: { width: 26, height: 26 },
        radius: 8,
      })
    }
    return out
  }

  const res16 = builder.build({
    bounds: { x: 0, y: 0, width: 220, height: 180 },
    field: { primitives: buildGrid(16), blendK: 14 },
    bezel: 8,
    mapScale: 0.5,
  })
  const png16 = decodeStoredRgbaPng(res16.dataUrl)
  assert.equal(png16.width, 110)
  assert.equal(png16.height, 90)
  // Primitive 0 center (30, 30) @ 0.5x => pixel (14, 14)
  assert.equal(png16.pixelAt(14, 14).a, 255)

  const url20 = buildRefractMapDataUrl({
    bounds: { x: 0, y: 0, width: 220, height: 180 },
    field: { primitives: buildGrid(20), blendK: 14 },
    bezel: 8,
    mapScale: 0.5,
  })
  const png20 = decodeStoredRgbaPng(url20)
  assert.equal(png20.width, 110)
  assert.equal(png20.height, 90)
  // Primitive 19 at col=4, row=3 -> (174, 138) @ 0.5x => pixel (86, 68)
  assert.equal(png20.pixelAt(86, 68).a, 255)
})

test('refractMap: signed AABB pruning preserves deep overlap bevel band when accDist < -blendK and blendK < bezel', () => {
  const builder = createRefractMapBuilder()
  const bounds = { x: 0, y: 0, width: 280, height: 160 }
  // p0 covers x:[30..90], y:[30..130]; p1 covers x:[30..130], y:[30..130].
  // At (78.5, 80.5), p0's signed distance is ~ -11.5 (< -blendK = -8) while p1 is much deeper inside (sd1 ~ -48.5).
  // With bezel=24 > blendK=8, an unsigned lb=0 would wrongly prune p1 and leave spurious refraction in the deep interior.
  const p0: GlassPrimitive = { center: { x: 60, y: 80 }, size: { width: 60, height: 100 }, radius: 8 }
  const p1: GlassPrimitive = { center: { x: 80, y: 80 }, size: { width: 100, height: 100 }, radius: 8 }
  const p2Far: GlassPrimitive = { center: { x: 240, y: 80 }, size: { width: 40, height: 40 }, radius: 8 }

  const baselineRes = builder.build({
    bounds,
    field: { primitives: [p0, p1], blendK: 8 },
    bezel: 24,
    mapScale: 1,
  })
  const baselinePng = decodeStoredRgbaPng(baselineRes.dataUrl)

  const multiRes = builder.build({
    bounds,
    field: { primitives: [p0, p1, p2Far], blendK: 8 },
    bezel: 24,
    mapScale: 1,
  })
  const multiPng = decodeStoredRgbaPng(multiRes.dataUrl)

  // Deep overlap (78, 80) must be pulled past effBezel by p1 (neutral RGBA 128,128,128,255)
  assert.deepEqual(multiPng.pixelAt(78, 80), { r: 128, g: 128, b: 128, a: 255 })

  // Entire p0/p1 overlap bevel band (including accDist < -blendK) must match the unpruned N=2 baseline pixel-for-pixel
  for (let py = 26; py <= 134; py += 2) {
    for (let px = 26; px <= 134; px += 2) {
      assert.deepEqual(
        multiPng.pixelAt(px, py),
        baselinePng.pixelAt(px, py),
        `deep overlap pixel (${px},${py}) must match unpruned N=2 baseline`,
      )
    }
  }
})
