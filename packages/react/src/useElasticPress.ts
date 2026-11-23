/**
 * React hook attaching `@meniscus/core`'s elastic press and rubber-band drag physics
 * to an HTML element via pointer listeners and CSS `transform`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { useEffect, useRef, type RefObject } from 'react'
import {
  createElasticPressController,
  type ElasticPressOptions,
  type Size,
  type SpringParams,
} from '@meniscus/core'
import {
  createFrameLoop,
  type CapabilityEnv,
  type FrameScheduler,
} from '@meniscus/dom'
import { useReducedMotion } from './useReducedMotion.ts'

export interface UseElasticPressOptions extends ElasticPressOptions {
  /** Enables or disables pointer listeners and transform updates (default: `true`). */
  enabled?: boolean
  /** Scale and drag displacement multiplier (default: `1`). */
  intensity?: number
  /** Attribute on the target element suppressing elastic press while morphing (default: `'data-meniscus-morphing'`). */
  ignoreAttribute?: string
  /** Attribute set on the target element while an elastic press transform is active (default: `'data-meniscus-elastic-press'`). */
  activeAttribute?: string
  /** Capability environment override forwarded to `useReducedMotion`. */
  env?: CapabilityEnv
  /** Custom frame scheduler (useful for deterministic testing). */
  scheduler?: Partial<FrameScheduler>
}

const TRANSFORM_EPS = 1e-4
const OFFSET_EPS = 0.05
const DEFAULT_IGNORE_ATTR = 'data-meniscus-morphing'
const DEFAULT_ACTIVE_ATTR = 'data-meniscus-elastic-press'

interface ElasticPressAttachment {
  el: HTMLElement | null
  enabled: boolean
  effectiveReduced: boolean
  ignoreAttribute: string
  activeAttribute: string
  spring: SpringParams | undefined
  dragTrackSec: number | undefined
  maxGrowthRatio: number | undefined
  maxGrowthPx: number | undefined
  dragMaxRatio: number | undefined
  scheduler: Partial<FrameScheduler> | undefined
  cleanup: (() => void) | null
}

function isSameAttachmentConfig(
  a: ElasticPressAttachment,
  b: Omit<ElasticPressAttachment, 'cleanup'>,
): boolean {
  return (
    a.el === b.el &&
    a.enabled === b.enabled &&
    a.effectiveReduced === b.effectiveReduced &&
    a.ignoreAttribute === b.ignoreAttribute &&
    a.activeAttribute === b.activeAttribute &&
    a.spring === b.spring &&
    a.dragTrackSec === b.dragTrackSec &&
    a.maxGrowthRatio === b.maxGrowthRatio &&
    a.maxGrowthPx === b.maxGrowthPx &&
    a.dragMaxRatio === b.dragMaxRatio &&
    a.scheduler === b.scheduler
  )
}

