/**
 * `backdropTarget: 'container'`: the container samples the backdrop and carries the veil itself,
 * so its own opacity animations cannot cut a child backdrop layer off from the page.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_OPTICAL_MATERIALS, type GlassFieldState, type IGlassOverlayRenderer } from '@sessile/core'
import { createRefractFilterController } from '../src/refractFilter.ts'
import { GlassSurfaceController } from '../src/surfaceController.ts'
import { MockDocument, type MockElement } from './mockDom.ts'

const CHROME_ENV = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  cssSupports: () => true,
}

const SAFARI_ENV = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  cssSupports: () => true,
}

const WIDTH = 200
const HEIGHT = 60
const BORDER = 1

function overlaySpy() {
  const viewports: { width: number; height: number }[] = []
  const renderer: IGlassOverlayRenderer = {
    capabilities: { webgl2: false, floatFbo: false, maxTextureSize: 0 },
    mount: () => renderer.capabilities,
    render: (frame) => {
      viewports.push({ ...frame.viewport })
    },
    clear: () => {},
    dispose: () => {},
  }
  return { renderer, viewports }
}

const LENS = { bezel: 18, strength: 1.3, dispersion: 4, scaleMultiplier: 2.7, profile: 'squircle', ior: 1.5 } as const

function setup(env: typeof CHROME_ENV, legible = false) {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  const content = doc.createElement('span') as unknown as MockElement
  container.appendChild(content)
  doc.body.appendChild(container)
  container.setBoundingClientRect({ x: 10, y: 20, width: WIDTH, height: HEIGHT })
  container.clientLeft = BORDER
  container.clientTop = BORDER
  container.style.background = 'red'
  const spy = overlaySpy()
  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env,
    theme: 'dark',
    mode: 'refract',
    filterId: 'host-lens',
    backdropTarget: 'container',
    overlayRenderer: spy.renderer,
    legibility: legible ? { foreground: [1, 1, 1], tier: 'legible' } : null,
  })
  // Border box in padding-box coordinates, the frame a resting single-rect host renders.
  const box = { x: -BORDER, y: -BORDER, width: WIDTH, height: HEIGHT }
  const field: GlassFieldState = {
    blendK: 0,
    primitives: [{ center: { x: box.x + WIDTH / 2, y: box.y + HEIGHT / 2 }, size: { width: WIDTH, height: HEIGHT }, radius: 30 }],
  }
  const material = DEFAULT_OPTICAL_MATERIALS.dark.frosted
  const render = () => controller.render({ field, bounds: box, material, refraction: LENS })
  return { doc, container, content, controller, spy, render }
}

function lensSignature(filter: MockElement) {
  return {
    tiles: filter.querySelectorAll('feImage').map((n) => n.getAttribute('href')),
    scales: filter.querySelectorAll('feDisplacementMap').map((n) => n.getAttribute('scale')),
  }
}

test('container mode creates only the overlay canvas and keeps content order', () => {
  const { container, content, controller } = setup(CHROME_ENV)
  const elements = controller.getElements()
  assert.equal(elements.refractBackdrop, null)
  assert.equal(elements.veil, null)
  assert.deepEqual(container.childNodes, [content, elements.overlayCanvas as unknown as MockElement])
  controller.dispose()
  assert.deepEqual(container.childNodes, [content])
})

test('Chromium refraction runs on the container over its own border box', () => {
  const { doc, container, controller, spy, render } = setup(CHROME_ENV)
  render()
  assert.equal(container.style.backdropFilter, 'url(#host-lens)')
  assert.equal(container.style.getPropertyValue('-webkit-backdrop-filter'), 'url(#host-lens)')
  assert.match(container.style.background, /^rgba\(/)
  const filter = doc.body.querySelectorAll('filter')[0]!
  assert.equal(filter.getAttribute('id'), 'host-lens')
  // The displacement map tiles span exactly the container's border box.
  const edge = (a: string, b: string) =>
    Math.max(...filter.querySelectorAll('feImage').map((n) => Number(n.getAttribute(a)) + Number(n.getAttribute(b))))
  assert.equal(edge('x', 'width'), WIDTH)
  assert.equal(edge('y', 'height'), HEIGHT)
  assert.deepEqual(spy.viewports.at(-1), { width: WIDTH, height: HEIGHT })
  controller.dispose()
})

test('a resting container encodes the same lens as a morphing refract filter', () => {
  // Static and morphing glass must not differ in displacement map or amplitude, or the
  // hand-off at the end of a morph visibly pops.
  const { doc, controller, render } = setup(CHROME_ENV)
  render()
  const resting = lensSignature(doc.body.querySelectorAll('filter')[0]!)

  const morphDoc = new MockDocument()
  const morph = createRefractFilterController({ id: 'morph', document: morphDoc as unknown as Document, ...LENS })
  morph.mount()
  morph.updateFrame({
    bounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    field: { blendK: 0, primitives: [{ center: { x: WIDTH / 2, y: HEIGHT / 2 }, size: { width: WIDTH, height: HEIGHT }, radius: 30 }] },
    blurSigma: 2,
    saturate: 1.6,
    brightness: 1,
    contrast: 1,
  })
  const morphing = lensSignature(morphDoc.body.querySelectorAll('filter')[0]!)

  assert.ok(resting.tiles.length > 0)
  assert.deepEqual(resting.tiles, morphing.tiles)
  assert.deepEqual(resting.scales, morphing.scales)
  morph.dispose()
  controller.dispose()
})

test('frosted fallback writes blur and tint to the container', () => {
  const { doc, container, controller, render } = setup(SAFARI_ENV)
  render()
  assert.match(container.style.backdropFilter, /^blur\(/)
  assert.match(container.style.background, /^rgba\(/)
  assert.equal(doc.body.querySelectorAll('svg').length, 0)
  controller.dispose()
})

test('legibility correction and film land on the container', () => {
  // The first real sample snaps, so each backdrop gets its own surface.
  const paint = (telemetry: { lumaHigh: number; lumaLow: number; chroma: number; detail: number }) => {
    const { container, controller, render } = setup(SAFARI_ENV, true)
    controller.setBackdropTelemetry(telemetry)
    render()
    const out = { filter: container.style.backdropFilter, tint: container.style.background }
    controller.dispose()
    return out
  }
  const calm = paint({ lumaHigh: 0.1, lumaLow: 0.05, chroma: 0, detail: 0 })
  const bright = paint({ lumaHigh: 1, lumaLow: 0.9, chroma: 0, detail: 0.3 })
  assert.doesNotMatch(calm.filter, /brightness\(/)
  assert.match(bright.filter, /brightness\(/, 'bright backdrop adds a correction stage')
  assert.notEqual(bright.tint, calm.tint, 'bright backdrop thickens the film')
})

test('clear and dispose hand the container its own inline styles back', () => {
  const { container, controller, render } = setup(CHROME_ENV)
  render()
  controller.clear()
  assert.equal(container.style.background, 'red')
  assert.equal(container.style.backdropFilter, '')
  render()
  assert.notEqual(container.style.background, 'red')
  controller.dispose()
  assert.equal(container.style.background, 'red')
  assert.equal(container.style.backdropFilter, '')
})
