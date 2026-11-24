/**
 * Browser capability detection, reduced-motion observation, ResizeObserver wiring,
 * and clamped requestAnimationFrame scheduling for `@sessile/dom`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { Size } from '@sessile/core'

export type SurfaceRenderMode = 'refract' | 'frosted' | 'solid'

export interface CapabilityEnv {
  userAgent?: string
  maxTouchPoints?: number
  userAgentDataBrands?: readonly { brand: string }[]
  cssSupports?: (property: string, value: string) => boolean
  matchMedia?: (query: string) => MediaQueryList | null
}

export interface SurfaceCapabilities {
  svgBackdropRefraction: boolean
  reducedMotion: boolean
  resizeObserver: boolean
  requestAnimationFrame: boolean
}

export interface FrameScheduler {
  requestAnimationFrame: (cb: FrameRequestCallback) => number
  cancelAnimationFrame: (id: number) => void
  now: () => number
}

export interface FrameLoop {
  start(): void
  stop(): void
  isRunning(): boolean
}

export interface ObserveElementResizeOptions {
  ResizeObserverCtor?: typeof ResizeObserver
  emitInitial?: boolean
}

const DEFAULT_MAX_DT_SEC = 0.05
const RESIZE_EPSILON_PX = 0.01

let cachedSvgBackdropRefraction: boolean | undefined

function resolveUserAgent(env?: CapabilityEnv): string | undefined {
  if (env && 'userAgent' in env) {
    return env.userAgent
  }
  return typeof navigator !== 'undefined' ? navigator.userAgent : undefined
}

function resolveCssSupports(
  env?: CapabilityEnv,
): ((property: string, value: string) => boolean) | undefined {
  if (env && 'cssSupports' in env) {
    return env.cssSupports
  }
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return (property: string, value: string) => CSS.supports(property, value)
  }
  return undefined
}

function resolveMatchMedia(
  env?: CapabilityEnv,
): ((query: string) => MediaQueryList | null) | undefined {
  if (env && 'matchMedia' in env) {
    return env.matchMedia
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return (query: string) => window.matchMedia(query)
  }
  if (typeof globalThis.matchMedia === 'function') {
    return (query: string) => globalThis.matchMedia(query)
  }
  return undefined
}

function resolveMaxTouchPoints(env?: CapabilityEnv): number {
  if (env && 'maxTouchPoints' in env) {
    return env.maxTouchPoints ?? 0
  }
  if (env && 'userAgent' in env) {
    return 0
  }
  return typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0
}

function resolveUserAgentDataBrands(
  env?: CapabilityEnv,
): readonly { brand: string }[] | undefined {
  if (env && 'userAgentDataBrands' in env) {
    return env.userAgentDataBrands
  }
  if (env && 'userAgent' in env) {
    return undefined
  }
  if (typeof navigator === 'undefined') {
    return undefined
  }
  return (navigator as Navigator & { userAgentData?: { brands?: readonly { brand: string }[] } })
    .userAgentData?.brands
}

function evaluateSvgBackdropRefraction(env?: CapabilityEnv): boolean {
  const ua = resolveUserAgent(env)
  const cssSupports = resolveCssSupports(env)
  if (!ua || typeof cssSupports !== 'function') {
    return false
  }

  // Only Blink/Chromium evaluates SVG <filter> graphs inside `backdrop-filter: url(#id)`
  // across live scrolling content; WebKit/Safari, all iOS/iPadOS browsers (including desktop-mode
  // Safari reporting Macintosh + maxTouchPoints > 1), and Gecko/Firefox either ignore url()
  // backdrop filters or paint static/broken regions.
  const maxTouchPoints = resolveMaxTouchPoints(env)
  const isSafari = /Safari/i.test(ua) && !/(Chrome|Chromium|Edg|OPR)/i.test(ua)
  const isIosBrowser =
    /(iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS)/i.test(ua) ||
    (/Macintosh/i.test(ua) && maxTouchPoints > 1)
  const isFirefox = /Firefox/i.test(ua)
  if (isSafari || isIosBrowser || isFirefox) {
    return false
  }

  const brands = resolveUserAgentDataBrands(env)
  if (brands && brands.length > 0 && !brands.some((b) => /Chromium/i.test(b.brand))) {
    return false
  }

  return Boolean(cssSupports('backdrop-filter', 'url(#x)'))
}

/** Resets the cached Chromium SVG backdrop-filter capability check (intended for tests). */
export function resetCapabilityCache(): void {
  cachedSvgBackdropRefraction = undefined
}

/**
 * Returns whether the current browser reliably executes SVG `backdrop-filter: url(#id)`
 * displacement refraction over live DOM content. Caches the global probe unless `env` is supplied.
 */
