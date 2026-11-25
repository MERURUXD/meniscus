/**
 * Unit tests for the headless Route B3 SVG refraction filter controller.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { resolveRefractionProfileLut, type GlassFieldState } from '@sessile/core'
import {
  DEFAULT_MAX_REFRACT_MAP_PIXELS,
  SVG_NS,
  computeAutoBezel,
  createRefractFilterController,
  resolveEffectiveMapScale,
  resolveFieldBezel,
} from '../src/refractFilter.ts'
import { MockDocument, type MockElement } from './mockDom.ts'

function decodePngDimensions(dataUrl: string): { width: number; height: number } {
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Expected PNG data URL')
  const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  // PNG IHDR starts at byte 8 (4 len + 4 'IHDR' + 4 width BE + 4 height BE).
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

function decodeStoredRgbaPng(dataUrl: string): {
  width: number
  height: number
  pixelAt: (px: number, py: number) => { r: number; g: number; b: number; a: number }
} {
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Expected PNG data URL')
  const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  let offset = 8
  let width = 0
  let height = 0
  const idatParts: Buffer[] = []
  while (offset < bytes.length) {
    const len = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = 1 + width * 4
  return {
    width,
    height,
    pixelAt: (px, py) => {
      const idx = py * stride + 1 + px * 4
      return { r: raw[idx]!, g: raw[idx + 1]!, b: raw[idx + 2]!, a: raw[idx + 3]! }
    },
  }
}

test('computeAutoBezel and resolveFieldBezel handle N=0, N=1, N=2, and N>=3 fields', () => {
  assert.equal(computeAutoBezel(10, 10), 6)
  assert.equal(computeAutoBezel(50, 100), 15)
  assert.equal(computeAutoBezel(300, 200), 22)

  const emptyField: GlassFieldState = { primitives: [], blendK: 10 }
  assert.equal(resolveFieldBezel(0, emptyField), 6)
  assert.equal(resolveFieldBezel(18, emptyField), 18)

  const twoPrimitives: GlassFieldState = {
    blendK: 20,
    primitives: [
      { center: { x: 100, y: 100 }, size: { width: 180, height: 120 }, radius: 20 },
      { center: { x: 40, y: 40 }, size: { width: 40, height: 24 }, radius: 12 },
    ],
  }
  assert.equal(resolveFieldBezel(0, twoPrimitives), 22)
  assert.equal(resolveFieldBezel(16, twoPrimitives), 16)
  assert.equal(resolveFieldBezel(90, twoPrimitives), 60)

  const threePrimitives: GlassFieldState = {
    blendK: 18,
    primitives: [
      { center: { x: 20, y: 20 }, size: { width: 30, height: 20 }, radius: 10 },
      { center: { x: 60, y: 20 }, size: { width: 40, height: 30 }, radius: 12 },
      { center: { x: 100, y: 20 }, size: { width: 50, height: 60 }, radius: 15 },
    ],
  }
  // Max width = 50, max height = 60 -> min * 0.3 = 15.
  assert.equal(resolveFieldBezel(0, threePrimitives), 15)
})

test('createRefractFilterController constructs Route B3 graph and switches dispersion dynamically', () => {
  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-test-filter',
    document: doc as unknown as Document,
    bezel: 20,
    strength: 1.5,
    dispersion: 0,
  })

  assert.equal(controller.mounted, false)
  assert.equal(controller.mount(doc.body as unknown as Element), true)
  assert.equal(controller.mounted, true)

  const svg = controller.svgElement as unknown as MockElement
  assert.ok(svg)
  assert.equal(svg.namespaceURI, SVG_NS)

  const filterEl = svg.querySelectorAll('filter')[0]!
  assert.equal(filterEl.getAttribute('id'), 'sessile-test-filter')
  assert.equal(filterEl.getAttribute('color-interpolation-filters'), 'sRGB')
  assert.equal(filterEl.querySelectorAll('feDisplacementMap').length, 1)
  assert.equal(filterEl.querySelectorAll('feComponentTransfer').length, 0)

  const compositeIn = filterEl.querySelectorAll('feComposite').find(
    (node) => node.getAttribute('operator') === 'in',
  )
  assert.ok(compositeIn)
  assert.equal(compositeIn.getAttribute('in2'), 'map')

  const mergeNodes = filterEl.querySelectorAll('feMergeNode')
  assert.deepEqual(
    mergeNodes.map((n) => n.getAttribute('in')),
    ['SourceGraphic', 'glassOnly'],
  )

  const field: GlassFieldState = {
    blendK: 16,
    primitives: [
      { center: { x: 100, y: 60 }, size: { width: 160, height: 80 }, radius: 24 },
    ],
  }

  // Switch to dispersive (R/G/B separated channels) via updateFrame.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    field,
    blurSigma: 8,
    saturate: 1.8,
    brightness: 1.05,
    contrast: 0.95,
    dispersion: 6,
  })

  assert.equal(filterEl.querySelectorAll('feComponentTransfer').length, 3)
  const dispMaps = filterEl.querySelectorAll('feDisplacementMap')
  assert.equal(dispMaps.length, 3)
  const expectedLut = resolveRefractionProfileLut({
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.5,
  })
  const expectedBaseScale = 2 * 20 * expectedLut.maxDisplacementRatio
  const expectedDispersion = Math.min(6, expectedBaseScale * 0.5)
  const scales = dispMaps.map((d) => Number(d.getAttribute('scale')))
  assert.ok(Math.abs(scales[0]! - Math.max(0, expectedBaseScale - expectedDispersion)) < 1e-6)
  assert.ok(Math.abs(scales[1]! - expectedBaseScale) < 1e-6)
  assert.ok(Math.abs(scales[2]! - (expectedBaseScale + expectedDispersion)) < 1e-6)

  // Switch back to non-dispersive mode; old nodes must be removed without leaking duplicates.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    field,
    blurSigma: 8,
    saturate: 1.8,
    brightness: 1.05,
    contrast: 0.95,
    dispersion: 0,
  })
  assert.equal(filterEl.querySelectorAll('feComponentTransfer').length, 0)
  assert.equal(filterEl.querySelectorAll('feDisplacementMap').length, 1)
  assert.ok(
    Math.abs(
      Number(filterEl.querySelectorAll('feDisplacementMap')[0]!.getAttribute('scale')) -
        expectedBaseScale,
    ) < 1e-6,
  )

  controller.dispose()
  assert.equal(controller.mounted, false)
  assert.equal(controller.svgElement, null)
  assert.equal(doc.body.childNodes.length, 0)
  // Post-dispose updates are safe no-ops.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    field,
    blurSigma: 0,
    saturate: 1,
    brightness: 1,
    contrast: 1,
  })
})

test('createRefractFilterController promotes <= 128px maps to 1:1 and skips duplicate attribute writes', () => {
  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-cache-test',
    document: doc as unknown as Document,
    bezel: 12,
    strength: 1.2,
    mapScale: 0.5,
    nineSlice: false,
  })
  controller.mount(doc.body as unknown as Element)

  const svg = controller.svgElement as unknown as MockElement
  const feImage = svg.querySelectorAll('feImage')[0]!
  const bgBlur = svg.querySelectorAll('feGaussianBlur').find(
    (node) => node.getAttribute('result') === 'bgBlur',
  )!
  const colorMatrix = svg.querySelectorAll('feColorMatrix')[0]!
  const dispMap = svg.querySelectorAll('feDisplacementMap')[0]!

  const smallField: GlassFieldState = {
    blendK: 8,
    primitives: [{ center: { x: 50, y: 20 }, size: { width: 84, height: 32 }, radius: 16 }],
  }

  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    field: smallField,
    blurSigma: 4,
    saturate: 1.5,
    brightness: 1.1,
    contrast: 1.0,
  })

  // <= 128px promotes mapScale 0.5 -> 1.0 (full PNG resolution).
  const smallPng = decodePngDimensions(feImage.getAttribute('href') ?? '')
  assert.deepEqual(smallPng, { width: 100, height: 40 })
  assert.equal(feImage.getAttribute('width'), '100')
  assert.equal(feImage.getAttribute('height'), '40')

  const writesAfterFirst = {
    feImage: feImage.setAttributeCalls.length,
    bgBlur: bgBlur.setAttributeCalls.length,
    colorMatrix: colorMatrix.setAttributeCalls.length,
    dispMap: dispMap.setAttributeCalls.length,
  }

  // Identical second frame must trigger zero DOM setAttribute calls.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    field: smallField,
    blurSigma: 4,
    saturate: 1.5,
    brightness: 1.1,
    contrast: 1.0,
  })
  assert.equal(feImage.setAttributeCalls.length, writesAfterFirst.feImage)
  assert.equal(bgBlur.setAttributeCalls.length, writesAfterFirst.bgBlur)
  assert.equal(colorMatrix.setAttributeCalls.length, writesAfterFirst.colorMatrix)
  assert.equal(dispMap.setAttributeCalls.length, writesAfterFirst.dispMap)

  // Large bounds (> 128px) stay at 0.5x PNG resolution while logical CSS feImage size stays 1x.
  const largeField: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 100, y: 80 }, size: { width: 180, height: 140 }, radius: 24 }],
  }
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 160 },
    field: largeField,
    blurSigma: 4,
    saturate: 1.5,
    brightness: 1.1,
    contrast: 1.0,
  })
  const largePng = decodePngDimensions(feImage.getAttribute('href') ?? '')
  assert.deepEqual(largePng, { width: 100, height: 80 })
  assert.equal(feImage.getAttribute('width'), '200')
  assert.equal(feImage.getAttribute('height'), '160')

  controller.dispose()
})

test('createRefractFilterController calibrates scale from Snell profile and suppresses phantom dispersion at zero strength', () => {
  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-snell-test',
    document: doc as unknown as Document,
    bezel: 20,
    strength: 1.35,
    dispersion: 2.0,
    profile: 'squircle',
    ior: 1.5,
  })
  controller.mount(doc.body as unknown as Element)

  const svg = controller.svgElement as unknown as MockElement
  const filterEl = svg.querySelectorAll('filter')[0]!
  const field: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 100, y: 60 }, size: { width: 160, height: 80 }, radius: 24 }],
  }

  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    field,
    blurSigma: 2,
    saturate: 1.5,
    brightness: 1,
    contrast: 1,
  })

  const scales = filterEl
    .querySelectorAll('feDisplacementMap')
    .map((node) => Number(node.getAttribute('scale')))
  assert.equal(scales.length, 3)
  assert.ok(scales[1]! > 0 && scales[1]! < 2 * 20 * 1.35, `expected Snell calibrated scale in (0, 54), got ${scales[1]}`)
  assert.ok(Math.abs(scales[1]! - scales[0]! - 2) < 1e-4)
  assert.ok(Math.abs(scales[2]! - scales[1]! - 2) < 1e-4)

  // Raising IOR increases Snell displacement scale.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    field,
    blurSigma: 2,
    saturate: 1.5,
    brightness: 1,
    contrast: 1,
    ior: 2.0,
  })
  const higherIorScale = Number(filterEl.querySelectorAll('feDisplacementMap')[1]!.getAttribute('scale'))
  assert.ok(higherIorScale > scales[1]!, `expected higher IOR scale > ${scales[1]}, got ${higherIorScale}`)

  // When strength=0 (baseScale=0), dispersion must clamp to 0 so RGB channels do not drift asymmetrically.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    field,
    blurSigma: 2,
    saturate: 1.5,
    brightness: 1,
    contrast: 1,
    strength: 0,
    dispersion: 3.0,
  })
  const zeroScales = filterEl
    .querySelectorAll('feDisplacementMap')
    .map((node) => Number(node.getAttribute('scale')))
  assert.deepEqual(zeroScales, [0, 0, 0])

  controller.dispose()
})

test('createRefractFilterController uses nine-slice fast path on N=1 cards, skips href rewrites on resize, and falls back cleanly', () => {
  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-nineslice-test',
    document: doc as unknown as Document,
    bezel: 20,
    strength: 1.32,
  })
  controller.mount(doc.body as unknown as Element)

  const svg = controller.svgElement as unknown as MockElement
  const filterEl = svg.querySelectorAll('filter')[0]!

  const card160: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 100, y: 60 }, size: { width: 160, height: 80 }, radius: 24 }],
  }
  controller.updateFrame({
    bounds: { x: 10, y: 10, width: 180, height: 100 },
    field: card160,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })

  const floods = filterEl.querySelectorAll('feFlood')
  assert.equal(floods.length, 1)
  assert.equal(floods[0]!.getAttribute('result'), 'ns-center')
  const tiles = filterEl.querySelectorAll('feImage')
  assert.equal(tiles.length, 8)
  const mapMerge = filterEl.querySelectorAll('feMerge').find((n) => n.getAttribute('result') === 'map')
  assert.ok(mapMerge)
  assert.deepEqual(
    mapMerge.querySelectorAll('feMergeNode').map((n) => n.getAttribute('in')),
    ['ns-center', 'ns-top', 'ns-bottom', 'ns-left', 'ns-right', 'ns-tl', 'ns-tr', 'ns-bl', 'ns-br'],
  )

  const hrefCountAfterFirst = tiles.map(
    (tile) => tile.setAttributeCalls.filter((c) => c.name === 'href').length,
  )

  // Resizing card width & height with identical corner radius & bezel must not rewrite tile hrefs.
  const card420: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 230, y: 130 }, size: { width: 420, height: 220 }, radius: 24 }],
  }
  controller.updateFrame({
    bounds: { x: 10, y: 10, width: 440, height: 240 },
    field: card420,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })

  assert.deepEqual(
    tiles.map((tile) => tile.setAttributeCalls.filter((c) => c.name === 'href').length),
    hrefCountAfterFirst,
    'resizing card must not trigger href attribute writes on any 9-slice tile',
  )
  assert.equal(floods[0]!.getAttribute('width'), '374')
  assert.equal(floods[0]!.getAttribute('height'), '174')

  const totalWritesBeforeRepeat = [
    ...filterEl.querySelectorAll('feFlood'),
    ...filterEl.querySelectorAll('feImage'),
    ...filterEl.querySelectorAll('feGaussianBlur'),
    ...filterEl.querySelectorAll('feColorMatrix'),
    ...filterEl.querySelectorAll('feDisplacementMap'),
  ].map((node) => node.setAttributeCalls.length)

  // Identical repeated frame must perform zero DOM setAttribute writes.
  controller.updateFrame({
    bounds: { x: 10, y: 10, width: 440, height: 240 },
    field: card420,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })

  const totalWritesAfterRepeat = [
    ...filterEl.querySelectorAll('feFlood'),
    ...filterEl.querySelectorAll('feImage'),
    ...filterEl.querySelectorAll('feGaussianBlur'),
    ...filterEl.querySelectorAll('feColorMatrix'),
    ...filterEl.querySelectorAll('feDisplacementMap'),
  ].map((node) => node.setAttributeCalls.length)
  assert.deepEqual(totalWritesAfterRepeat, totalWritesBeforeRepeat)

  const pieceByResult = (result: string): MockElement =>
    [...filterEl.querySelectorAll('feFlood'), ...filterEl.querySelectorAll('feImage')].find(
      (n) => n.getAttribute('result') === result,
    )!
  const rectOf = (result: string): string[] => {
    const n = pieceByResult(result)
    return ['x', 'y', 'width', 'height'].map((k) => n.getAttribute(k)!)
  }
  const assertFullNineSlice = (): void => {
    assert.equal(filterEl.querySelectorAll('feFlood').length, 1)
    assert.equal(filterEl.querySelectorAll('feImage').length, 8)
    assert.deepEqual(
      filterEl
        .querySelectorAll('feMerge')
        .find((n) => n.getAttribute('result') === 'map')!
        .querySelectorAll('feMergeNode')
        .map((n) => n.getAttribute('in')),
      ['ns-center', 'ns-top', 'ns-bottom', 'ns-left', 'ns-right', 'ns-tl', 'ns-tr', 'ns-bl', 'ns-br'],
    )
  }

  // Horizontal capsule (`rise == 0`): the top/bottom strip joint and the left/right cap joints
  // must be underlaid by a `2 * pad` center row and vertical strips, never left abutting.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 412, height: 56 },
    field: {
      blendK: 16,
      primitives: [{ center: { x: 206, y: 28 }, size: { width: 400, height: 44 }, radius: 22 }],
    },
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assertFullNineSlice()
  assert.deepEqual(rectOf('ns-center'), ['27', '27', '358', '2'])
  assert.deepEqual(rectOf('ns-left'), ['6', '27', '22', '2'])
  assert.deepEqual(rectOf('ns-right'), ['384', '27', '22', '2'])

  // Subpixel-positioned capsules stay on the nine-slice path: seams no longer depend on alignment.
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 412, height: 56 },
    field: {
      blendK: 16,
      primitives: [{ center: { x: 206, y: 28.25 }, size: { width: 400, height: 44 }, radius: 22 }],
    },
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assertFullNineSlice()
  assert.deepEqual(rectOf('ns-center'), ['27', '27.250', '358', '2'])

  // Circle (`span == rise == 0`): the four corners meet at the center, so all four quadrant
  // joints are underlaid by `2 * pad` strips and a center patch (the old cross-seam regression).
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 60, height: 60 },
    field: {
      blendK: 16,
      primitives: [{ center: { x: 30, y: 30 }, size: { width: 44, height: 44 }, radius: 22 }],
    },
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assertFullNineSlice()
  assert.deepEqual(rectOf('ns-center'), ['29', '29', '2', '2'])
  assert.deepEqual(rectOf('ns-top'), ['29', '8', '2', '22'])
  assert.deepEqual(rectOf('ns-bottom'), ['29', '30', '2', '22'])
  assert.deepEqual(rectOf('ns-left'), ['8', '29', '22', '2'])
  assert.deepEqual(rectOf('ns-right'), ['30', '29', '22', '2'])
  assert.deepEqual(rectOf('ns-tl'), ['8', '8', '22', '22'])
  assert.deepEqual(rectOf('ns-br'), ['30', '30', '22', '22'])

  // Return to N=1 nine-slice, then switch N=1 -> N=2 -> N=1 without leaking nodes or shifting scale.
  controller.updateFrame({
    bounds: { x: 10, y: 10, width: 180, height: 100 },
    field: card160,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assert.equal(filterEl.querySelectorAll('feImage').length, 8)
  const expectedLut = resolveRefractionProfileLut({
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.32,
  })
  const expectedScale = 2 * 20 * expectedLut.maxDisplacementRatio
  const nineSliceScale = Number(filterEl.querySelectorAll('feDisplacementMap')[0]!.getAttribute('scale'))
  assert.ok(Math.abs(nineSliceScale - expectedScale) < 1e-6)

  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 240, height: 120 },
    field: {
      blendK: 16,
      primitives: [
        { center: { x: 80, y: 60 }, size: { width: 120, height: 80 }, radius: 24 },
        { center: { x: 160, y: 60 }, size: { width: 80, height: 80 }, radius: 24 },
      ],
    },
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assert.equal(filterEl.querySelectorAll('feFlood').length, 0)
  assert.equal(filterEl.querySelectorAll('feImage').length, 1)

  controller.updateFrame({
    bounds: { x: 10, y: 10, width: 180, height: 100 },
    field: card160,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  assert.equal(filterEl.querySelectorAll('feFlood').length, 1)
  assert.equal(filterEl.querySelectorAll('feImage').length, 8)
  assert.equal(filterEl.querySelectorAll('feMerge').length, 2)

  controller.dispose()
})

test('resolveEffectiveMapScale promotes compact controls and caps large full-map PNG pixel budgets', () => {
  assert.equal(resolveEffectiveMapScale(100, 40, 0.5), 1)
  assert.equal(resolveEffectiveMapScale(400, 240, 0.5), 0.5)

  const cappedScale = resolveEffectiveMapScale(1200, 800, 0.5)
  assert.ok(cappedScale > 0.05 && cappedScale < 0.5)
  const pngW = Math.round(1200 * cappedScale)
  const pngH = Math.round(800 * cappedScale)
  assert.ok(pngW * pngH <= DEFAULT_MAX_REFRACT_MAP_PIXELS, `expected <= 96k px, got ${pngW * pngH}`)

  assert.equal(resolveEffectiveMapScale(1200, 800, 0.5, 0), 0.5)

  // Budget cap must reduce scale below 0.05 without ever inflating small requested scales.
  const tinyRequestedScale = resolveEffectiveMapScale(4000, 4000, 0.01, 1000)
  assert.ok(tinyRequestedScale > 0 && tinyRequestedScale <= 0.01)
  assert.ok(
    Math.max(1, Math.round(4000 * tinyRequestedScale)) *
      Math.max(1, Math.round(4000 * tinyRequestedScale)) <=
      1000,
  )

  const hugeDefaultScale = resolveEffectiveMapScale(8000, 8000, 0.5)
  assert.ok(hugeDefaultScale > 0 && hugeDefaultScale < 0.05)
  assert.ok(
    Math.max(1, Math.round(8000 * hugeDefaultScale)) *
      Math.max(1, Math.round(8000 * hugeDefaultScale)) <=
      DEFAULT_MAX_REFRACT_MAP_PIXELS,
  )

  // Thin bounds with small budget clamp to final 1px-floored encoded PNG area without exceeding budget.
  const thinScale = resolveEffectiveMapScale(1200, 2, 0.5, 100)
  assert.ok(thinScale > 0 && thinScale <= 0.5)
  assert.ok(
    Math.max(1, Math.round(1200 * thinScale)) * Math.max(1, Math.round(2 * thinScale)) <= 100,
  )

  const unitBudgetScale = resolveEffectiveMapScale(1200, 2, 0.5, 1)
  assert.ok(unitBudgetScale > 0)
  assert.equal(Math.max(1, Math.round(1200 * unitBudgetScale)), 1)
  assert.equal(Math.max(1, Math.round(2 * unitBudgetScale)), 1)

  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-budget-test',
    document: doc as unknown as Document,
    bezel: 20,
    strength: 1.32,
  })
  controller.mount(doc.body as unknown as Element)

  const svg = controller.svgElement as unknown as MockElement
  const largeDualField: GlassFieldState = {
    blendK: 20,
    primitives: [
      { center: { x: 400, y: 400 }, size: { width: 500, height: 600 }, radius: 28 },
      { center: { x: 800, y: 400 }, size: { width: 500, height: 600 }, radius: 28 },
    ],
  }

  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    field: largeDualField,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
  })
  const feImage = svg.querySelectorAll('feImage')[0]!
  assert.equal(feImage.getAttribute('width'), '1200')
  assert.equal(feImage.getAttribute('height'), '800')
  const cappedDims = decodePngDimensions(feImage.getAttribute('href') ?? '')
  assert.ok(
    cappedDims.width * cappedDims.height <= DEFAULT_MAX_REFRACT_MAP_PIXELS,
    `expected capped PNG <= ${DEFAULT_MAX_REFRACT_MAP_PIXELS}, got ${cappedDims.width}x${cappedDims.height}`,
  )

  // maxMapPixels: 0 disables area capping and encodes full 0.5x (600x400).
  controller.updateFrame({
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    field: largeDualField,
    blurSigma: 6,
    saturate: 1.4,
    brightness: 1.0,
    contrast: 1.0,
    maxMapPixels: 0,
  })
  const uncappedDims = decodePngDimensions(feImage.getAttribute('href') ?? '')
  assert.deepEqual(uncappedDims, { width: 600, height: 400 })

  controller.dispose()
})

test('resolveEffectiveMapScale and full-map feImage stay world-locked over stationary shapes when another droplet moves', () => {
  // Discrete reciprocal-integer plateaus remain identical as drag bounds expand slightly.
  assert.equal(resolveEffectiveMapScale(700, 600, 0.5), 1 / 3)
  assert.equal(resolveEffectiveMapScale(741, 619, 0.5), 1 / 3)
  assert.equal(resolveEffectiveMapScale(1100, 800, 0.5), 0.25)

  const doc = new MockDocument()
  const controller = createRefractFilterController({
    id: 'sessile-world-lock-test',
    document: doc as unknown as Document,
    bezel: 18,
    strength: 1.32,
  })
  controller.mount(doc.body as unknown as Element)
  const svg = controller.svgElement as unknown as MockElement
  const feImage = svg.querySelectorAll('feImage')[0]!

  const stationaryAnchor = { center: { x: 400, y: 200 }, size: { width: 164, height: 58 }, radius: 29 }

  const snapshotStationaryRegion = (
    bounds: { x: number; y: number; width: number; height: number },
    moverX: number,
  ) => {
    controller.updateFrame({
      bounds,
      field: {
        blendK: 32,
        primitives: [
          stationaryAnchor,
          { center: { x: moverX, y: 420 }, size: { width: 90, height: 90 }, radius: 45 },
        ],
      },
      blurSigma: 2,
      saturate: 1.4,
      brightness: 1.0,
      contrast: 1.0,
    })
    const png = decodeStoredRgbaPng(feImage.getAttribute('href') ?? '')
    const feX = Number(feImage.getAttribute('x') ?? '0')
    const feY = Number(feImage.getAttribute('y') ?? '0')
    const feW = Number(feImage.getAttribute('width') ?? String(bounds.width))
    const feH = Number(feImage.getAttribute('height') ?? String(bounds.height))
    const stepX = feW / png.width
    const stepY = feH / png.height
    const originX = bounds.x + feX + 0.5 * stepX
    const originY = bounds.y + feY + 0.5 * stepY

    // Collect pixels whose world centers fall inside a 10px border around the stationary anchor.
    const samples: Array<{ wx: number; wy: number; rgba: { r: number; g: number; b: number; a: number } }> = []
    for (let py = 0; py < png.height; py++) {
      const wy = originY + py * stepY
      if (wy < 160 || wy > 240) continue
      for (let px = 0; px < png.width; px++) {
        const wx = originX + px * stepX
        if (wx < 308 || wx > 492) continue
        samples.push({ wx, wy, rgba: png.pixelAt(px, py) })
      }
    }
    return { stepX, stepY, samples }
  }

  // 0.5x regime: shifting left/width by 1px and 7px must not flip texel phase or alter pixels on anchor.
  const baseHalf = snapshotStationaryRegion({ x: 100, y: 120, width: 420, height: 380 }, 160)
  const odd1Half = snapshotStationaryRegion({ x: 99, y: 119, width: 421, height: 381 }, 159)
  const odd7Half = snapshotStationaryRegion({ x: 93, y: 120, width: 427, height: 380 }, 153)
  assert.equal(baseHalf.stepX, 2)
  assert.equal(odd1Half.stepX, 2)
  assert.equal(odd7Half.stepX, 2)
  assert.deepEqual(odd1Half.samples, baseHalf.samples)
  assert.deepEqual(odd7Half.samples, baseHalf.samples)

  // Budget-capped regime (> 96k px at 0.5x): expanding drag bounds stays on integer pitch 3 (`1/3`x).
  const baseCap = snapshotStationaryRegion({ x: 60, y: 120, width: 700, height: 600 }, 120)
  const grownCap = snapshotStationaryRegion({ x: 55, y: 120, width: 741, height: 617 }, 115)
  assert.equal(baseCap.stepX, 3)
  assert.equal(grownCap.stepX, 3)
  assert.deepEqual(grownCap.samples, baseCap.samples)

  controller.dispose()
})
