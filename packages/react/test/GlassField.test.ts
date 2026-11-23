/**
 * Unit tests for `<GlassField>` and `<GlassPrimitive>` covering 3-layer controller
 * mounting/disposal, headless & DOM-measured primitives, progressive mode/theme updates,
 * ResizeObserver synchronization, and React StrictMode compatibility.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, StrictMode, act, createElement, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DEFAULT_OPTICAL_MATERIALS,
  type IGlassOverlayRenderer,
  type OverlayRenderFrame,
  type RendererCapabilities,
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
    await Promise.resolve()

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

test('GlassField syncs controllerRef changes, clears initial optical overrides, and handles fixed positioning', async () => {
  const env = installDomEnv()
  try {
    const spy = createSpyOverlayRenderer()
    const refA = createRef<GlassSurfaceController | null>()
    const refB = createRef<GlassSurfaceController | null>()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    const customMaterial = {
      ...DEFAULT_OPTICAL_MATERIALS.light.frosted,
      tintRgba: [0.2, 0.4, 0.8, 0.5] as const,
    }

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef: refA,
            mode: 'frosted',
            theme: 'light',
            material: customMaterial,
            positioning: 'fixed',
            observeResize: false,
            containerRef: (el) => {
              if (el) {
                setElementRect(el, { left: 200, top: 300, width: 400, height: 300 })
              }
            },
          },
          createElement(
            GlassPrimitive,
            {
              id: 'fixed-box',
              radius: 12,
              elementRef: (el) => {
                if (el) {
                  setElementRect(el, { left: 240, top: 350, width: 100, height: 50 })
                }
              },
            },
            createElement('span', null, 'Fixed'),
          ),
        ),
      )
    })

    const controller = refA.current
    assert.ok(controller)
    const veil = controller.getElements().veil!
    assert.ok(veil.style.background.includes('51'))
    assert.equal(spy.frames[0]!.primitives[0]!.width, 100)
    // Fixed positioning resolves against viewport origin (left=240, top=350),
    // not container-local (40, 50), so veil bounds stay well above container-relative bounds (< 20).
    const veilTranslateMatch = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(veil.style.transform)
    assert.ok(veilTranslateMatch)
    assert.ok(Number.parseFloat(veilTranslateMatch[1]!) > 120)
    assert.ok(Number.parseFloat(veilTranslateMatch[2]!) > 220)

    // Switch controllerRef from refA to refB and clear material override -> reverts to theme default.
    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef: refB,
            mode: 'frosted',
            theme: 'light',
            material: undefined,
            positioning: 'fixed',
            observeResize: false,
          },
          createElement(
            GlassPrimitive,
            {
              id: 'fixed-box',
              radius: 12,
            },
            createElement('span', null, 'Fixed'),
          ),
        ),
      )
    })

    assert.equal(refA.current, null)
    assert.equal(refB.current, controller)
    assert.ok(!veil.style.background.includes('rgba(51, 102, 204'))

    await act(async () => {
      root.unmount()
    })
    assert.equal(refB.current, null)
    assert.equal(spy.getDisposedCount(), 1)
  } finally {
    await env.restore()
  }
})

test('GlassField coalesces multi-primitive updates into one render and isolates text children', async () => {
  const env = installDomEnv()
  try {
    const spy = createSpyOverlayRenderer()
    const controllerRef = createRef<GlassSurfaceController | null>()
    const containerRef = createRef<HTMLDivElement | null>()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    let setOffset!: (next: number) => void
    function Group() {
      const [offset, _setOffset] = useState(0)
      setOffset = _setOffset
      return createElement(
        Fragment,
        null,
        createElement(GlassPrimitive, {
          id: 'g-1',
          x: 10 + offset,
          y: 10,
          width: 40,
          height: 30,
          radius: 10,
        }),
        createElement(GlassPrimitive, {
          id: 'g-2',
          x: 70 + offset,
          y: 10,
          width: 40,
          height: 30,
          radius: 10,
        }),
        createElement(GlassPrimitive, {
          id: 'g-3',
          x: 130 + offset,
          y: 10,
          width: 40,
          height: 30,
          radius: 10,
        }),
      )
    }

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            containerRef,
            observeResize: false,
          },
          createElement(Group),
        ),
      )
    })

    const countBeforeGroupUpdate = spy.frames.length
    assert.equal(spy.frames[countBeforeGroupUpdate - 1]!.primitives.length, 3)

    // Updating 3 primitives within a single commit must coalesce into 1 render, not 3.
    await act(async () => {
      setOffset(50)
    })
    assert.equal(spy.frames.length, countBeforeGroupUpdate + 1)
    const batchFrame = spy.frames[spy.frames.length - 1]!
    assert.equal(batchFrame.primitives.length, 3)
    const minCx = Math.min(...batchFrame.primitives.map((p) => p.cx))
    const maxCx = Math.max(...batchFrame.primitives.map((p) => p.cx))
    assert.equal(maxCx - minCx, 120)

    // Controlled text-child updates inside GlassField must not wipe controller-managed layers.
    const controlledPrimitives = [
      {
        id: 'text-pill',
        center: { x: 80, y: 40 },
        size: { width: 120, height: 40 },
        radius: 20,
      },
    ]

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            containerRef,
            observeResize: false,
            primitives: controlledPrimitives,
          },
          'Initial label',
        ),
      )
    })

    const els = controllerRef.current!.getElements()
    const fieldContainer = containerRef.current!
    assert.equal(els.refractBackdrop!.parentNode, fieldContainer)
    assert.equal(els.veil!.parentNode, fieldContainer)
    assert.equal(els.overlayCanvas!.parentNode, fieldContainer)

    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            containerRef,
            observeResize: false,
            primitives: controlledPrimitives,
          },
          'Updated label',
        ),
      )
    })

    assert.equal(els.refractBackdrop!.parentNode, fieldContainer)
    assert.equal(els.veil!.parentNode, fieldContainer)
    assert.equal(els.overlayCanvas!.parentNode, fieldContainer)
    assert.equal(els.veil!.style.visibility, 'visible')
    assert.ok(fieldContainer.textContent?.includes('Updated label'))

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})

test('GlassField accounts for host scroll offsets and remeasures on host style/className changes', async () => {
  const env = installDomEnv()
  try {
    const spy = createSpyOverlayRenderer()
    const controllerRef = createRef<GlassSurfaceController | null>()
    const host = env.document.createElement('div')
    env.document.body.appendChild(host)
    const root = createRoot(host)

    const noShadowMaterial = {
      ...DEFAULT_OPTICAL_MATERIALS.light.frosted,
      shadowAlpha: 0,
    }

    let boxLeft = 110
    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            observeResize: false,
            blendK: 0,
            material: noShadowMaterial,
            className: 'layout-start',
            style: { justifyContent: 'flex-start' },
            containerRef: (el) => {
              if (!el) return
              Object.defineProperty(el, 'scrollLeft', { configurable: true, value: 30 })
              Object.defineProperty(el, 'scrollTop', { configurable: true, value: 45 })
              setElementRect(el, { left: 100, top: 200, width: 400, height: 300 })
            },
          },
          createElement(
            GlassPrimitive,
            {
              id: 'scrolled-box',
              radius: 12,
              elementRef: (el) => {
                if (el) {
                  setElementRect(el, { left: boxLeft, top: 220, width: 80, height: 40 })
                }
              },
            },
            createElement('span', null, 'Scrolled'),
          ),
        ),
      )
    })

    // Viewport delta is (110 - 100, 220 - 200) = (10, 20); adding scroll (30, 45) yields local (40, 65).
    // With blendK=0 and shadowAlpha=0, computeAutoSurfaceBounds uses exact 24px padding -> bounds (16, 41).
    const controllerBefore = controllerRef.current!
    const veil = controllerBefore.getElements().veil!
    const matchBefore = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(veil.style.transform)
    assert.ok(matchBefore)
    const boundsXBefore = Number.parseFloat(matchBefore[1]!)
    const boundsYBefore = Number.parseFloat(matchBefore[2]!)
    assert.equal(boundsXBefore, 16)
    assert.equal(boundsYBefore, 41)

    // Move wrapper box due to host layout change (`style` / `className`) with same size and props.
    boxLeft = 210
    await act(async () => {
      root.render(
        createElement(
          GlassField,
          {
            env: CHROME_ENV,
            overlayRenderer: spy.renderer,
            controllerRef,
            observeResize: false,
            blendK: 0,
            material: noShadowMaterial,
            className: 'layout-end',
            style: { justifyContent: 'flex-end' },
          },
          createElement(
            GlassPrimitive,
            {
              id: 'scrolled-box',
              radius: 12,
              elementRef: (el) => {
                if (el) {
                  setElementRect(el, { left: boxLeft, top: 220, width: 80, height: 40 })
                }
              },
            },
            createElement('span', null, 'Scrolled'),
          ),
        ),
      )
    })

    // Host style/className change must reuse the same controller without disposing/recreating layers.
    assert.equal(controllerRef.current, controllerBefore)
    assert.equal(spy.getDisposedCount(), 0)
    const matchAfter = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(veil.style.transform)
    assert.ok(matchAfter)
    assert.equal(Number.parseFloat(matchAfter[1]!) - boundsXBefore, 100)

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})
