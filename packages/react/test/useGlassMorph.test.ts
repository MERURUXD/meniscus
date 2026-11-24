/**
 * Unit tests for `useGlassMorph` covering uncontrolled/controlled transitions,
 * mid-flight reversal, low-overhead `syncState: false`, reduced motion, and React StrictMode.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { MorphTimelineState } from '@sessile/core'
import {
  useGlassMorph,
  type UseGlassMorphOptions,
  type UseGlassMorphResult,
} from '../src/useGlassMorph.ts'
import {
  createMockFrameScheduler,
  createMockMediaQueryList,
  installDomEnv,
} from './testEnv.ts'

test('useGlassMorph drives uncontrolled open/close/toggle/seek/reset and mid-flight reversal', async () => {
  const env = installDomEnv()
  try {
    const mockClock = createMockFrameScheduler()
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    let api!: UseGlassMorphResult

    function Harness() {
      api = useGlassMorph({
        scheduler: mockClock.scheduler,
        openDurationSec: 0.2,
        closeDurationSec: 0.2,
        reducedMotion: false,
      })
      return createElement('div', { 'data-phase': api.state.phase })
    }

    await act(async () => {
      root.render(createElement(Harness))
    })

    assert.equal(api.state.phase, 'closed')
    assert.equal(api.state.progress, 0)
    assert.equal(mockClock.getPendingCount(), 0)

    await act(async () => {
      api.open()
    })
    assert.equal(api.state.phase, 'opening')
    assert.equal(api.state.isAnimating, true)
    assert.equal(mockClock.getPendingCount(), 1)

    await act(async () => {
      mockClock.stepFrame(40)
    })
    const midProgress = api.state.progress
    assert.ok(midProgress > 0 && midProgress < 1, `expected midProgress in (0,1), got ${midProgress}`)
    assert.equal(api.state.phase, 'opening')

    // Interrupt opening mid-flight with close(): progress reverses from midProgress instead of snapping.
    await act(async () => {
      api.close()
    })
    assert.equal(api.state.phase, 'closing')
    assert.ok(Math.abs(api.state.progress - midProgress) < 1e-6)

    await act(async () => {
      mockClock.flushUntilIdle(25)
    })
    assert.equal(api.state.phase, 'closed')
    assert.equal(api.state.progress, 0)
    assert.equal(api.state.isAnimating, false)
    assert.equal(mockClock.getPendingCount(), 0)

    await act(async () => {
      api.toggle()
    })
    assert.equal(api.state.phase, 'opening')

    await act(async () => {
      mockClock.flushUntilIdle(25)
    })
    assert.equal(api.state.phase, 'open')
    assert.equal(api.state.progress, 1)

    await act(async () => {
      const sought = api.seek('opening', 0.5)
      assert.equal(sought.phase, 'opening')
    })
    assert.equal(api.state.phase, 'opening')
    assert.equal(mockClock.getPendingCount(), 1)

    await act(async () => {
      api.reset('closed')
    })
    assert.equal(api.state.phase, 'closed')
    assert.equal(api.state.progress, 0)
    assert.equal(mockClock.getPendingCount(), 0)

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})

test('useGlassMorph supports controlled open prop, syncState: false, and live reduced-motion', async () => {
  const env = installDomEnv()
  try {
    const mockClock = createMockFrameScheduler()
    const mql = createMockMediaQueryList(false)
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    const onFrameSamples: Array<{ state: MorphTimelineState; dt: number }> = []
    let renderCount = 0
    let api!: UseGlassMorphResult

    function ControlledHarness(props: UseGlassMorphOptions) {
      renderCount += 1
      api = useGlassMorph({
        ...props,
        scheduler: mockClock.scheduler,
        env: { matchMedia: () => mql },
        syncState: false,
        onFrame: (state, dt) => onFrameSamples.push({ state, dt }),
      })
      return createElement('div', { 'data-phase': api.state.phase })
    }

    await act(async () => {
      root.render(createElement(ControlledHarness, { open: false, openDurationSec: 0.4 }))
    })
    assert.equal(api.state.phase, 'closed')
    const rendersAtIdle = renderCount

    await act(async () => {
      root.render(createElement(ControlledHarness, { open: true, openDurationSec: 0.4 }))
    })
    assert.equal(api.state.phase, 'opening')
    const rendersAfterStart = renderCount

    // Step several intermediate ticks inside 'opening'; syncState: false should skip React re-renders.
    await act(async () => {
      mockClock.stepFrame(40)
      mockClock.stepFrame(40)
    })
    assert.equal(onFrameSamples.length, 2)
    assert.ok(api.stateRef.current.progress > 0 && api.stateRef.current.progress < 1)
    assert.equal(renderCount, rendersAfterStart)
    assert.ok(rendersAfterStart >= rendersAtIdle + 1)

    await act(async () => {
      mql.setMatches(true)
    })
    assert.equal(api.state.reducedMotion, true)

    await act(async () => {
      mockClock.flushUntilIdle(40)
    })
    assert.equal(api.state.phase, 'open')
    assert.equal(api.state.progress, 1)
    assert.equal(api.state.isAnimating, false)

    await act(async () => {
      root.unmount()
    })
  } finally {
    await env.restore()
  }
})

test('useGlassMorph remains functional across React StrictMode double invocation', async () => {
  const env = installDomEnv()
  try {
    const mockClock = createMockFrameScheduler()
    const container = env.document.createElement('div')
    env.document.body.appendChild(container)
    const root = createRoot(container)
    let api!: UseGlassMorphResult

    function StrictHarness() {
      api = useGlassMorph({
        scheduler: mockClock.scheduler,
        openDurationSec: 0.1,
        reducedMotion: false,
      })
      return createElement('div')
    }

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(StrictHarness)))
    })

    await act(async () => {
      api.open()
    })
    assert.equal(api.state.phase, 'opening')
    assert.equal(mockClock.getPendingCount(), 1)

    await act(async () => {
      mockClock.flushUntilIdle(30)
    })
    assert.equal(api.state.phase, 'open')
    assert.equal(api.state.progress, 1)

    await act(async () => {
      root.unmount()
    })
    assert.equal(mockClock.getPendingCount(), 0)
  } finally {
    await env.restore()
  }
})
