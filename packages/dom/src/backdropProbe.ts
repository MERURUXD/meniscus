/**
 * Backdrop telemetry probes for adaptive legibility.
 *
 * Probes never read rendered pixels of the page: no screenshots, no DOM cloning, no CORS
 * bypass. They aggregate telemetry the host already owns (precomputed per element, or measured
 * from a same-origin / CORS-approved image it decodes itself) over the glass rect, which is
 * enough for the global material response; per-pixel compression happens in the live filter.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  TELEMETRY_STRIDE,
  measureTelemetryGrid,
  type BackdropTelemetry,
  type BackdropTelemetryAccumulator,
  type BackdropTelemetryGrid,
  type Rect,
} from '@sessile/core'

/** Plugin contract the surface controller samples while legibility is active. */
export interface BackdropProbe {
  /**
   * Adds area-weighted telemetry for the viewport-space `rect` into `acc`. Called in the read
   * phase of an animation frame, before the controller writes styles, so layout reads are clean.
   */
  sample(rect: Rect, acc: BackdropTelemetryAccumulator): void
  /** Subscribes to "the backdrop under the glass may have changed" (scroll, resize, content). */
  observe?(invalidate: () => void): () => void
}

export interface RegionProbe extends BackdropProbe {
  /** Registers or replaces telemetry for `element`; a grid maps cells onto its border box. */
  set(element: Element, telemetry: BackdropTelemetry | BackdropTelemetryGrid): void
  delete(element: Element): void
  clear(): void
  /** Signals a content change the probe cannot observe itself (e.g. a swapped image). */
  invalidate(): void
}

export interface RegionProbeOptions {
  /** Telemetry for the part of a rect no registered region covers, such as the page background. */
  background?: BackdropTelemetry | null
  /**
   * Target for `scroll` (capture phase, so nested scrollers count) and `resize` listeners.
   * Defaults to the global `document` / `window`; `null` disables automatic invalidation.
   */
  eventTarget?: EventTarget | null
}

function isGrid(t: BackdropTelemetry | BackdropTelemetryGrid): t is BackdropTelemetryGrid {
  return (t as BackdropTelemetryGrid).data !== undefined
}

/** Creates a probe that aggregates host-registered element telemetry under the glass rect. */
export function createRegionProbe(options: RegionProbeOptions = {}): RegionProbe {
  const regions = new Map<Element, BackdropTelemetry | BackdropTelemetryGrid>()
  const listeners = new Set<() => void>()
  const background = options.background ?? null
  const eventTarget =
    'eventTarget' in options
      ? (options.eventTarget ?? null)
      : typeof document !== 'undefined'
        ? document
        : null
  const resizeTarget =
    'eventTarget' in options ? eventTarget : typeof window !== 'undefined' ? window : null

  const notify = (): void => {
    for (const fn of listeners) fn()
  }
  const scrollOptions: AddEventListenerOptions = { capture: true, passive: true }

  return {
    sample(rect, acc) {
      const area = Math.max(0, rect.width) * Math.max(0, rect.height)
      if (area <= 0) return
      const rx1 = rect.x + rect.width
      const ry1 = rect.y + rect.height
      let covered = 0
      for (const [element, telemetry] of regions) {
        const box = element.getBoundingClientRect()
        const ox = Math.min(rx1, box.right) - Math.max(rect.x, box.left)
        const oy = Math.min(ry1, box.bottom) - Math.max(rect.y, box.top)
        if (ox <= 0 || oy <= 0 || box.width <= 0 || box.height <= 0) continue
        covered += ox * oy
        if (!isGrid(telemetry)) {
          acc.add(telemetry, ox * oy)
          continue
        }
        const cw = box.width / telemetry.cols
        const ch = box.height / telemetry.rows
        const c0 = Math.max(0, Math.floor((Math.max(rect.x, box.left) - box.left) / cw))
        const c1 = Math.min(telemetry.cols - 1, Math.floor((Math.min(rx1, box.right) - box.left) / cw))
        const r0 = Math.max(0, Math.floor((Math.max(rect.y, box.top) - box.top) / ch))
        const r1 = Math.min(telemetry.rows - 1, Math.floor((Math.min(ry1, box.bottom) - box.top) / ch))
        for (let r = r0; r <= r1; r++) {
          const top = box.top + r * ch
          const cy = Math.min(ry1, top + ch) - Math.max(rect.y, top)
          if (cy <= 0) continue
          for (let c = c0; c <= c1; c++) {
            const left = box.left + c * cw
            const cx = Math.min(rx1, left + cw) - Math.max(rect.x, left)
            if (cx <= 0) continue
            acc.addRecord(telemetry.data, (r * telemetry.cols + c) * TELEMETRY_STRIDE, cx * cy)
          }
        }
      }
      if (background && covered < area) {
        acc.add(background, area - covered)
      }
    },
    observe(invalidate) {
      if (listeners.size === 0) {
        eventTarget?.addEventListener('scroll', notify, scrollOptions)
        resizeTarget?.addEventListener('resize', notify)
      }
      listeners.add(invalidate)
      return () => {
        listeners.delete(invalidate)
        if (listeners.size === 0) {
          eventTarget?.removeEventListener('scroll', notify, scrollOptions)
          resizeTarget?.removeEventListener('resize', notify)
        }
      }
    },
    set(element, telemetry) {
      regions.set(element, telemetry)
      notify()
    },
    delete(element) {
      if (regions.delete(element)) notify()
    },
    clear() {
      regions.clear()
      notify()
    },
    invalidate: notify,
  }
}

export interface MeasureImageTelemetryOptions {
  cols?: number
  rows?: number
  /** Downsampled measurement width in px (defaults to `64`); height follows `aspect`. */
  sampleWidth?: number
  /** Source height / width (defaults to `1`). */
  aspect?: number
  document?: Document
}

/**
 * Measures a telemetry grid from an image, canvas or video frame the page may already read.
 * Returns `null` when the browser taints the canvas (cross-origin without CORS approval):
 * the probe then simply has no telemetry for that element instead of bypassing the policy.
 */
export function measureImageTelemetry(
  source: CanvasImageSource,
  options: MeasureImageTelemetryOptions = {},
): BackdropTelemetryGrid | null {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : null)
  if (!doc) return null
  const width = Math.max(1, Math.round(options.sampleWidth ?? 64))
  const height = Math.max(1, Math.round(width * (options.aspect ?? 1)))
  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(source, 0, 0, width, height)
    const pixels = ctx.getImageData(0, 0, width, height).data
    return measureTelemetryGrid(pixels, width, height, options.cols ?? 4, options.rows ?? 6)
  } catch {
    return null
  }
}
