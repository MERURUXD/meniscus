/**
 * Unit tests for `GlassSurfaceController` 3-layer orchestration, Route B3 vs frosted/solid
 * progressive degradation, zero-GC coordinate shifting, ResizeObserver, and cleanup.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_OPTICAL_MATERIALS,
  type GlassFieldState,
  type IGlassOverlayRenderer,
  type OverlayRenderFrame,
  type RendererCapabilities,
} from '@sessile/core'
import {
  GlassSurfaceController,
  computeAutoSurfaceBounds,
  computeClampedRefractBounds,
} from '../src/surfaceController.ts'
import {
  MockDocument,
  MockResizeObserver,
  createMockMediaQueryList,
  type MockElement,
} from './mockDom.ts'

interface RecordedOverlayRender {
  boundsShiftCheck: { cx: number; cy: number }[]
  opacity: number
  viewportWidth: number
  viewportHeight: number
}

function createSpyOverlayRenderer() {
  const renders: RecordedOverlayRender[] = []
  let mountedCanvas: HTMLCanvasElement | null = null
  let clearedCount = 0
  let disposedCount = 0

  const capabilities: RendererCapabilities = {
    webgl2: true,
    floatFbo: true,
    maxTextureSize: 4096,
  }

  const renderer: IGlassOverlayRenderer = {
    capabilities,
    mount(canvas) {
      mountedCanvas = canvas
      return capabilities
    },
    render(frame: OverlayRenderFrame) {
      renders.push({
        // Snapshot mutable zero-GC primitive coordinates during synchronous render call.
        boundsShiftCheck: frame.field.primitives.map((p) => ({ x: p.center.x, y: p.center.y, cx: p.center.x, cy: p.center.y })),
        opacity: frame.opacity,
        viewportWidth: frame.viewport.width,
        viewportHeight: frame.viewport.height,
      })
    },
    clear() {
      clearedCount += 1
    },
    dispose() {
      disposedCount += 1
    },
  }

  return {
    renderer,
    renders,
    getMountedCanvas: () => mountedCanvas,
    getClearedCount: () => clearedCount,
    getDisposedCount: () => disposedCount,
  }
}

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

const SAMPLE_FIELD: GlassFieldState = {
  blendK: 22,
  primitives: [
    { center: { x: 200, y: 120 }, size: { width: 120, height: 48 }, radius: 24 },
    { center: { x: 280, y: 120 }, size: { width: 64, height: 40 }, radius: 20 },
  ],
}

test('GlassSurfaceController places live content between veil and overlayCanvas and drives Route B3 in Chromium', () => {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  const content = doc.createElement('div') as unknown as MockElement
  container.appendChild(content)
  doc.body.appendChild(container)

  const spy = createSpyOverlayRenderer()
  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env: CHROME_ENV,
    theme: 'light',
    mode: 'refract',
    filterId: 'sessile-b3-test',
    overlayRenderer: spy.renderer,
  })

  const elements = controller.getElements()
  assert.ok(elements.refractBackdrop)
  assert.ok(elements.veil)
  assert.ok(elements.overlayCanvas)
  assert.equal(spy.getMountedCanvas(), elements.overlayCanvas)

  // Managed insertion order: [refractBackdrop, veil, content, overlayCanvas],
  // with container stacking context (non-Backdrop-Root) placing backdrops below normal-flow content.
  assert.deepEqual(container.childNodes, [
    elements.refractBackdrop as unknown as MockElement,
    elements.veil as unknown as MockElement,
    content,
    elements.overlayCanvas as unknown as MockElement,
  ])
  assert.equal(container.style.position, 'relative')
  assert.equal(container.style.zIndex, '0')
  assert.equal(container.style.isolation, '')
  assert.equal((elements.refractBackdrop as unknown as MockElement).style.zIndex, '-2')
  assert.equal((elements.veil as unknown as MockElement).style.zIndex, '-1')
  assert.equal((elements.overlayCanvas as unknown as MockElement).style.zIndex, '1')

  // Lazy SVG filter must NOT be mounted before the first visible refract render.
  assert.equal(doc.body.querySelectorAll('svg').length, 0)

  const material = DEFAULT_OPTICAL_MATERIALS.light.frosted
  controller.render({ field: SAMPLE_FIELD, material, opacity: 1 })

  const svgs = doc.body.querySelectorAll('svg')
  assert.equal(svgs.length, 1)
  assert.equal(svgs[0]!.querySelectorAll('filter')[0]!.getAttribute('id'), 'sessile-b3-test')

  const refractEl = elements.refractBackdrop as unknown as MockElement
  const veilEl = elements.veil as unknown as MockElement
  const canvasEl = elements.overlayCanvas as unknown as MockElement

  assert.equal(refractEl.style.visibility, 'visible')
  assert.equal(refractEl.style.clipPath, '')
  assert.equal(refractEl.style.backdropFilter, 'url(#sessile-b3-test)')
  assert.equal(refractEl.style.getPropertyValue('-webkit-backdrop-filter'), 'url(#sessile-b3-test)')

  assert.equal(veilEl.style.visibility, 'visible')
  assert.ok(veilEl.style.clipPath.startsWith('path("M'))
  assert.equal(veilEl.style.backdropFilter, 'none')
  assert.equal(veilEl.style.getPropertyValue('-webkit-backdrop-filter'), 'none')

  assert.equal(canvasEl.style.visibility, 'visible')
  assert.equal(spy.renders.length, 1)

  const expectedBounds = computeAutoSurfaceBounds(SAMPLE_FIELD, material)
  const expectedRefractBounds = computeClampedRefractBounds(SAMPLE_FIELD, expectedBounds)
  assert.equal(refractEl.style.width, `${expectedRefractBounds.width}px`)
  assert.equal(refractEl.style.height, `${expectedRefractBounds.height}px`)
  assert.equal(spy.renders[0]!.viewportWidth, expectedBounds.width)
  assert.equal(spy.renders[0]!.viewportHeight, expectedBounds.height)
  // Overlay primitives must be shifted into local surface-bounds coordinates.
  assert.equal(spy.renders[0]!.boundsShiftCheck[0]!.cx, 200 - expectedBounds.x)
  assert.equal(spy.renders[0]!.boundsShiftCheck[0]!.cy, 120 - expectedBounds.y)

  controller.dispose()
  assert.equal(spy.getDisposedCount(), 1)
  assert.equal(doc.body.querySelectorAll('svg').length, 0)
  // Managed sibling layers removed, host container content and inline styles restored intact.
  assert.deepEqual(container.childNodes, [content])
  assert.equal(container.style.position, '')
  assert.equal(container.style.zIndex, '')
})

test('GlassSurfaceController downgrades Safari to frosted without SVG mount and preserves mode transitions', () => {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  doc.body.appendChild(container)
  const spy = createSpyOverlayRenderer()

  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env: SAFARI_ENV,
    theme: 'dark',
    mode: 'refract',
    overlayRenderer: spy.renderer,
  })

  assert.equal(controller.getMode(), 'refract')
  assert.equal(controller.getEffectiveMode(), 'frosted')

  const material = DEFAULT_OPTICAL_MATERIALS.dark.frosted
  controller.render({ field: SAMPLE_FIELD, material, opacity: 0.9 })

  // Safari must never create an SVG refraction filter.
  assert.equal(doc.body.querySelectorAll('svg').length, 0)

  const { refractBackdrop, veil, overlayCanvas } = controller.getElements()
  const refractEl = refractBackdrop as unknown as MockElement
  const veilEl = veil as unknown as MockElement
  const canvasEl = overlayCanvas as unknown as MockElement

  assert.equal(refractEl.style.visibility, 'hidden')
  assert.equal(refractEl.style.backdropFilter, 'none')
  assert.ok(veilEl.style.clipPath.startsWith('path("M'))
  assert.ok(veilEl.style.backdropFilter.includes('blur('))
  assert.equal(
    veilEl.style.getPropertyValue('-webkit-backdrop-filter'),
    veilEl.style.backdropFilter,
  )
  assert.equal(canvasEl.style.visibility, 'visible')
  assert.equal(spy.renders.length, 1)

  // Dynamic mode switch to solid drops the stale blur but keeps an identity filter, so the
  // veil's path clip survives in Chromium.
  assert.equal(controller.setMode('solid'), 'solid')
  controller.render({ field: SAMPLE_FIELD, material, opacity: 1 })
  assert.equal(veilEl.style.backdropFilter, 'blur(0px)')
  assert.equal(veilEl.style.getPropertyValue('-webkit-backdrop-filter'), 'blur(0px)')
  assert.ok(veilEl.style.background.startsWith('rgb('))

  // Empty/transparent field hides all layers and clears overlay renderer.
  controller.render({ field: SAMPLE_FIELD, material, opacity: 0 })
  assert.equal(refractEl.style.visibility, 'hidden')
  assert.equal(veilEl.style.visibility, 'hidden')
  assert.equal(canvasEl.style.visibility, 'hidden')
  assert.ok(spy.getClearedCount() >= 1)

  controller.dispose()
})

test('GlassSurfaceController clears stale filters across mode switches and honors external elements & observers', () => {
  MockResizeObserver.records = []
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  container.setBoundingClientRect({ x: 0, y: 0, width: 320, height: 180 })
  const extRefract = doc.createElement('div') as unknown as MockElement
  const extVeil = doc.createElement('div') as unknown as MockElement
  const extCanvas = doc.createElement('canvas') as unknown as MockElement
  doc.body.appendChild(container)
  container.appendChild(extRefract)
  container.appendChild(extVeil)
  container.appendChild(extCanvas)

  const mqlCtrl = createMockMediaQueryList(false)
  const resizeSizes: Array<{ width: number; height: number }> = []
  const capChanges: boolean[] = []
  const spy = createSpyOverlayRenderer()

  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    elements: {
      refractBackdrop: extRefract as unknown as HTMLElement,
      veil: extVeil as unknown as HTMLElement,
      overlayCanvas: extCanvas as unknown as HTMLCanvasElement,
    },
    document: doc as unknown as Document,
    env: {
      ...CHROME_ENV,
      matchMedia: () => mqlCtrl.mediaQueryList,
    },
    disableRefractOnReducedMotion: true,
    observeResize: true,
    ResizeObserverCtor: MockResizeObserver as unknown as typeof ResizeObserver,
    onResize: (size) => resizeSizes.push(size),
    onCapabilitiesChange: (caps) => capChanges.push(caps.reducedMotion),
    overlayRenderer: spy.renderer,
  })

  assert.deepEqual(resizeSizes, [{ width: 320, height: 180 }])
  assert.equal(MockResizeObserver.records.length, 1)
  MockResizeObserver.records[0]!.trigger([
    {
      target: container as unknown as Element,
      borderBoxSize: [{ inlineSize: 400, blockSize: 220 }],
    } as unknown as ResizeObserverEntry,
  ])
  assert.deepEqual(controller.getContainerSize(), { width: 400, height: 220 })

  // Render in refract first, then switch through frosted -> solid -> refract.
  controller.render({ field: SAMPLE_FIELD })
  assert.equal(extRefract.style.backdropFilter.startsWith('url(#'), true)
  // A veil that never carried a filter stays filter-free on the Route B3 path.
  // Assert on a copy: asserting the property itself would narrow its type for the rest of the test.
  const initialVeilFilter: string = extVeil.style.backdropFilter
  assert.equal(initialVeilFilter, 'none')

  controller.setMode('frosted')
  controller.render({ field: SAMPLE_FIELD })
  assert.equal(extRefract.style.visibility, 'hidden')
  assert.equal(extRefract.style.backdropFilter, 'none')
  assert.ok(extVeil.style.backdropFilter.includes('blur('))

  controller.setMode('refract')
  controller.render({ field: SAMPLE_FIELD })
  assert.equal(extRefract.style.visibility, 'visible')
  // Removing the frosted blur outright would make Chromium clip the veil tint to the path's
  // bounding box, so it keeps an identity filter from here on.
  assert.equal(extVeil.style.backdropFilter, 'blur(0px)')

  // Live prefers-reduced-motion switch with disableRefractOnReducedMotion=true downgrades refract
  // and immediately repaints the resting frosted fallback without requiring a new caller render().
  mqlCtrl.dispatchChange(true)
  assert.deepEqual(capChanges, [true])
  assert.equal(controller.getEffectiveMode(), 'frosted')
  assert.equal(extRefract.style.visibility, 'hidden')
  assert.equal(extRefract.style.backdropFilter, 'none')
  assert.ok(extVeil.style.backdropFilter.includes('blur('))

  // Restoring normal motion immediately repaints Route B3 refraction on the resting frame.
  mqlCtrl.dispatchChange(false)
  assert.deepEqual(capChanges, [true, false])
  assert.equal(controller.getEffectiveMode(), 'refract')
  assert.equal(extRefract.style.visibility, 'visible')
  assert.equal(extRefract.style.backdropFilter.startsWith('url(#'), true)
  assert.equal(extVeil.style.backdropFilter, 'blur(0px)')

  controller.setMode('solid')
  controller.render({ field: SAMPLE_FIELD })
  assert.equal(extVeil.style.backdropFilter, 'blur(0px)')

  // Caller-owned external elements must remain attached to container after dispose().
  controller.dispose()
  assert.equal(MockResizeObserver.records[0]!.disconnected, true)
  assert.equal(mqlCtrl.listenerCount(), 0)
  assert.deepEqual(container.childNodes, [extRefract, extVeil, extCanvas])
})

test('GlassSurfaceController startLoop drives frames and stops cleanly on false or dispose', () => {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  doc.body.appendChild(container)
  const spy = createSpyOverlayRenderer()

  const pending = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let nowMs = 0

  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env: SAFARI_ENV,
    overlayRenderer: spy.renderer,
    scheduler: {
      requestAnimationFrame: (cb) => {
        const id = nextId++
        pending.set(id, cb)
        return id
      },
      cancelAnimationFrame: (id) => {
        pending.delete(id)
      },
      now: () => nowMs,
    },
  })

  let frameCount = 0
  controller.startLoop(() => {
    frameCount += 1
    if (frameCount >= 3) {
      return false
    }
    return { field: SAMPLE_FIELD }
  })

  assert.equal(controller.isLoopRunning(), true)

  for (let i = 0; i < 4; i++) {
    const next = pending.entries().next()
    if (next.done) break
    const [id, cb] = next.value
    pending.delete(id)
    nowMs += 16
    cb(nowMs)
  }

  assert.equal(frameCount, 3)
  assert.equal(spy.renders.length, 2)
  assert.equal(controller.isLoopRunning(), false)

  controller.dispose()
})

test('GlassSurfaceController aligns surface and refract bounds to fractional DPR and texel pitch during drag', () => {
  const noShadowMaterial = {
    ...DEFAULT_OPTICAL_MATERIALS.light.frosted,
    shadowBlur: 0,
    shadowOffsetY: 0,
    shadowAlpha: 0,
  }
  const probeField: GlassFieldState = {
    blendK: 20,
    primitives: [{ center: { x: 101, y: 83 }, size: { width: 60, height: 40 }, radius: 12 }],
  }
  const aligned4 = computeAutoSurfaceBounds(probeField, noShadowMaterial, 4)
  assert.equal(aligned4.x % 4, 0)
  assert.equal(aligned4.y % 4, 0)
  assert.equal(aligned4.width % 4, 0)
  assert.equal(aligned4.height % 4, 0)

  const refractAligned4 = computeClampedRefractBounds(probeField, aligned4, 4)
  assert.equal(refractAligned4.x % 4, 0)
  assert.equal(refractAligned4.width % 4, 0)

  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  doc.body.appendChild(container)
  const spy = createSpyOverlayRenderer()

  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env: CHROME_ENV,
    theme: 'light',
    mode: 'refract',
    overlayRenderer: spy.renderer,
  })

  const { refractBackdrop, overlayCanvas } = controller.getElements()
  const refractEl = refractBackdrop as unknown as MockElement
  const canvasEl = overlayCanvas as unknown as MockElement

  const extractTranslate = (transform: string): { x: number; y: number } => {
    const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(transform)
    assert.ok(match, `Expected translate3d in ${transform}`)
    return { x: Number(match[1]!), y: Number(match[2]!) }
  }

  // Test fractional Windows scaling (1.25 -> 4px quantum, 1.5 -> 2px quantum) while dragging one droplet.
  for (const dpr of [1.25, 1.5]) {
    const dprQuantum = dpr === 1.25 ? 4 : 2
    for (const dx of [0, -1, -3, -7]) {
      controller.render({
        dpr,
        material: DEFAULT_OPTICAL_MATERIALS.light.frosted,
        field: {
          blendK: 32,
          primitives: [
            { center: { x: 380, y: 188 }, size: { width: 164, height: 58 }, radius: 29 },
            { center: { x: 260 + dx, y: 276 }, size: { width: 90, height: 90 }, radius: 45 },
            { center: { x: 500, y: 272 }, size: { width: 102, height: 82 }, radius: 26 },
          ],
        },
      })

      const canvasOrigin = extractTranslate(canvasEl.style.transform)
      const latestRender = spy.renders[spy.renders.length - 1]!
      assert.equal(canvasOrigin.x % dprQuantum, 0)
      assert.equal(canvasOrigin.y % dprQuantum, 0)
      assert.equal(latestRender.viewportWidth % dprQuantum, 0)
      assert.equal(latestRender.viewportHeight % dprQuantum, 0)
      assert.ok(Math.abs(canvasOrigin.x * dpr - Math.round(canvasOrigin.x * dpr)) < 1e-6)
      assert.ok(Math.abs(latestRender.viewportWidth * dpr - Math.round(latestRender.viewportWidth * dpr)) < 1e-6)

      const refractOrigin = extractTranslate(refractEl.style.transform)
      const refractW = Number.parseFloat(refractEl.style.width)
      const refractH = Number.parseFloat(refractEl.style.height)
      assert.equal(refractOrigin.x % dprQuantum, 0)
      assert.equal(refractOrigin.y % dprQuantum, 0)
      assert.equal(refractW % dprQuantum, 0)
      assert.equal(refractH % dprQuantum, 0)
    }
  }

  controller.dispose()
})
