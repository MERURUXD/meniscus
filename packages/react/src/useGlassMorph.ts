/**
 * React hook driving `@meniscus/core`'s interruptible 0<->1 morph timeline with
 * `@meniscus/dom`'s clamped rAF loop and native reduced-motion detection.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  createMorphTimeline,
  type MorphTimeline,
  type MorphTimelineOptions,
  type MorphTimelinePhase,
  type MorphTimelineState,
} from '@meniscus/core'
import {
  createFrameLoop,
  type CapabilityEnv,
  type FrameLoop,
  type FrameScheduler,
} from '@meniscus/dom'
import { useReducedMotion } from './useReducedMotion.ts'

export interface UseGlassMorphOptions extends MorphTimelineOptions {
  /** Controlled open/closed target. When toggled, calls `open()` / `close()` on transition. */
  open?: boolean
  /** Capability environment override forwarded to `useReducedMotion`. */
  env?: CapabilityEnv
  /** Custom frame scheduler (useful for deterministic testing). */
  scheduler?: Partial<FrameScheduler>
  /** Maximum per-frame delta clamp in seconds passed to `createFrameLoop`. */
  maxDtSec?: number
  /** High-frequency frame callback invoked on every animation tick with `(state, dtSec)`. */
  onFrame?: (state: MorphTimelineState, dtSec: number) => void
  /**
   * Whether to sync every intermediate animation frame into React state (`true` by default).
   * Set to `false` for imperative 60/120fps DOM/canvas consumers using `onFrame` / `stateRef`,
   * while still syncing phase transitions and settled states.
   */
  syncState?: boolean
}

export interface UseGlassMorphResult {
  state: MorphTimelineState
  stateRef: RefObject<MorphTimelineState>
  open: () => void
  close: () => void
  toggle: () => void
  reset: (toPhase?: 'closed' | 'open') => void
  seek: (phase: MorphTimelinePhase, normalizedT: number) => MorphTimelineState
  getTimeline: () => MorphTimeline
}

/**
 * Manages an interruptible glass morph timeline inside React 19 with StrictMode-safe
 * frame loop scheduling and optional low-overhead imperative mode (`syncState: false`).
 */
export function useGlassMorph(options: UseGlassMorphOptions = {}): UseGlassMorphResult {
  const {
    open: controlledOpen,
    initialPhase,
    openDurationSec,
    closeDurationSec,
    cornerDelaySec,
    reducedMotionDurationSec,
    spring,
    cornerSpring,
    reducedMotion: reducedMotionOverride,
    env,
    scheduler,
    maxDtSec,
    onFrame,
    syncState = true,
  } = options

  const systemReduced = useReducedMotion(env)
  const effectiveReduced = reducedMotionOverride ?? systemReduced

  const [timeline] = useState<MorphTimeline>(() =>
    createMorphTimeline({
      initialPhase: initialPhase ?? (controlledOpen ? 'open' : 'closed'),
      openDurationSec,
      closeDurationSec,
      cornerDelaySec,
      reducedMotionDurationSec,
      spring,
      cornerSpring,
      reducedMotion: reducedMotionOverride ?? systemReduced,
    }),
  )

  const [state, setState] = useState<MorphTimelineState>(() => timeline.getState())
  const stateRef = useRef<MorphTimelineState>(state)
  const lastSyncedRef = useRef<MorphTimelineState>(state)
  const onFrameRef = useRef(onFrame)
  const syncStateRef = useRef(syncState)
  const loopRef = useRef<FrameLoop | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    onFrameRef.current = onFrame
    syncStateRef.current = syncState
  }, [onFrame, syncState])

  const syncSnapshot = useCallback((next: MorphTimelineState): void => {
    stateRef.current = next
    const last = lastSyncedRef.current
    if (
      syncStateRef.current ||
      last.phase !== next.phase ||
      last.isAnimating !== next.isAnimating ||
      last.reducedMotion !== next.reducedMotion
    ) {
      lastSyncedRef.current = next
      setState(next)
    }
  }, [])

  const ensureLoopRunning = useCallback((): void => {
    if (!mountedRef.current) return
    const loop = loopRef.current
    if (loop && !loop.isRunning()) {
      loop.start()
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true

    const loop = createFrameLoop(
      (dtSec) => {
        const next = timeline.step(dtSec)
        syncSnapshot(next)
        onFrameRef.current?.(next, dtSec)
        return next.isAnimating
      },
      { maxDtSec, scheduler },
    )
    loopRef.current = loop

    const unsubscribe = timeline.subscribe((next) => {
      syncSnapshot(next)
      if (next.isAnimating) {
        ensureLoopRunning()
      } else {
        loop.stop()
      }
    })

    const current = timeline.getState()
    syncSnapshot(current)
    if (current.isAnimating) {
      loop.start()
    }

    return () => {
      mountedRef.current = false
      unsubscribe()
      loop.stop()
      if (loopRef.current === loop) {
        loopRef.current = null
      }
    }
  }, [timeline, maxDtSec, scheduler, syncSnapshot, ensureLoopRunning])

  useEffect(() => {
    timeline.setReducedMotion(effectiveReduced)
  }, [timeline, effectiveReduced])

  const prevControlledOpenRef = useRef<boolean | undefined>(controlledOpen)
  useEffect(() => {
    const prev = prevControlledOpenRef.current
    prevControlledOpenRef.current = controlledOpen
    if (controlledOpen === undefined || prev === controlledOpen) {
      return
    }
    if (controlledOpen) {
      timeline.open()
    } else {
      timeline.close()
    }
  }, [controlledOpen, timeline])

  const open = useCallback(() => {
    timeline.open()
  }, [timeline])

  const close = useCallback(() => {
    timeline.close()
  }, [timeline])

  const toggle = useCallback(() => {
    const phase = timeline.getState().phase
    if (phase === 'open' || phase === 'opening') {
      timeline.close()
    } else {
      timeline.open()
    }
  }, [timeline])

  const reset = useCallback(
    (toPhase?: 'closed' | 'open') => {
      timeline.reset(toPhase)
    },
    [timeline],
  )

  const seek = useCallback(
    (phase: MorphTimelinePhase, normalizedT: number): MorphTimelineState => {
      return timeline.seek(phase, normalizedT)
    },
    [timeline],
  )

  const getTimeline = useCallback(() => timeline, [timeline])

  return useMemo(
    () => ({
      state,
      stateRef,
      open,
      close,
      toggle,
      reset,
      seek,
      getTimeline,
    }),
    [state, open, close, toggle, reset, seek, getTimeline],
  )
}