export function supportsSvgBackdropRefraction(env?: CapabilityEnv): boolean {
  if (env !== undefined) {
    return evaluateSvgBackdropRefraction(env)
  }
  if (cachedSvgBackdropRefraction === undefined) {
    cachedSvgBackdropRefraction = evaluateSvgBackdropRefraction()
  }
  return cachedSvgBackdropRefraction
}

/** Queries `(prefers-reduced-motion: reduce)` safely in both browser and SSR environments. */
export function prefersReducedMotion(env?: CapabilityEnv): boolean {
  const matchMedia = resolveMatchMedia(env)
  if (!matchMedia) {
    return false
  }
  return Boolean(matchMedia('(prefers-reduced-motion: reduce)')?.matches)
}

/** Subscribes to live `(prefers-reduced-motion: reduce)` changes and returns an idempotent disposer. */
export function observeReducedMotion(
  onChange: (reduced: boolean) => void,
  env?: CapabilityEnv,
): () => void {
  const matchMedia = resolveMatchMedia(env)
  if (!matchMedia) {
    return () => {}
  }

  const mql = matchMedia('(prefers-reduced-motion: reduce)')
  if (!mql) {
    return () => {}
  }

  let disposed = false
  const handleChange = (event: MediaQueryListEvent) => {
    if (disposed) return
    const matches = typeof event?.matches === 'boolean' ? event.matches : mql.matches
    onChange(Boolean(matches))
  }

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handleChange)
    return () => {
      if (disposed) return
      disposed = true
      mql.removeEventListener('change', handleChange)
    }
  }

  // Fallback for older Safari MediaQueryList instances that only implement addListener/removeListener.
  if (typeof mql.addListener === 'function') {
    mql.addListener(handleChange)
    return () => {
      if (disposed) return
      disposed = true
      mql.removeListener(handleChange)
    }
  }

  return () => {
    disposed = true
  }
}

function getGlobalRequestAnimationFrame(): ((cb: FrameRequestCallback) => number) | null {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return (cb) => window.requestAnimationFrame(cb)
  }
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame
  }
  return null
}

function getGlobalCancelAnimationFrame(): ((id: number) => void) | null {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    return (id) => window.cancelAnimationFrame(id)
  }
  if (typeof cancelAnimationFrame === 'function') {
    return cancelAnimationFrame
  }
  return null
}

/** Collects runtime capabilities required by `GlassSurfaceController`. */
export function detectSurfaceCapabilities(env?: CapabilityEnv): SurfaceCapabilities {
  return {
    svgBackdropRefraction: supportsSvgBackdropRefraction(env),
    reducedMotion: prefersReducedMotion(env),
    resizeObserver: typeof ResizeObserver === 'function',
    requestAnimationFrame: getGlobalRequestAnimationFrame() !== null,
  }
}

/**
 * Resolves the effective surface render mode after applying progressive enhancement
 * downgrades (`refract` -> `frosted` when SVG backdrop refraction is unsupported).
 */
export function resolveEffectiveRenderMode(
  requested: SurfaceRenderMode,
  capabilities: Pick<SurfaceCapabilities, 'svgBackdropRefraction' | 'reducedMotion'>,
  options?: { disableRefractOnReducedMotion?: boolean },
): SurfaceRenderMode {
  if (requested === 'solid') {
    return 'solid'
  }
  if (
    requested === 'refract' &&
    (!capabilities.svgBackdropRefraction ||
      (options?.disableRefractOnReducedMotion === true && capabilities.reducedMotion))
  ) {
    return 'frosted'
  }
  return requested
}

/** Schedules an animation frame safely in browser and SSR runtimes. */
export function scheduleAnimationFrame(
  cb: FrameRequestCallback,
  scheduler?: Partial<FrameScheduler>,
): number {
  if (scheduler?.requestAnimationFrame) {
    return scheduler.requestAnimationFrame(cb)
  }
  const raf = getGlobalRequestAnimationFrame()
  return raf ? raf(cb) : 0
}

/** Cancels a scheduled animation frame safely when `id` is non-zero. */
export function cancelAnimationFrameSafe(
  id: number,
  scheduler?: Partial<FrameScheduler>,
): void {
  if (!id) return
  if (scheduler?.cancelAnimationFrame) {
    scheduler.cancelAnimationFrame(id)
    return
  }
  const caf = getGlobalCancelAnimationFrame()
  caf?.(id)
}

/**
 * Creates a start/stop `requestAnimationFrame` driver with delta-time clamping
 * and stale-callback cancellation guards.
 */
