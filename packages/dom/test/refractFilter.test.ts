/**
 * Unit tests for the headless Route B3 SVG refraction filter controller.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlassFieldState } from '@meniscus/core'
import {
  SVG_NS,
  computeAutoBezel,
  createRefractFilterController,
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
    id: 'meniscus-test-filter',
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
  assert.equal(filterEl.getAttribute('id'), 'meniscus-test-filter')
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
  // baseScale = 2 * 20 * 1.5 = 60 -> scales [54, 60, 66]
  assert.deepEqual(
    dispMaps.map((d) => Number(d.getAttribute('scale'))),
    [54, 60, 66],
  )

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
  assert.equal(Number(filterEl.querySelectorAll('feDisplacementMap')[0]!.getAttribute('scale')), 60)

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
    id: 'meniscus-cache-test',
    document: doc as unknown as Document,
    bezel: 12,
    strength: 1.2,
    mapScale: 0.5,
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
