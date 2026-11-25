/**
 * Unit tests for adaptive legibility in `@sessile/dom`: Route B3 stage wiring, hot updates that
 * never re-encode the displacement map, probe sampling, N >= 2 continuity and the fallback path.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_OPTICAL_MATERIALS,
  createLegibilityParams,
  createTelemetryAccumulator,
  resolveLegibilityGoal,
  resolveLegibilityParams,
  type BackdropTelemetry,
  type GlassFieldState,
  type IGlassOverlayRenderer,
  type OpticalMaterial,
} from '@sessile/core'
import { createRegionProbe } from '../src/backdropProbe.ts'
import { LegibilityDriver } from '../src/legibility.ts'
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

const WHITE = [1, 1, 1]
const BRIGHT: BackdropTelemetry = { lumaHigh: 1, lumaLow: 0.5, chroma: 0.9, detail: 0.5 }
const CALM: BackdropTelemetry = { lumaHigh: 0.12, lumaLow: 0.02, chroma: 0.05, detail: 0.01 }

const SINGLE: GlassFieldState = {
  blendK: 0,
  primitives: [{ center: { x: 200, y: 120 }, size: { width: 160, height: 48 }, radius: 24 }],
}
const PAIR: GlassFieldState = {
  blendK: 22,
  primitives: [
    { center: { x: 200, y: 120 }, size: { width: 120, height: 48 }, radius: 24 },
    { center: { x: 280, y: 120 }, size: { width: 64, height: 40 }, radius: 20 },
  ],
}

function descendants(root: MockElement, tag: string, out: MockElement[] = []): MockElement[] {
  for (const child of root.childNodes) {
    if (child.tagName === tag) out.push(child)
    descendants(child, tag, out)
  }
  return out
}

function filterOf(doc: MockDocument): MockElement {
  return descendants(doc.body, 'filter')[0]!
}

function glassOnly(filter: MockElement): MockElement {
  return filter.childNodes.find(
    (n) => n.tagName === 'feComposite' && n.attributes.get('in2') === 'map',
  )!
}

function createScheduler() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let nowMs = 0
  return {
    pending,
    scheduler: {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        const id = nextId++
        pending.set(id, cb)
        return id
      },
      cancelAnimationFrame: (id: number) => {
        pending.delete(id)
      },
      now: () => nowMs,
    },
    run(frames: number, stepMs = 16): void {
      for (let i = 0; i < frames && pending.size > 0; i++) {
        nowMs += stepMs
        const batch = [...pending.entries()]
        pending.clear()
        for (const [, cb] of batch) cb(nowMs)
      }
    },
  }
}

function createMaterialSpy() {
  const materials: OpticalMaterial[] = []
  const renderer: IGlassOverlayRenderer = {
    capabilities: { webgl2: true, floatFbo: true, maxTextureSize: 4096 },
    mount: () => renderer.capabilities,
    render: (frame) => {
      materials.push({ ...frame.material })
    },
    clear: () => {},
    dispose: () => {},
  }
  return { renderer, materials }
}

function setup(env: typeof CHROME_ENV, field: GlassFieldState) {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  doc.body.appendChild(container)
  const frames = createScheduler()
  const spy = createMaterialSpy()
  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env,
    theme: 'dark',
    mode: 'refract',
    overlayRenderer: spy.renderer,
    scheduler: frames.scheduler,
    legibility: { foreground: WHITE, tier: 'legible' },
  })
  controller.render({ field })
  return { doc, controller, frames, spy }
}

test('the legibility stage sits between the refracted backdrop and the self-mask', () => {
  const doc = new MockDocument()
  const filter = createRefractFilterController({ id: 'leg', document: doc as unknown as Document })
  filter.mount()
  const el = filterOf(doc)
  const params = createLegibilityParams()
  resolveLegibilityParams(
    resolveLegibilityGoal({ foreground: WHITE, tier: 'regular' }),
    { luma: 1, chroma: 0, detail: 0 },
    [1, 1, 1, 0],
    params,
  )

  filter.updateLegibility(params)
  const order = el.childNodes.map((n) => n.attributes.get('result') ?? n.tagName)
  const smooth = order.indexOf('refractSmooth')
  assert.deepEqual(order.slice(smooth + 1, smooth + 6), [
    'legibleOpaque',
    'legibleLuminance',
    'legibleGain',
    'legibleOpaqueOut',
    'legible',
  ])
  assert.equal(glassOnly(el).attributes.get('in'), 'legible')
  const [, luminance, gain, composite, mask] = el.childNodes.slice(smooth + 1, smooth + 6)
  assert.equal(composite!.attributes.get('in'), 'legibleOpaque', 'arithmetic runs on an opaque copy')
  assert.deepEqual(
    [mask!.attributes.get('operator'), mask!.attributes.get('in2')],
    ['in', 'refractSmooth'],
    'original alpha is restored after the arithmetic',
  )
  assert.equal(luminance!.attributes.get('color-interpolation-filters'), 'linearRGB')
  assert.deepEqual(
    ['k1', 'k2', 'k3', 'k4'].map((k) => composite!.attributes.get(k)),
    ['1', '0', '0', '0'],
  )
  const tableValues = gain!.childNodes.map((fn) => fn.attributes.get('tableValues'))
  assert.equal(tableValues.length, 3)
  assert.equal(tableValues[0]!.split(' ').length, params.table.length)
  assert.ok(Number(tableValues[0]!.split(' ').at(-1)) < 0.8, 'white is compressed')

  const writes = gain!.childNodes[0]!.setAttributeCalls.length
  filter.updateLegibility(params)
  assert.equal(gain!.childNodes[0]!.setAttributeCalls.length, writes, 'same revision rewrites nothing')

  filter.updateConfig({ dispersion: 3 })
  const afterDispersion = el.childNodes.map((n) => n.attributes.get('result') ?? n.tagName)
  assert.ok(afterDispersion.indexOf('lens-B') < afterDispersion.indexOf('refractSmooth'))
  assert.ok(afterDispersion.indexOf('refractSmooth') < afterDispersion.indexOf('legibleLuminance'))
  assert.equal(glassOnly(el).attributes.get('in'), 'legible', 'dispersion rebuild keeps the stage wired')

  resolveLegibilityParams(
    resolveLegibilityGoal({ foreground: [0.05, 0.05, 0.05], tier: 'regular' }),
    { luma: 1, chroma: 0, detail: 0 },
    [0, 0, 0, 0],
    params,
  )
  filter.updateLegibility(params)
  assert.equal(luminance!.attributes.get('color-interpolation-filters'), 'sRGB')
  assert.deepEqual(
    ['k1', 'k2', 'k3', 'k4'].map((k) => composite!.attributes.get(k)),
    ['1', '0', '-1', '1'],
  )

  filter.updateLegibility(null)
  assert.equal(descendants(el, 'feComponentTransfer').length, 3, 'only dispersion transfers remain')
  assert.equal(glassOnly(el).attributes.get('in'), 'refractSmooth')
})

for (const [name, field] of [
  ['N = 1 (nine-slice)', SINGLE],
  ['N = 2 (full map)', PAIR],
] as const) {
  test(`sweeping backdrop risk never re-encodes the map or moves layer bounds: ${name}`, () => {
    const { doc, controller, frames } = setup(CHROME_ENV, field)
    const images = descendants(doc.body, 'feImage')
    assert.ok(images.length > 0)
    const mapWrites = (): number =>
      images.reduce(
        (sum, img) =>
          sum + img.setAttributeCalls.filter((c) => ['href', 'width', 'height'].includes(c.name)).length,
        0,
      )
    const layers = controller.getElements()
    const layerBox = (): string =>
      [layers.refractBackdrop, layers.veil, layers.overlayCanvas]
        .map((el) => `${el!.style.transform}|${el!.style.width}|${el!.style.height}`)
        .join(',')
    const gain = descendants(doc.body, 'feFuncR').find((fn) => fn.attributes.get('type') === 'table')!
    frames.run(60)

    const before = mapWrites()
    const box = layerBox()
    const tableWrites = gain.setAttributeCalls.length
    for (let k = 0; k <= 20; k++) {
      const t = k / 20
      controller.setBackdropTelemetry({ lumaHigh: t, lumaLow: t * 0.4, chroma: t, detail: t * 0.4 })
      frames.run(4)
    }
    controller.setBackdropTelemetry(CALM)
    frames.run(600)

    assert.ok(gain.setAttributeCalls.length > tableWrites, 'the sweep did reach the filter')
    assert.equal(mapWrites(), before, 'no Stored-PNG re-encode or feImage resize')
    assert.equal(descendants(doc.body, 'feImage').length, images.length)
    assert.equal(layerBox(), box, 'layer transforms and sizes are untouched')
    assert.equal(frames.pending.size, 0, 'the legibility loop sleeps once settled')
  })
}

test('per-primitive sampling keeps the material continuous while two primitives merge across a card edge', () => {
  const left = { getBoundingClientRect: () => rect(0, 0, 200, 300) } as unknown as Element
  const right = { getBoundingClientRect: () => rect(200, 0, 200, 300) } as unknown as Element
  const probe = createRegionProbe({ eventTarget: null })
  probe.set(left, CALM)
  probe.set(right, BRIGHT)
  const driver = new LegibilityDriver({ foreground: WHITE, tier: 'legible', probe })
  const veil = DEFAULT_OPTICAL_MATERIALS.dark.crisp.tintRgba

  let prev: { film: number; refraction: number } | null = null
  let first: number | null = null
  for (let x = 40; x <= 300; x += 2) {
    const gap = Math.max(0, 70 - (x - 40) * 0.5)
    const field: GlassFieldState = {
      blendK: 24,
      primitives: [
        { center: { x, y: 100 }, size: { width: 60, height: 40 }, radius: 20 },
        { center: { x: x + 60 + gap, y: 100 }, size: { width: 60, height: 40 }, radius: 20 },
      ],
    }
    driver.sample(field, 0, 0, veil)
    driver.advance(1e7)
    const params = driver.resolve(veil)
    const now = { film: params.veilRgba[3]!, refraction: params.refractionScale }
    first ??= now.film
    if (prev) {
      assert.ok(Math.abs(now.film - prev.film) < 0.01, `film step at x=${x}`)
      assert.ok(Math.abs(now.refraction - prev.refraction) < 0.03, `refraction step at x=${x}`)
    }
    prev = now
  }
  assert.ok(prev!.film > first! + 0.05, 'crossing onto the bright card thickens the film')
})

test('region probe maps grid cells, fills uncovered area with the background and invalidates on scroll', () => {
  const events = new EventTarget()
  const probe = createRegionProbe({ eventTarget: events, background: CALM })
  const cover = { getBoundingClientRect: () => rect(0, 0, 100, 50) } as unknown as Element
  const data = new Float32Array([0.1, 0.0, 0.1, 0.0, 1, 0.8, 0.9, 0.6])
  probe.set(cover, { cols: 2, rows: 1, data })

  const acc = createTelemetryAccumulator()
  const out: BackdropTelemetry = { lumaHigh: 0, lumaLow: 0, chroma: 0, detail: 0 }
  probe.sample([rect(50, 0, 50, 50)], acc)
  acc.resolve(out)
  assert.ok(Math.abs(out.lumaHigh - 1) < 1e-6 && Math.abs(out.chroma - 0.9) < 1e-6, 'right cell only')

  acc.reset()
  probe.sample([rect(100, 0, 50, 50)], acc)
  acc.resolve(out)
  assert.ok(Math.abs(out.lumaHigh - CALM.lumaHigh) < 1e-6, 'uncovered area reads as background')

  let calls = 0
  const stop = probe.observe!(() => {
    calls += 1
  })
  events.dispatchEvent(new Event('scroll'))
  stop()
  events.dispatchEvent(new Event('scroll'))
  assert.equal(calls, 1)
})

test('fallback path maps risk to film plus affine brightness on the frosted veil', () => {
  const { controller, frames } = setup(SAFARI_ENV, SINGLE)
  const veil = controller.getElements().veil!
  controller.setBackdropTelemetry(CALM)
  frames.run(200)
  const calmFilter = veil.style.backdropFilter
  const calmAlpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(veil.style.background)![1])

  controller.setBackdropTelemetry(BRIGHT)
  frames.run(30)
  const busyFilter = veil.style.backdropFilter
  const brightness = Number(/brightness\(([\d.]+)\)/.exec(busyFilter)?.[1] ?? 1)
  const busyAlpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(veil.style.background)![1])
  assert.notEqual(busyFilter, calmFilter)
  assert.ok(brightness < 0.9, `bright backdrop is dimmed, got ${busyFilter}`)
  assert.ok(busyAlpha > calmAlpha, 'film thickens the veil')
})

test('edge optics compensation raises alphas without touching the host material', () => {
  const { controller, frames, spy } = setup(CHROME_ENV, SINGLE)
  const base = DEFAULT_OPTICAL_MATERIALS.dark.frosted
  controller.setBackdropTelemetry(BRIGHT)
  frames.run(30)
  const last = spy.materials.at(-1)!
  assert.ok(last.hairlineSideAlpha > base.hairlineSideAlpha)
  assert.ok(last.shadowAlpha > base.shadowAlpha)
  assert.equal(last.shadowBlur, base.shadowBlur, 'radii feed surface bounds and stay fixed')
  assert.equal(DEFAULT_OPTICAL_MATERIALS.dark.frosted.hairlineSideAlpha, base.hairlineSideAlpha)

  controller.setLegibility(null)
  assert.equal(spy.materials.at(-1)!.hairlineSideAlpha, base.hairlineSideAlpha)
  assert.equal(
    glassOnly(filterOf((controller as unknown as { doc: MockDocument }).doc)).attributes.get('in'),
    'refractSmooth',
  )
})

test('the controller samples the probe at the primitive viewport rect, including container scroll', () => {
  const doc = new MockDocument()
  const container = doc.createElement('div') as unknown as MockElement
  doc.body.appendChild(container)
  container.setBoundingClientRect({ x: 100, y: 40, width: 600, height: 400 })
  container.scrollTop = 200
  const frames = createScheduler()
  const probe = createRegionProbe({ eventTarget: null, background: CALM })
  // SINGLE spans x 120..280, y 96..144 in container space; scrolled, that is viewport y -64..-16.
  const bright = { getBoundingClientRect: () => rect(220, -64, 160, 48) } as unknown as Element
  const decoy = { getBoundingClientRect: () => rect(220, 136, 160, 48) } as unknown as Element
  probe.set(bright, BRIGHT)
  probe.set(decoy, CALM)
  let samples = 0
  const counted = { ...probe, sample: (rects: Parameters<typeof probe.sample>[0], acc: Parameters<typeof probe.sample>[1]) => {
    samples += 1
    probe.sample(rects, acc)
  } }
  const controller = new GlassSurfaceController({
    container: container as unknown as HTMLElement,
    document: doc as unknown as Document,
    env: CHROME_ENV,
    theme: 'dark',
    mode: 'refract',
    overlayRenderer: createMaterialSpy().renderer,
    scheduler: frames.scheduler,
    legibility: { foreground: WHITE, tier: 'legible', probe: counted },
  })
  controller.render({ field: SINGLE })
  const sampledByRender = samples
  frames.run(120)
  const params = controller.getLegibilityParams()!
  assert.ok(params.refractionScale < 0.8, `bright cover under the glass raises detail risk, got ${params.refractionScale}`)
  assert.ok(params.veilRgba[3]! > DEFAULT_OPTICAL_MATERIALS.dark.frosted.tintRgba[3] + 0.05)
  assert.equal(samples, sampledByRender, 'smoothing ticks never re-read layout through the probe')
})

test('edge material drops optional keys the current material omits', () => {
  const { controller, frames, spy } = setup(CHROME_ENV, SINGLE)
  controller.setBackdropTelemetry(BRIGHT)
  controller.render({ field: SINGLE, material: { ...DEFAULT_OPTICAL_MATERIALS.dark.frosted, borderWidth: 2, lightAngle: 30 } })
  controller.render({ field: SINGLE, material: DEFAULT_OPTICAL_MATERIALS.dark.frosted })
  frames.run(5)
  const last = spy.materials.at(-1)!
  assert.equal(last.borderWidth, undefined)
  assert.equal(last.lightAngle, undefined)
})

test('a veil override the film cannot be composited onto is kept verbatim', () => {
  const { controller } = setup(CHROME_ENV, SINGLE)
  controller.setBackdropTelemetry(BRIGHT)
  controller.render({ field: SINGLE, refractTintBackground: 'linear-gradient(red, blue)' })
  assert.equal(controller.getElements().veil!.style.background, 'linear-gradient(red, blue)')
  for (const unresolved of ['rgb(var(--tint) / 0.5)', 'color(srgb 50% 20% 10% / 0.5)']) {
    controller.render({ field: SINGLE, refractTintBackground: unresolved })
    assert.equal(controller.getElements().veil!.style.background, unresolved, 'syntax the parser cannot resolve stays verbatim')
  }
  controller.render({ field: SINGLE, refractTintBackground: 'rgba(10, 20, 30, 0.5)' })
  assert.match(controller.getElements().veil!.style.background, /^rgba\(/)
  assert.notEqual(controller.getElements().veil!.style.background, 'rgba(10, 20, 30, 0.5)', 'film is composited on')
})

test('the first real telemetry snaps the smoother even after empty probe samples', () => {
  const probe = createRegionProbe({ eventTarget: null })
  const driver = new LegibilityDriver({ foreground: WHITE, tier: 'legible', probe })
  const veil = DEFAULT_OPTICAL_MATERIALS.dark.crisp.tintRgba
  driver.sample(SINGLE, 0, 0, veil)
  driver.advance(16)
  probe.set({ getBoundingClientRect: () => rect(0, 0, 1000, 1000) } as unknown as Element, CALM)
  driver.sample(SINGLE, 0, 0, veil)
  driver.advance(16)
  assert.ok(Math.abs(driver.resolve(veil).veilRgba[3]! - veil[3]) < 1e-6, 'no film left over from the assumed risk')
})

test('replacing the params object uploads its table even when the revisions coincide', () => {
  const doc = new MockDocument()
  const filter = createRefractFilterController({ id: 'swap', document: doc as unknown as Document })
  filter.mount()
  const resolved = (tier: 'clear' | 'legible') => {
    const params = createLegibilityParams()
    resolveLegibilityParams(
      resolveLegibilityGoal({ foreground: WHITE, tier }),
      { luma: 0, chroma: 0, detail: 0 },
      [1, 1, 1, 0],
      params,
    )
    return params
  }
  const clear = resolved('clear')
  const legible = resolved('legible')
  assert.equal(clear.tableRevision, legible.tableRevision, 'precondition: fresh params share a revision')
  const uploaded = () =>
    descendants(filterOf(doc), 'feFuncR')[0]!.attributes.get('tableValues')!.split(' ').map(Number)
  const last = (table: Float32Array) => Number(table[table.length - 1]!.toFixed(4))

  filter.updateLegibility(clear)
  filter.updateLegibility(legible)
  assert.equal(uploaded().at(-1), last(legible.table), 'replaced params reach the filter')
  filter.updateLegibility(null)
  filter.updateLegibility(clear)
  assert.equal(uploaded().at(-1), last(clear.table), 're-attaching with other params uploads them')
})

test('a snapped first telemetry sample reaches the layers before the loop sleeps', () => {
  const { controller, frames, doc } = setup(CHROME_ENV, SINGLE)
  frames.run(600)
  assert.equal(frames.pending.size, 0, 'precondition: assumed-risk material has settled')
  const blur = () => descendants(filterOf(doc), 'feGaussianBlur')[0]!.attributes.get('stdDeviation')
  const assumed = blur()

  controller.setBackdropTelemetry(CALM)
  frames.run(600)
  assert.equal(frames.pending.size, 0)
  assert.notEqual(blur(), assumed, 'calm backdrop drops the assumed-risk blur boost')
  assert.ok(Math.abs(controller.getLegibilityParams()!.veilRgba[3]! - DEFAULT_OPTICAL_MATERIALS.dark.crisp.tintRgba[3]) < 0.02)
})

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect
}
