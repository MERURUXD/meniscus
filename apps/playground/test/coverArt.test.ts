import assert from 'node:assert/strict'
import test from 'node:test'
import { TELEMETRY_STRIDE, measureTelemetryGrid, type BackdropTelemetry } from '@sessile/core'
import { COVER_SIZE, createCoverSpecs, paintCover } from '../src/components/coverArt.ts'

const WALL_SEED = 0x5e551e
const COVER_COUNT = 42

function measureCells(pixels: Uint8ClampedArray): BackdropTelemetry[] {
  const grid = measureTelemetryGrid(pixels, COVER_SIZE.width, COVER_SIZE.height, 4, 6)
  const cells: BackdropTelemetry[] = []
  for (let i = 0; i < grid.cols * grid.rows; i++) {
    const o = i * TELEMETRY_STRIDE
    cells.push({
      lumaHigh: grid.data[o]!,
      lumaLow: grid.data[o + 1]!,
      chroma: grid.data[o + 2]!,
      detail: grid.data[o + 3]!,
    })
  }
  return cells
}

test('the same seed paints a byte-identical wall and another seed paints a different one', () => {
  const a = createCoverSpecs(COVER_COUNT, WALL_SEED)
  const b = createCoverSpecs(COVER_COUNT, WALL_SEED)
  assert.deepEqual(a, b)
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(paintCover(a[i]!), paintCover(b[i]!), `cover ${i} must repaint identically`)
  }

  const other = createCoverSpecs(COVER_COUNT, WALL_SEED + 1)
  const differs = other.some((spec, i) => {
    const x = paintCover(spec)
    const y = paintCover(a[i]!)
    return x.some((v, j) => v !== y[j])
  })
  assert.ok(differs, 'a different seed must change the artwork')
})

test('every cover is fully opaque at the declared portrait size', () => {
  for (const spec of createCoverSpecs(8, WALL_SEED)) {
    const pixels = paintCover(spec)
    assert.equal(pixels.length, COVER_SIZE.width * COVER_SIZE.height * 4)
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) assert.fail(`${spec.id} has a transparent pixel at ${(i - 3) / 4}`)
    }
  }
})

test('the wall is a worst-case backdrop: near-white, near-black, saturated and busy cells', () => {
  const specs = createCoverSpecs(COVER_COUNT, WALL_SEED)
  const all: BackdropTelemetry[] = []
  for (const spec of specs) {
    const cells = measureCells(paintCover(spec))
    all.push(...cells)
    // A single cover must already span the whole range, so no scroll position is a calm one.
    const brightest = Math.max(...cells.map((c) => c.lumaHigh))
    const darkest = Math.min(...cells.map((c) => c.lumaLow))
    assert.ok(brightest > 0.9, `${spec.id} needs a near-white region (got ${brightest})`)
    assert.ok(darkest < 0.1, `${spec.id} needs a near-black region (got ${darkest})`)
  }

  const share = (predicate: (c: BackdropTelemetry) => boolean) =>
    all.filter(predicate).length / all.length
  assert.ok(share((c) => c.lumaHigh > 0.9) > 0.25, 'bright highlights must be common')
  assert.ok(share((c) => c.lumaLow < 0.1) > 0.25, 'deep shadows must be common')
  assert.ok(share((c) => c.chroma > 0.6) > 0.2, 'large flat saturated blocks must be common')
  assert.ok(share((c) => c.detail > 0.5) > 0.1, 'dense lettering must register as detail')
  assert.ok(
    share((c) => c.lumaHigh > 0.9 && c.lumaLow < 0.1) > 0.1,
    'hard black/white splits must occur inside single cells',
  )
})
