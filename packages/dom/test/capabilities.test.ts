/**
 * Unit tests for browser capability detection, reduced-motion observers,
 * clamped frame loops, and ResizeObserver wrappers.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelAnimationFrameSafe,
  createFrameLoop,
  detectSurfaceCapabilities,
  measureElementBorderBox,
  observeElementResize,
  observeReducedMotion,
  prefersReducedMotion,
  resetCapabilityCache,
  resolveEffectiveRenderMode,
  scheduleAnimationFrame,
  supportsSvgBackdropRefraction,
  type FrameScheduler,
} from '../src/capabilities.ts'
import {
  MockDocument,
  MockResizeObserver,
  createMockMediaQueryList,
} from './mockDom.ts'

test('supportsSvgBackdropRefraction distinguishes Chromium from Safari, iOS WebKit, Firefox, and SSR', () => {
  resetCapabilityCache()
  const alwaysSupports = (_prop: string, _val: string) => true

  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      cssSupports: alwaysSupports,
    }),
    true,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
      cssSupports: alwaysSupports,
    }),
    true,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 OPR/119.0.0.0',
      cssSupports: alwaysSupports,
    }),
    true,
  )

  // Desktop Safari, Firefox, and all iOS browsers must downgrade cleanly.
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      cssSupports: alwaysSupports,
    }),
    false,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/134.0.0.0 Mobile/15E148 Safari/604.1',
      cssSupports: alwaysSupports,
    }),
    false,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/134.0 Mobile/15E148 Safari/605.1.15',
      cssSupports: alwaysSupports,
    }),
    false,
  )
  // Desktop-mode iPadOS Safari spoofs a Macintosh UA while reporting multi-touch points.
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      maxTouchPoints: 5,
      cssSupports: alwaysSupports,
    }),
    false,
  )
  // Non-Chromium userAgentData brands must downgrade cleanly even if UA contains Chrome/Safari tokens.
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      userAgentDataBrands: [{ brand: 'Not A Brand' }],
      cssSupports: alwaysSupports,
    }),
    false,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      userAgentDataBrands: [{ brand: 'Chromium' }],
      cssSupports: alwaysSupports,
    }),
    true,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0',
      cssSupports: alwaysSupports,
    }),
    false,
  )

  // CSS.supports returning false or SSR (missing UA/cssSupports) disables refraction.
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent: 'Chrome/134.0.0.0 Safari/537.36',
      cssSupports: () => false,
    }),
    false,
  )
  assert.equal(
    supportsSvgBackdropRefraction({
      userAgent: undefined,
      cssSupports: undefined,
    }),
    false,
  )
})

test('prefersReducedMotion and observeReducedMotion support modern and legacy listeners', () => {
  const modernCtrl = createMockMediaQueryList(false, 'modern')
  assert.equal(
    prefersReducedMotion({ matchMedia: () => modernCtrl.mediaQueryList }),
    false,
  )

  const seen: boolean[] = []
  const disposeModern = observeReducedMotion(
    (reduced) => seen.push(reduced),
    { matchMedia: () => modernCtrl.mediaQueryList },
  )
  modernCtrl.dispatchChange(true)
  modernCtrl.dispatchChange(false)
  assert.deepEqual(seen, [true, false])
  assert.equal(modernCtrl.listenerCount(), 1)

  // Disposer must be idempotent and block further events.
  disposeModern()
  disposeModern()
  modernCtrl.dispatchChange(true)
  assert.deepEqual(seen, [true, false])
  assert.equal(modernCtrl.listenerCount(), 0)

  const legacyCtrl = createMockMediaQueryList(true, 'legacy')
  assert.equal(
    prefersReducedMotion({ matchMedia: () => legacyCtrl.mediaQueryList }),
    true,
  )
  const legacySeen: boolean[] = []
  const disposeLegacy = observeReducedMotion(
    (reduced) => legacySeen.push(reduced),
    { matchMedia: () => legacyCtrl.mediaQueryList },
  )
  legacyCtrl.dispatchChange(false)
  assert.deepEqual(legacySeen, [false])
  disposeLegacy()
  assert.equal(legacyCtrl.listenerCount(), 0)
})

test('resolveEffectiveRenderMode applies progressive enhancement downgrades', () => {
  assert.equal(
    resolveEffectiveRenderMode('refract', { svgBackdropRefraction: true, reducedMotion: false }),
    'refract',
  )
  assert.equal(
    resolveEffectiveRenderMode('refract', { svgBackdropRefraction: false, reducedMotion: false }),
    'frosted',
  )
  assert.equal(
    resolveEffectiveRenderMode(
      'refract',
      { svgBackdropRefraction: true, reducedMotion: true },
      { disableRefractOnReducedMotion: true },
    ),
    'frosted',
  )
  assert.equal(
    resolveEffectiveRenderMode(
      'refract',
      { svgBackdropRefraction: true, reducedMotion: true },
      { disableRefractOnReducedMotion: false },
    ),
    'refract',
  )
  assert.equal(
    resolveEffectiveRenderMode('solid', { svgBackdropRefraction: false, reducedMotion: true }),
    'solid',
  )
})

test('createFrameLoop clamps dtSec, stops on false return, and blocks stale callbacks', () => {
  let nextId = 1
  let currentNowMs = 100
  const pending = new Map<number, FrameRequestCallback>()
  const canceled: number[] = []

  const scheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id) => {
      canceled.push(id)
      pending.delete(id)
    },
    now: () => currentNowMs,
  }

  // Test helper safety wrappers first.
  const scheduledId = scheduleAnimationFrame(() => {}, scheduler)
  assert.ok(scheduledId > 0)
  cancelAnimationFrameSafe(scheduledId, scheduler)
  assert.ok(canceled.includes(scheduledId))

  const ticks: number[] = []
  let shouldContinue = true
  const loop = createFrameLoop(
    (dtSec) => {
      ticks.push(dtSec)
      return shouldContinue
    },
    { maxDtSec: 0.05, scheduler },
  )

  loop.start()
  loop.start() // idempotent
  assert.equal(loop.isRunning(), true)
  assert.equal(pending.size, 1)

  const flushFirst = (tsMs: number) => {
    const first = pending.entries().next()
    if (first.done) return
    const [id, cb] = first.value
    pending.delete(id)
    cb(tsMs)
  }

  // 16ms normal frame
  currentNowMs = 116
  flushFirst(116)
  // 250ms stall should clamp to 0.05s
  currentNowMs = 366
  flushFirst(366)
  // Returning false stops the loop cleanly
  shouldContinue = false
  currentNowMs = 382
  flushFirst(382)

  assert.equal(loop.isRunning(), false)
  assert.equal(ticks.length, 3)
  assert.ok(Math.abs(ticks[0]! - 0.016) < 1e-6)
  assert.equal(ticks[1], 0.05)
  assert.ok(Math.abs(ticks[2]! - 0.016) < 1e-6)

  // Stale callback retained manually must not invoke tick after stop().
  const staleTicks: number[] = []
  let capturedStaleCb: FrameRequestCallback | null = null
  const customScheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      capturedStaleCb = cb
      return 99
    },
    cancelAnimationFrame: () => {},
    now: () => 500,
  }
  const staleLoop = createFrameLoop((dt) => {
    staleTicks.push(dt)
  }, { scheduler: customScheduler })
  staleLoop.start()
  staleLoop.stop()
  assert.equal(staleLoop.isRunning(), false)
  const staleFn = capturedStaleCb as FrameRequestCallback | null
  assert.ok(staleFn !== null)
  staleFn(516)
  assert.equal(staleTicks.length, 0)

  // Interrupting and immediately restarting the loop inside tick must preserve the new generation.
  let genNextId = 1
  const genPending = new Map<number, FrameRequestCallback>()
  const genScheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      const id = genNextId++
      genPending.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id) => {
      genPending.delete(id)
    },
    now: () => 1000,
  }
  let genCount = 0
  const genLoop = createFrameLoop(
    () => {
      genCount += 1
      if (genCount === 1) {
        genLoop.stop()
        genLoop.start()
      }
      return true
    },
    { scheduler: genScheduler },
  )
  genLoop.start()
  const firstEntry = genPending.entries().next()
  assert.equal(firstEntry.done, false)
  const [firstId, firstCb] = firstEntry.value!
  genPending.delete(firstId)
  firstCb(1016)
  assert.equal(genLoop.isRunning(), true)
  assert.equal(genPending.size, 1)
  genLoop.stop()
})

test('measureElementBorderBox and observeElementResize deduplicate sub-pixel jitter and clean up', () => {
  MockResizeObserver.records = []
  const doc = new MockDocument()
  const el = doc.createElement('div') as unknown as Element & {
    setBoundingClientRect(r: { x: number; y: number; width: number; height: number }): void
  }
  el.setBoundingClientRect({ x: 10, y: 20, width: 120, height: 48 })

  assert.deepEqual(measureElementBorderBox(el), { width: 120, height: 48 })
  assert.deepEqual(
    measureElementBorderBox(el, {
      target: el,
      borderBoxSize: [{ inlineSize: 240.5, blockSize: 64.25 }],
      contentRect: { width: 200, height: 50 } as DOMRectReadOnly,
    } as unknown as ResizeObserverEntry),
    { width: 240.5, height: 64.25 },
  )

  const seen: Array<{ width: number; height: number }> = []
  const stop = observeElementResize(el, (size) => seen.push(size), {
    ResizeObserverCtor: MockResizeObserver as unknown as typeof ResizeObserver,
    emitInitial: true,
  })
  assert.deepEqual(seen, [{ width: 120, height: 48 }])
  assert.equal(MockResizeObserver.records.length, 1)

  const record = MockResizeObserver.records[0]!
  assert.deepEqual(record.observeOptions[0], { box: 'border-box' })
  // Sub-0.01px jitter is suppressed.
  record.trigger([
    {
      target: el,
      borderBoxSize: [{ inlineSize: 120.004, blockSize: 48.004 }],
    } as unknown as ResizeObserverEntry,
  ])
  assert.equal(seen.length, 1)

  // Meaningful change emits new border-box size.
  record.trigger([
    {
      target: el,
      borderBoxSize: [{ inlineSize: 180, blockSize: 72 }],
    } as unknown as ResizeObserverEntry,
  ])
  assert.deepEqual(seen, [
    { width: 120, height: 48 },
    { width: 180, height: 72 },
  ])

  stop()
  stop() // idempotent
  assert.equal(record.disconnected, true)

  const caps = detectSurfaceCapabilities({
    userAgent: undefined,
    cssSupports: undefined,
    matchMedia: () => null,
  })
  assert.equal(caps.svgBackdropRefraction, false)
  assert.equal(caps.reducedMotion, false)
})
