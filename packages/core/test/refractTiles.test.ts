/**
 * Unit tests for @sessile/core shared LRU-cached 9-slice Stored-PNG displacement tiles.
 * Verifies PNG structure, CRC32/Adler32 integrity, corner/edge dimensions, AA alpha,
 * inward Snell deflection polarity, cornerBend parity with full maps, signed lip behavior,
 * IOR=1 identity, tile size clamping, and cross-call LRU cache reuse.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib'
import { buildRefractMapDataUrl } from '../src/refractMap.ts'
import {
  MAX_REFRACT_TILE_PX,
  clearRefractTilesCache,
  resolveRefractTiles,
} from '../src/refractTiles.ts'

interface DecodedRgba {
  r: number
  g: number
  b: number
  a: number
}

function decodeStoredRgbaPng(dataUrl: string): {
  width: number
  height: number
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
    return { r: raw[idx]!, g: raw[idx + 1]!, b: raw[idx + 2]!, a: raw[idx + 3]! }
  }
  return { width, height, pixelAt }
}

test('resolveRefractTiles encodes valid Stored-PNG corners/strips with exact AA alpha and Snell polarity', () => {
  clearRefractTilesCache()
  const tiles = resolveRefractTiles({
    radius: 24,
    bezel: 16,
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.2,
  })

  assert.equal(tiles.slice, 24)
  assert.equal(tiles.tilePx, 24)
  assert.equal(tiles.bezel, 16)
  assert.ok(tiles.maxDisplacementPx > 0)

  const tl = decodeStoredRgbaPng(tiles.tl)
  const tr = decodeStoredRgbaPng(tiles.tr)
  const bl = decodeStoredRgbaPng(tiles.bl)
  const br = decodeStoredRgbaPng(tiles.br)
  const top = decodeStoredRgbaPng(tiles.top)
  const bottom = decodeStoredRgbaPng(tiles.bottom)
  const left = decodeStoredRgbaPng(tiles.left)
  const right = decodeStoredRgbaPng(tiles.right)

  assert.equal(tl.width, 24)
  assert.equal(tl.height, 24)
  assert.equal(tr.width, 24)
  assert.equal(tr.height, 24)
  assert.equal(bl.width, 24)
  assert.equal(bl.height, 24)
  assert.equal(br.width, 24)
  assert.equal(br.height, 24)
  assert.equal(top.width, 1)
  assert.equal(top.height, 24)
  assert.equal(bottom.width, 1)
  assert.equal(bottom.height, 24)
  assert.equal(left.width, 24)
  assert.equal(left.height, 1)
  assert.equal(right.width, 24)
  assert.equal(right.height, 1)

  // Outer empty corners must have alpha=0; inner corner point is deep plateau (128,128,128,255).
  assert.deepEqual(tl.pixelAt(0, 0), { r: 128, g: 128, b: 128, a: 0 })
  assert.deepEqual(tr.pixelAt(23, 0), { r: 128, g: 128, b: 128, a: 0 })
  assert.deepEqual(bl.pixelAt(0, 23), { r: 128, g: 128, b: 128, a: 0 })
  assert.deepEqual(br.pixelAt(23, 23), { r: 128, g: 128, b: 128, a: 0 })
  assert.deepEqual(tl.pixelAt(23, 23), { r: 128, g: 128, b: 128, a: 255 })

  // Diagonal bezel points near outer corner arcs reflect inward toward center.
  const tlRim = tl.pixelAt(9, 9)
  assert.ok(tlRim.r > 128 && tlRim.g > 128 && tlRim.a === 255)
  const trRim = tr.pixelAt(14, 9)
  assert.ok(trRim.r < 128 && trRim.g > 128 && trRim.a === 255)
  const blRim = bl.pixelAt(9, 14)
  assert.ok(blRim.r > 128 && blRim.g < 128 && blRim.a === 255)
  const brRim = br.pixelAt(14, 14)
  assert.ok(brRim.r < 128 && brRim.g < 128 && brRim.a === 255)

  // Edge strip polarity and opaque plateau interior.
  const topOuter = top.pixelAt(0, 2)
  assert.equal(topOuter.r, 128)
  assert.ok(topOuter.g > 128 && topOuter.a === 255)
  assert.deepEqual(top.pixelAt(0, 20), { r: 128, g: 128, b: 128, a: 255 })

  const bottomOuter = bottom.pixelAt(0, 21)
  assert.equal(bottomOuter.r, 128)
  assert.ok(bottomOuter.g < 128 && bottomOuter.a === 255)

  const leftOuter = left.pixelAt(2, 0)
  assert.ok(leftOuter.r > 128 && leftOuter.a === 255)
  assert.equal(leftOuter.g, 128)

  const rightOuter = right.pixelAt(21, 0)
  assert.ok(rightOuter.r < 128 && rightOuter.a === 255)
  assert.equal(rightOuter.g, 128)
})

test('resolveRefractTiles matches 1:1 full-map pixels for standard and cornerBend geometries', () => {
  clearRefractTilesCache()
  const width = 120
  const height = 100

  for (const spec of [
    { radius: 24, bezel: 16 },
    { radius: 8, bezel: 20 },
  ]) {
    const tiles = resolveRefractTiles({
      radius: spec.radius,
      bezel: spec.bezel,
      profile: 'squircle',
      ior: 1.5,
      thicknessRatio: 1.25,
    })
    const full = buildRefractMapDataUrl({
      bounds: { x: 0, y: 0, width, height },
      field: {
        blendK: 12,
        primitives: [{ center: { x: 60, y: 50 }, size: { width, height }, radius: spec.radius }],
      },
      bezel: spec.bezel,
      mapScale: 1,
      profile: 'squircle',
      ior: 1.5,
      thicknessRatio: 1.25,
    })

    const fullPng = decodeStoredRgbaPng(full)
    const tl = decodeStoredRgbaPng(tiles.tl)
    const tr = decodeStoredRgbaPng(tiles.tr)
    const bl = decodeStoredRgbaPng(tiles.bl)
    const br = decodeStoredRgbaPng(tiles.br)
    const top = decodeStoredRgbaPng(tiles.top)
    const bottom = decodeStoredRgbaPng(tiles.bottom)
    const left = decodeStoredRgbaPng(tiles.left)
    const right = decodeStoredRgbaPng(tiles.right)

    const s = tiles.tilePx
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        assert.deepEqual(tl.pixelAt(x, y), fullPng.pixelAt(x, y), `tl mismatch (${x},${y}) r=${spec.radius}`)
        assert.deepEqual(tr.pixelAt(x, y), fullPng.pixelAt(width - s + x, y), `tr mismatch (${x},${y})`)
        assert.deepEqual(bl.pixelAt(x, y), fullPng.pixelAt(x, height - s + y), `bl mismatch (${x},${y})`)
        assert.deepEqual(
          br.pixelAt(x, y),
          fullPng.pixelAt(width - s + x, height - s + y),
          `br mismatch (${x},${y})`,
        )
      }
      assert.deepEqual(top.pixelAt(0, y), fullPng.pixelAt(Math.floor(width / 2), y))
      assert.deepEqual(bottom.pixelAt(0, y), fullPng.pixelAt(Math.floor(width / 2), height - s + y))
    }
    for (let x = 0; x < s; x++) {
      assert.deepEqual(left.pixelAt(x, 0), fullPng.pixelAt(x, Math.floor(height / 2)))
      assert.deepEqual(right.pixelAt(x, 0), fullPng.pixelAt(width - s + x, Math.floor(height / 2)))
    }
  }
})

test('resolveRefractTiles handles sharp corners, lip signed deflection, IOR=1 identity, and tile cap', () => {
  clearRefractTilesCache()

  // Sharp corners (radius=0): outer corner pixel is completely opaque inside sharp edge.
  const sharp = resolveRefractTiles({ radius: 0, bezel: 12 })
  const sharpTl = decodeStoredRgbaPng(sharp.tl)
  assert.equal(sharpTl.pixelAt(0, 0).a, 255)
  assert.deepEqual(sharpTl.pixelAt(11, 11), { r: 128, g: 128, b: 128, a: 255 })

  // Signed 'lip' profile exhibits both positive and negative deflection lobes.
  const lip = resolveRefractTiles({
    radius: 20,
    bezel: 20,
    profile: 'lip',
    ior: 1.5,
    thicknessRatio: 1.5,
  })
  const lipTop = decodeStoredRgbaPng(lip.top)
  let sawAbove = false
  let sawBelow = false
  for (let y = 0; y < lipTop.height; y++) {
    const g = lipTop.pixelAt(0, y).g
    if (g > 128) sawAbove = true
    if (g < 128) sawBelow = true
  }
  assert.ok(sawAbove && sawBelow, 'lip profile produces both >128 and <128 edge deflection')

  // Air IOR=1 yields exact zero displacement and neutral (128,128,128) channels.
  const air = resolveRefractTiles({ radius: 16, bezel: 12, ior: 1 })
  assert.equal(air.maxDisplacementPx, 0)
  const airTop = decodeStoredRgbaPng(air.top)
  for (let y = 0; y < airTop.height; y++) {
    const px = airTop.pixelAt(0, y)
    assert.equal(px.r, 128)
    assert.equal(px.g, 128)
    assert.equal(px.b, 128)
  }

  // Oversized radius/slice caps encoded PNG pixel size at MAX_REFRACT_TILE_PX.
  const huge = resolveRefractTiles({ radius: 220, bezel: 24, slice: 220 })
  assert.equal(huge.slice, 220)
  assert.equal(huge.tilePx, MAX_REFRACT_TILE_PX)
  const hugeTl = decodeStoredRgbaPng(huge.tl)
  assert.equal(hugeTl.width, MAX_REFRACT_TILE_PX)
  assert.equal(hugeTl.height, MAX_REFRACT_TILE_PX)
})

test('resolveRefractTiles caches up to 64 quantized entries LRU and resets via clearRefractTilesCache', () => {
  clearRefractTilesCache()
  const a = resolveRefractTiles({ radius: 20, bezel: 16, profile: 'squircle', ior: 1.5, thicknessRatio: 1.2 })
  const b = resolveRefractTiles({ radius: 20, bezel: 16, profile: 'squircle', ior: 1.5, thicknessRatio: 1.2 })
  assert.equal(a, b, 'identical params hit shared LRU cache reference')

  // Overflow the 64-entry LRU cache by inserting 64 distinct keys so the oldest entry is evicted.
  for (let i = 1; i <= 64; i++) {
    resolveRefractTiles({ radius: 20 + i, bezel: 16, profile: 'squircle', ior: 1.5, thicknessRatio: 1.2 })
  }
  const afterEvict = resolveRefractTiles({
    radius: 20,
    bezel: 16,
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.2,
  })
  assert.notEqual(afterEvict, a, 'entry evicted after >64 distinct entries')
  assert.equal(afterEvict.tl, a.tl)

  clearRefractTilesCache()
  const afterClear = resolveRefractTiles({
    radius: 20,
    bezel: 16,
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.2,
  })
  assert.notEqual(afterClear, afterEvict)
})