function attachElasticPressToElement(
  el: HTMLElement,
  config: Omit<ElasticPressAttachment, 'el' | 'cleanup'>,
  intensityRef: RefObject<number>,
): () => void {
  const {
    enabled,
    effectiveReduced,
    ignoreAttribute,
    activeAttribute,
    spring,
    dragTrackSec,
    maxGrowthRatio,
    maxGrowthPx,
    dragMaxRatio,
    scheduler,
  } = config

  const clearTransform = () => {
    if (el.hasAttribute(activeAttribute)) {
      el.style.transform = ''
      el.removeAttribute(activeAttribute)
    }
  }

  if (!enabled || effectiveReduced) {
    clearTransform()
    return () => {}
  }

  const win =
    el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null)
  const ctrl = createElasticPressController({
    spring,
    dragTrackSec,
    maxGrowthRatio,
    maxGrowthPx,
    dragMaxRatio,
    reducedMotion: effectiveReduced,
  })

  let activePointerId: number | null = null
  let listenersAttached = false
  let startX = 0
  let startY = 0
  let targetSize: Size = { width: 44, height: 44 }
  let disposed = false

  const applyFrame = (): boolean => {
    if (disposed) return false
    if (el.hasAttribute(ignoreAttribute)) {
      clearTransform()
      return false
    }

    const s = ctrl.getState()
    const scale = intensityRef.current
    const sx = 1 + (s.scaleX - 1) * scale
    const sy = 1 + (s.scaleY - 1) * scale
    const ox = s.offsetX * scale
    const oy = s.offsetY * scale

    const isIdentity =
      Math.abs(sx - 1) < TRANSFORM_EPS &&
      Math.abs(sy - 1) < TRANSFORM_EPS &&
      Math.abs(ox) < OFFSET_EPS &&
      Math.abs(oy) < OFFSET_EPS

    if (isIdentity && !s.isAnimating && activePointerId === null) {
      clearTransform()
      return false
    }

    el.setAttribute(activeAttribute, 'true')
    el.style.transform = `translate3d(${ox.toFixed(2)}px, ${oy.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
    return s.isAnimating || activePointerId !== null
  }

  const loop = createFrameLoop(
    (dtSec) => {
      if (disposed) return false
      if (dtSec > 0) {
        ctrl.step(dtSec)
      }
      return applyFrame()
    },
    { scheduler },
  )

  const detachWindowListeners = () => {
    if (!listenersAttached || !win) return
    listenersAttached = false
    win.removeEventListener('pointermove', onWindowMove)
    win.removeEventListener('pointerup', onWindowEnd)
    win.removeEventListener('pointercancel', onWindowEnd)
    win.removeEventListener('blur', onWindowEnd)
  }

  const releasePointer = () => {
    if (activePointerId === null) return
    activePointerId = null
    detachWindowListeners()
    ctrl.pressRelease()
    loop.start()
    if (!loop.isRunning()) {
      clearTransform()
    }
  }

  const onWindowMove = (e: Event) => {
    const pe = e as PointerEvent
    if (pe.pointerId !== activePointerId) return
    ctrl.pressMove({ x: pe.clientX - startX, y: pe.clientY - startY }, targetSize)
    if (!loop.isRunning()) {
      loop.start()
    }
  }

  const onWindowEnd = (e: Event) => {
    if ('pointerId' in e && (e as PointerEvent).pointerId !== activePointerId) {
      return
    }
    releasePointer()
  }

  const onPointerDown = (e: Event) => {
    const pe = e as PointerEvent
    if (disposed) return
    if (pe.pointerType === 'mouse' && pe.button !== 0) return
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return
    if (el.hasAttribute(ignoreAttribute)) return

    // Release any previous stuck pointer before tracking the new active pointer.
    if (activePointerId !== null) {
      releasePointer()
    }

    // Measure unscaled layout box when available to prevent compound magnification across clicks.
    const rect = el.getBoundingClientRect()
    targetSize = {
      width: Math.max(1, el.offsetWidth || rect.width),
      height: Math.max(1, el.offsetHeight || rect.height),
    }
    startX = pe.clientX
    startY = pe.clientY
    activePointerId = pe.pointerId

    if (win && !listenersAttached) {
      listenersAttached = true
      win.addEventListener('pointermove', onWindowMove, { passive: true })
      win.addEventListener('pointerup', onWindowEnd)
      win.addEventListener('pointercancel', onWindowEnd)
      win.addEventListener('blur', onWindowEnd)
    }

    ctrl.pressStart(targetSize)
    applyFrame()
    if (!loop.isRunning()) {
      loop.start()
    }
  }

  el.addEventListener('pointerdown', onPointerDown)
  return () => {
    disposed = true
    el.removeEventListener('pointerdown', onPointerDown)
    activePointerId = null
    detachWindowListeners()
    loop.stop()
    clearTransform()
    ctrl.reset()
  }
}

/**
 * Drives spring-based press inflation and rubber-band pointer tracking on `targetRef`
 * using GPU-composited `translate3d`/`scale` transforms only.
 * The hook owns inline `element.style.transform` while active; apply layout positioning
 * transforms on an outer wrapper when combining with static translations or rotations.
 */
export function useElasticPress(
  targetRef: RefObject<HTMLElement | null>,
  options: UseElasticPressOptions = {},
): void {
  const {
    enabled = true,
    intensity = 1,
    spring,
    dragTrackSec,
    maxGrowthRatio,
    maxGrowthPx,
    dragMaxRatio,
    reducedMotion: reducedMotionOverride,
    ignoreAttribute = DEFAULT_IGNORE_ATTR,
    activeAttribute = DEFAULT_ACTIVE_ATTR,
    env,
    scheduler,
  } = options

  const systemReduced = useReducedMotion(env)
  const effectiveReduced = reducedMotionOverride ?? systemReduced

  const intensityRef = useRef(intensity)
  const attachmentRef = useRef<ElasticPressAttachment | null>(null)

  useEffect(() => {
    intensityRef.current = intensity
  }, [intensity])

  // Inspect targetRef.current on each commit so conditional mounting or node replacement attaches cleanly.
  useEffect(() => {
    const nextConfig: Omit<ElasticPressAttachment, 'cleanup'> = {
      el: targetRef.current,
      enabled,
      effectiveReduced,
      ignoreAttribute,
      activeAttribute,
      spring,
      dragTrackSec,
      maxGrowthRatio,
      maxGrowthPx,
      dragMaxRatio,
      scheduler,
    }
    const current = attachmentRef.current
    if (current && isSameAttachmentConfig(current, nextConfig)) {
      return
    }

    current?.cleanup?.()
    const cleanup = nextConfig.el
      ? attachElasticPressToElement(nextConfig.el, nextConfig, intensityRef)
      : null
    attachmentRef.current = {
      ...nextConfig,
      cleanup,
    }
  })

  useEffect(() => {
    return () => {
      attachmentRef.current?.cleanup?.()
      attachmentRef.current = null
    }
  }, [])
}
