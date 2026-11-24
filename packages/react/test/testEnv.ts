/**
 * Shared `happy-dom` and deterministic rAF scheduler test utilities for `@sessile/react`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { FrameScheduler } from '@sessile/dom'
import { Window as HappyWindow } from 'happy-dom'

export interface DomTestEnv {
  window: HappyWindow
  document: Document
  restore(): Promise<void>
}

/** Installs an isolated `happy-dom` window/document onto `globalThis` with React 19 `act` enabled. */
export function installDomEnv(url = 'https://sessile.test/'): DomTestEnv {
  const win = new HappyWindow({ url })
  const saved = new Map<PropertyKey, PropertyDescriptor | undefined>()

  const globals: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLDivElement: win.HTMLDivElement,
    HTMLCanvasElement: win.HTMLCanvasElement,
    SVGElement: win.SVGElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    PointerEvent: win.PointerEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    ResizeObserver: win.ResizeObserver,
    DOMRect: win.DOMRect,
    getComputedStyle: win.getComputedStyle.bind(win),
  }

  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    })
  }

  return {
    window: win,
    document: win.document as unknown as Document,
    async restore(): Promise<void> {
      for (const [key, descriptor] of saved.entries()) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor)
        } else {
          delete (globalThis as Record<PropertyKey, unknown>)[key]
        }
      }
      await win.close()
    },
  }
}

/** Mock MediaQueryList helper supporting both modern and legacy listener signatures. */
export function createMockMediaQueryList(initialMatches: boolean): MediaQueryList & {
  setMatches(next: boolean): void
  getListenerCount(): number
} {
  let matches = initialMatches
  const modernListeners = new Set<(e: MediaQueryListEvent) => void>()
  const legacyListeners = new Set<(e: MediaQueryListEvent) => void>()

  const mql = {
    media: '(prefers-reduced-motion: reduce)',
    get matches() {
      return matches
    },
    onchange: null,
    addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
      if (type !== 'change') return
      if (typeof cb === 'function') {
        modernListeners.add(cb as (e: MediaQueryListEvent) => void)
      }
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
      if (type !== 'change') return
      if (typeof cb === 'function') {
        modernListeners.delete(cb as (e: MediaQueryListEvent) => void)
      }
    },
    addListener(cb: (e: MediaQueryListEvent) => void) {
      legacyListeners.add(cb)
    },
    removeListener(cb: (e: MediaQueryListEvent) => void) {
      legacyListeners.delete(cb)
    },
    dispatchEvent() {
      return true
    },
    setMatches(next: boolean) {
      matches = next
      const event = { matches: next, media: mql.media } as MediaQueryListEvent
      for (const cb of [...modernListeners]) cb(event)
      for (const cb of [...legacyListeners]) cb(event)
    },
    getListenerCount() {
      return modernListeners.size + legacyListeners.size
    },
  }

  return mql as unknown as MediaQueryList & {
    setMatches(next: boolean): void
    getListenerCount(): number
  }
}

export interface MockFrameScheduler {
  scheduler: FrameScheduler
  stepFrame(dtMs?: number): boolean
  flushUntilIdle(dtMs?: number, maxFrames?: number): number
  getPendingCount(): number
}

/** Creates a deterministic queue-backed `FrameScheduler` controlled manually from tests. */
export function createMockFrameScheduler(startNowMs = 1000): MockFrameScheduler {
  let nowMs = startNowMs
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()

  const scheduler: FrameScheduler = {
    requestAnimationFrame(cb) {
      const id = nextId++
      callbacks.set(id, cb)
      return id
    },
    cancelAnimationFrame(id) {
      callbacks.delete(id)
    },
    now() {
      return nowMs
    },
  }

  const stepFrame = (dtMs = 16): boolean => {
    const batch = [...callbacks.entries()]
    if (batch.length === 0) return false
    callbacks.clear()
    nowMs += dtMs
    for (const [, cb] of batch) {
      cb(nowMs)
    }
    return true
  }

  const flushUntilIdle = (dtMs = 16, maxFrames = 300): number => {
    let executed = 0
    while (executed < maxFrames && callbacks.size > 0) {
      stepFrame(dtMs)
      executed += 1
    }
    return executed
  }

  return {
    scheduler,
    stepFrame,
    flushUntilIdle,
    getPendingCount: () => callbacks.size,
  }
}
