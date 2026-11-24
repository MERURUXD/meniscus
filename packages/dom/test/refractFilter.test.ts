/**
 * Unit tests for the headless Route B3 SVG refraction filter controller.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
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

  // Integer-aligned horizontal capsule omits center/left/right and uses 6 pieces.
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
  assert.equal(filterEl.querySelectorAll('feFlood').length, 0)
  assert.equal(filterEl.querySelectorAll('feImage').length, 6)
  assert.deepEqual(
    filterEl
      .querySelectorAll('feMerge')
      .find((n) => n.getAttribute('result') === 'map')!
      .querySelectorAll('feMergeNode')
      .map((n) => n.getAttribute('in')),
    ['ns-top', 'ns-bottom', 'ns-tl', 'ns-tr', 'ns-bl', 'ns-br'],
  )

  // Subpixel-positioned capsule falls back to full-map Stored-PNG to prevent Skia seam artifacts.
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
  assert.equal(filterEl.querySelectorAll('feFlood').length, 0)
  assert.equal(filterEl.querySelectorAll('feImage').length, 1)
  assert.equal(filterEl.querySelectorAll('feImage')[0]!.getAttribute('result'), 'map')

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
