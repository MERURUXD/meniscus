/**
 * Unit tests for `<GlassField>` and `<GlassPrimitive>` covering 3-layer controller
 * mounting/disposal, headless & DOM-measured primitives, progressive mode/theme updates,
 * ResizeObserver synchronization, and React StrictMode compatibility.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StrictMode, act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  IGlassOverlayRenderer,
  OverlayRenderFrame,
  RendererCapabilities,
} from '@meniscus/core'
import type { CapabilityEnv, GlassSurfaceController } from '@meniscus/dom'
import { GlassField } from '../src/GlassField.ts'
import { useGlassField } from '../src/GlassFieldContext.ts'
import { GlassPrimitive } from '../src/GlassPrimitive.ts'
import { installDomEnv } from './testEnv.ts'

const CHROME_ENV: CapabilityEnv = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  cssSupports: () => true,
}

interface OverlaySnapshot {
  primitives: Array<{
    id?: string
    cx: number
    cy: number
    width: number
    height: number
    radius: number
  }>
  blendK: number
  theme: 'light' | 'dark'
  opacity: number
}

function createSpyOverlayRenderer() {
  const frames: OverlaySnapshot[] = []
  let clearedCount = 0
  let disposedCount = 0
  const capabilities: RendererCapabilities = {
    webgl2: true,
    floatFbo: true,
    maxTextureSize: 4096,
  }

  const renderer: IGlassOverlayRenderer = {
    capabilities,
    mount() {
      return capabilities
    },
    render(frame: OverlayRenderFrame) {
      // Snapshot pooled primitives synchronously because the DOM controller reuses objects per frame.
      frames.push({
        primitives: frame.field.primitives.map((p) => ({
          id: p.id,
          cx: p.center.x,
          cy: p.center.y,
          width: p.size.width,
          height: p.size.height,
          radius: p.radius,
        })),
        blendK: frame.field.blendK,
        theme: frame.theme,
        opacity: frame.opacity,
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
    frames,
    getClearedCount: () => clearedCount,
    getDisposedCount: () => disposedCount,
  }
}

function setElementRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }) as DOMRect
}

test('GlassField mounts controller with 3 sibling layers, renders headless GlassPrimitive shapes, and disposes cleanly', async () => {
  const env = installDomEnv()
  try {
    const spy = createSpyOverlayRenderer()
    const controllerRef = createRef<GlassSurfaceController | null>()
    const containerRef = createRef<HTMLDivElement | null>()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            containerRef,
            blendK: 28,
            theme: 'dark',
            observeResize: false,
          },
          createElement(GlassPrimitive, {
            id: 'pill-a',
            x: 10,
            y: 20,
            width: 100,
            height: 40,
            radius: 20,
          }),
          createElement(GlassPrimitive, {
            id: 'pill-b',
            x: 90,
            y: 20,
            width: 80,
            height: 40,
            radius: 20,
          }),
        ),
      )
    })

    const controller = controllerRef.current
    const containerEl = containerRef.current
    assert.ok(controller)
    assert.ok(containerEl)
    assert.equal(spy.frames.length, 1)
    assert.equal(spy.frames[0]!.blendK, 28)
    assert.equal(spy.frames[0]!.theme, 'dark')
    assert.equal(spy.frames[0]!.primitives.length, 2)

    const els = controller.getElements()
    assert.ok(els.refractBackdrop)
    assert.ok(els.veil)
    assert.ok(els.overlayCanvas)
    assert.equal(els.veil.style.visibility, 'visible')
    assert.equal(els.refractBackdrop.style.visibility, 'visible')
    assert.equal(els.overlayCanvas.style.visibility, 'visible')
    assert.ok(els.veil.style.clipPath.startsWith('path('))

    // Toggle active={false} on one primitive, switch mode="solid", and verify updates.
    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            containerRef,
            blendK: 28,
            mode: 'solid',
            theme: 'light',
            observeResize: false,
          },
          createElement(GlassPrimitive, {
            id: 'pill-a',
            x: 10,
            y: 20,
            width: 100,
            height: 40,
            radius: 20,
          }),
          createElement(GlassPrimitive, {
            id: 'pill-b',
            x: 90,
            y: 20,
            width: 80,
            height: 40,
            radius: 20,
            active: false,
          }),
        ),
      )
    })

    const latest = spy.frames[spy.frames.length - 1]!
    assert.equal(latest.primitives.length, 1)
    assert.equal(latest.primitives[0]!.id, 'pill-a')
    assert.equal(latest.theme, 'light')
    assert.equal(controller.getEffectiveMode(), 'solid')
    assert.equal(els.refractBackdrop.style.visibility, 'hidden')

    // Unmount all primitives -> controller.clear() hides layers cleanly.
    await act(async () => {
      root.render(
        createElement(GlassField, {
          env: CHROME_ENV,
          overlayRenderer: spy.renderer,
          controllerRef,
          containerRef,
          observeResize: false,
        }),
      )
    })
    assert.equal(els.veil.style.visibility, 'hidden')
    assert.equal(els.overlayCanvas.style.visibility, 'hidden')

    // Unmount field -> controller disposed and refs cleared.
    await act(async () => {
      root.unmount()
    })
    assert.equal(controllerRef.current, null)
    assert.equal(containerRef.current, null)
    assert.equal(spy.getDisposedCount(), 1)
  } finally {
    await env.restore()
  }
})

test('GlassPrimitive wrapper mode measures relative box, reads borderRadius, and tracks ResizeObserver', async () => {
  const env = installDomEnv()
  try {
    const observers: Array<{ target: Element; cb: ResizeObserverCallback }> = []
    class MockRO implements ResizeObserver {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(target: Element) {
        observers.push({ target, cb: this.cb })
      }
      unobserve() {}
      disconnect() {}
    }

    const spy = createSpyOverlayRenderer()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    let boxWidth = 120
    let boxHeight = 48

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            ResizeObserverCtor: MockRO,
            containerRef: (el) => {
              if (!el) return
              Object.defineProperty(el, 'clientLeft', { configurable: true, value: 4 })
              Object.defineProperty(el, 'clientTop', { configurable: true, value: 2 })
              setElementRect(el, { left: 100, top: 200, width: 400, height: 300 })
            },
          },
          createElement(
            GlassPrimitive,
            {
              id: 'wrapped',
              style: { borderRadius: '18px' },
              elementRef: (el) => {
                if (!el) return
                setElementRect(el, { left: 124, top: 232, width: boxWidth, height: boxHeight })
              },
            },
            createElement('span', null, 'Button'),
          ),
        ),
      )
    })

    // Container padding origin is (100 + 4, 200 + 2) = (104, 202).
    // Child top-left relative to padding origin is (124 - 104, 232 - 202) = (20, 30).
    // Surface bounds auto-expand around the primitive, and overlay receives bounds-shifted coordinates.
    assert.ok(spy.frames.length >= 1)
    const first = spy.frames[0]!
    assert.equal(first.primitives[0]!.width, 120)
    assert.equal(first.primitives[0]!.height, 48)
    assert.equal(first.primitives[0]!.radius, 18)

    // Update mocked child rect and trigger its ResizeObserver callback.
    const wrapperObs = observers.find((o) =>
      o.target.textContent?.includes('Button'),
    )
    assert.ok(wrapperObs)
    boxWidth = 200
    boxHeight = 64
    setElementRect(wrapperObs.target, { left: 124, top: 232, width: boxWidth, height: boxHeight })
    wrapperObs.cb(
      [
        {
          target: wrapperObs.target,
          borderBoxSize: [{ inlineSize: boxWidth, blockSize: boxHeight }],
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver,
    )

    const resized = spy.frames[spy.frames.length - 1]!
    assert.equal(resized.primitives[0]!.width, 200)
    assert.equal(resized.primitives[0]!.height, 64)

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})

test('GlassField handles controlled primitives, React StrictMode, and guards useGlassField outside provider', async () => {
  const env = installDomEnv()
  try {
    const spy = createSpyOverlayRenderer()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    function BadChild() {
      useGlassField()
      return null
    }

    await assert.rejects(
      async () => {
        await act(async () => {
          root.render(createElement(BadChild))
        })
      },
      /useGlassField must be used within a <GlassField>/,
    )

    const controllerRef = createRef<GlassSurfaceController | null>()
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(GlassField, {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            observeResize: false,
            primitives: [
              {
                id: 'controlled',
                center: { x: 80, y: 50 },
                size: { width: 100, height: 40 },
                radius: 20,
              },
            ],
          }),
        ),
      )
    })

    assert.ok(controllerRef.current)
    const latest = spy.frames[spy.frames.length - 1]!
    assert.equal(latest.primitives.length, 1)
    assert.equal(latest.primitives[0]!.id, 'controlled')

    await act(async () => {
      root.unmount()
    })
    assert.equal(controllerRef.current, null)
    assert.equal(spy.getDisposedCount(), 1)
  } finally {
    await env.restore()
  }
})