export function createFrameLoop(
  tick: (dtSec: number, nowMs: number) => boolean | void,
  options?: { maxDtSec?: number; scheduler?: Partial<FrameScheduler> },
): FrameLoop {
  const maxDtSec =
    options?.maxDtSec !== undefined && Number.isFinite(options.maxDtSec) && options.maxDtSec > 0
      ? options.maxDtSec
      : DEFAULT_MAX_DT_SEC
  const scheduler = options?.scheduler
  const nowFn =
    scheduler?.now ??
    (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now())

  let running = false
  let rafId = 0
  let lastTsMs = 0
  let runToken = 0

  const stop = (): void => {
    if (!running && !rafId) return
    running = false
    runToken += 1
    if (rafId) {
      const idToCancel = rafId
      rafId = 0
      cancelAnimationFrameSafe(idToCancel, scheduler)
    }
  }

  const start = (): void => {
    if (running) return
    running = true
    runToken += 1
    const token = runToken
    lastTsMs = nowFn()

    const step = (nowMs: number): void => {
      if (!running || token !== runToken) {
        return
      }
      const rawDtSec = (nowMs - lastTsMs) / 1000
      const dtSec = Number.isFinite(rawDtSec) ? Math.min(maxDtSec, Math.max(0, rawDtSec)) : 0
      lastTsMs = nowMs
      rafId = 0

      const result = tick(dtSec, nowMs)
      if (token !== runToken) {
        // Tick stopped and/or started a newer loop generation; never clobber the replacement.
        return
      }
      if (!running || result === false) {
        stop()
        return
      }

      rafId = scheduleAnimationFrame(step, scheduler)
      if (!rafId) {
        // SSR / unavailable rAF: exit running state rather than leaking an unscheduled loop.
        running = false
      }
    }

    rafId = scheduleAnimationFrame(step, scheduler)
    if (!rafId) {
      running = false
    }
  }

  return {
    start,
    stop,
    isRunning: () => running,
  }
}

/**
 * Measures an element's layout border-box size in logical CSS pixels without
 * transform distortion when `ResizeObserverEntry.borderBoxSize` is available.
 */
export function measureElementBorderBox(el: Element, entry?: ResizeObserverEntry): Size {
  const box = entry?.borderBoxSize?.[0]
  if (
    box &&
    Number.isFinite(box.inlineSize) &&
    Number.isFinite(box.blockSize) &&
    (box.inlineSize > 0 || box.blockSize > 0)
  ) {
    return {
      width: Math.max(0, box.inlineSize),
      height: Math.max(0, box.blockSize),
    }
  }

  const contentRect = entry?.contentRect
  if (
    contentRect &&
    Number.isFinite(contentRect.width) &&
    Number.isFinite(contentRect.height) &&
    (contentRect.width > 0 || contentRect.height > 0)
  ) {
    return {
      width: Math.max(0, contentRect.width),
      height: Math.max(0, contentRect.height),
    }
  }

  if (typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect()
    return {
      width: Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0,
      height: Number.isFinite(rect.height) ? Math.max(0, rect.height) : 0,
    }
  }

  return { width: 0, height: 0 }
}

/**
 * Observes border-box size changes on `el`, suppressing sub-pixel jitter below 0.01px,
 * and returns an idempotent cleanup callback.
 */
export function observeElementResize(
  el: Element,
  onResize: (size: Size) => void,
  options?: ObserveElementResizeOptions,
): () => void {
  const RO =
    options?.ResizeObserverCtor ??
    (typeof ResizeObserver === 'function' ? ResizeObserver : undefined)

  let disposed = false
  let lastWidth = Number.NaN
  let lastHeight = Number.NaN

  const emitIfChanged = (size: Size): void => {
    if (disposed || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
      return
    }
    const w = Math.max(0, size.width)
    const h = Math.max(0, size.height)
    if (
      Number.isFinite(lastWidth) &&
      Number.isFinite(lastHeight) &&
      Math.abs(w - lastWidth) < RESIZE_EPSILON_PX &&
      Math.abs(h - lastHeight) < RESIZE_EPSILON_PX
    ) {
      return
    }
    lastWidth = w
    lastHeight = h
    onResize({ width: w, height: h })
  }

  if (options?.emitInitial) {
    emitIfChanged(measureElementBorderBox(el))
  }

  if (!RO) {
    return () => {
      disposed = true
    }
  }

  const observer = new RO((entries) => {
    if (disposed || entries.length === 0) return
    let matchedEntry: ResizeObserverEntry | undefined
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]?.target === el) {
        matchedEntry = entries[i]
        break
      }
    }
    emitIfChanged(measureElementBorderBox(el, matchedEntry ?? entries[0]))
  })

  observer.observe(el, { box: 'border-box' })

  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
  }
}
