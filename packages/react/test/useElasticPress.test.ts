/**
 * Unit tests for `useElasticPress` covering pointer press/move/release springs,
 * intensity scaling, guard attributes, reduced motion, and cleanup on unmount.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useElasticPress, type UseElasticPressOptions } from '../src/useElasticPress.ts'
import { createMockFrameScheduler, installDomEnv } from './testEnv.ts'

function parseTransform(transform: string): {
  ox: number
  oy: number
  sx: number
  sy: number
} | null {
  const match =
    /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0(?:px)?\)\s*scale\(([-\d.]+),\s*([-\d.]+)\)/.exec(
      transform,
    )
  if (!match) return null
  return {
    ox: Number.parseFloat(match[1]!),
    oy: Number.parseFloat(match[2]!),
    sx: Number.parseFloat(match[3]!),
    sy: Number.parseFloat(match[4]!),
  }
}

function mockBox(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height })
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect
}

function makePointerEvent(
  type: string,
  init: {
    pointerId?: number
    pointerType?: string
    button?: number
    clientX?: number
    clientY?: number
  } = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  })
}

test('useElasticPress animates press growth, drag tracking, intensity scaling, and release settlement', async () => {
  const env = installDomEnv()
  try {
    const clock = createMockFrameScheduler()
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)

    let buttonEl = null as HTMLButtonElement | null
    function Harness(props: UseElasticPressOptions) {
      const ref = useRef<HTMLButtonElement | null>(null)
      useElasticPress(ref, { scheduler: clock.scheduler, ...props })
      return createElement('button', {
        ref: (node: HTMLButtonElement | null) => {
          ref.current = node
          if (node) {
            buttonEl = node
            mockBox(node, 80, 40)
          }
        },
        type: 'button',
      })
    }

    await act(async () => {
      root.render(createElement(Harness, { reducedMotion: false, intensity: 1 }))
    })
    assert.ok(buttonEl)
    const el = buttonEl

    el.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    assert.equal(el.getAttribute('data-sessile-elastic-press'), 'true')
    assert.ok(clock.getPendingCount() > 0)

    clock.stepFrame(16)
    clock.stepFrame(16)
    const grown = parseTransform(el.style.transform)
    assert.ok(grown && grown.sx > 1.005, `expected scaleX > 1.005, got ${el.style.transform}`)

    window.dispatchEvent(
      makePointerEvent('pointermove', { clientX: 140, clientY: 120 }),
    )
    for (let i = 0; i < 20; i++) {
      clock.stepFrame(16)
    }
    const draggedFull = parseTransform(el.style.transform)
    assert.ok(
      draggedFull && draggedFull.ox > 0.5 && draggedFull.oy > 0.25,
      `expected positive drag offset, got ${el.style.transform}`,
    )

    // Reducing intensity to 0.5 halves deviations dynamically without dropping active drag.
    await act(async () => {
      root.render(createElement(Harness, { reducedMotion: false, intensity: 0.5 }))
    })
    clock.stepFrame(16)
    const draggedHalf = parseTransform(el.style.transform)
    assert.ok(draggedHalf)
    assert.ok(draggedHalf.ox < draggedFull.ox * 0.6)

    window.dispatchEvent(makePointerEvent('pointerup', { clientX: 140, clientY: 120 }))
    clock.flushUntilIdle(16)
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    assert.equal(el.style.transform, '')
    assert.equal(clock.getPendingCount(), 0)

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})

test('useElasticPress ignores secondary mouse clicks, disabled targets, and morphing attribute', async () => {
  const env = installDomEnv()
  try {
    const clock = createMockFrameScheduler()
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    let buttonEl = null as HTMLButtonElement | null

    function Harness(props: UseElasticPressOptions) {
      const ref = useRef<HTMLButtonElement | null>(null)
      useElasticPress(ref, { scheduler: clock.scheduler, reducedMotion: false, ...props })
      return createElement('button', {
        ref: (node: HTMLButtonElement | null) => {
          ref.current = node
          if (node) {
            buttonEl = node
            mockBox(node, 60, 40)
          }
        },
        type: 'button',
      })
    }

    await act(async () => {
      root.render(createElement(Harness))
    })
    assert.ok(buttonEl)
    const el = buttonEl

    // Secondary mouse button is ignored.
    el.dispatchEvent(makePointerEvent('pointerdown', { pointerType: 'mouse', button: 2 }))
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)

    // Disabled and aria-disabled states are ignored.
    el.setAttribute('disabled', '')
    el.dispatchEvent(makePointerEvent('pointerdown'))
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    el.removeAttribute('disabled')

    el.setAttribute('aria-disabled', 'true')
    el.dispatchEvent(makePointerEvent('pointerdown'))
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    el.removeAttribute('aria-disabled')

    // ignoreAttribute blocks start and aborts an active press mid-flight.
    el.setAttribute('data-sessile-morphing', 'true')
    el.dispatchEvent(makePointerEvent('pointerdown'))
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    el.removeAttribute('data-sessile-morphing')

    el.dispatchEvent(makePointerEvent('pointerdown'))
    clock.stepFrame(16)
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), true)

    el.setAttribute('data-sessile-morphing', 'true')
    clock.stepFrame(16)
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    assert.equal(el.style.transform, '')

    // Clean window listeners via blur and verify disabled / reducedMotion prop clears transforms.
    window.dispatchEvent(new Event('blur'))
    el.removeAttribute('data-sessile-morphing')
    el.dispatchEvent(makePointerEvent('pointerdown'))
    clock.stepFrame(16)
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), true)

    await act(async () => {
      root.render(createElement(Harness, { reducedMotion: true }))
    })
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    assert.equal(el.style.transform, '')

    await act(async () => {
      root.render(createElement(Harness, { reducedMotion: false }))
    })
    el.dispatchEvent(makePointerEvent('pointerdown'))
    clock.stepFrame(16)
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), true)

    // Unmounting mid-drag removes listeners and resets transforms cleanly.
    await act(async () => {
      root.unmount()
    })
    assert.equal(el.hasAttribute('data-sessile-elastic-press'), false)
    assert.equal(el.style.transform, '')
    assert.equal(clock.getPendingCount(), 0)
  } finally {
    await env.restore()
  }
})

test('useElasticPress reattaches listeners when a conditionally rendered target mounts or swaps', async () => {
  const env = installDomEnv()
  try {
    const clock = createMockFrameScheduler()
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    let firstBtn = null as HTMLButtonElement | null
    let secondBtn = null as HTMLButtonElement | null

    function ConditionalHarness({ mode }: { mode: 'none' | 'first' | 'second' }) {
      const ref = useRef<HTMLButtonElement | null>(null)
      useElasticPress(ref, { scheduler: clock.scheduler, reducedMotion: false })
      if (mode === 'none') {
        return createElement('div')
      }
      return createElement('button', {
        key: mode,
        ref: (node: HTMLButtonElement | null) => {
          ref.current = node
          if (node) {
            mockBox(node, 80, 40)
            if (mode === 'first') firstBtn = node
            if (mode === 'second') secondBtn = node
          }
        },
        type: 'button',
      })
    }

    // Mount initially with targetRef.current === null, then mount the target later.
    await act(async () => {
      root.render(createElement(ConditionalHarness, { mode: 'none' }))
    })
    await act(async () => {
      root.render(createElement(ConditionalHarness, { mode: 'first' }))
    })
    assert.ok(firstBtn)
    firstBtn.dispatchEvent(makePointerEvent('pointerdown'))
    clock.stepFrame(16)
    assert.equal(firstBtn.getAttribute('data-sessile-elastic-press'), 'true')

    // Swapping to a new DOM element cleans up the old node and attaches to the new node.
    await act(async () => {
      root.render(createElement(ConditionalHarness, { mode: 'second' }))
    })
    assert.equal(firstBtn.hasAttribute('data-sessile-elastic-press'), false)
    assert.ok(secondBtn)
    secondBtn.dispatchEvent(makePointerEvent('pointerdown'))
    clock.stepFrame(16)
    assert.equal(secondBtn.getAttribute('data-sessile-elastic-press'), 'true')

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})
