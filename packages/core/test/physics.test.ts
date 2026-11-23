/**
 * @meniscus/core unit tests for spring physics, easing math, and interruptible morph timelines.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SPRINGS } from '../src/contracts.ts'
import {
  clamp,
  createElasticPressController,
  createMorphTimeline,
  createSpringChannel,
  cubicBezier,
  easeInOutCubic,
  easeInQuad,
  easeOutCubic,
  evaluateSpring,
  evaluateSpringState,
  lerp,
  riseAndFall,
  smoothstep,
} from '../src/physics.ts'

function approx(actual: number, expected: number, eps = 1e-4, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label ? `${label}: ` : ''}expected ${actual} ≈ ${expected} (±${eps})`,
  )
}

test('math and easing utilities respect boundaries and monotonicity', () => {
  assert.equal(clamp(-5, 0, 1), 0)
  assert.equal(clamp(5, 0, 1), 1)
  assert.equal(clamp(0.4, 0, 1), 0.4)

  assert.equal(lerp(10, 20, 0), 10)
  assert.equal(lerp(10, 20, 0.5), 15)
  assert.equal(lerp(10, 20, 1.5), 25)

  assert.equal(smoothstep(0, 1, -0.2), 0)
  approx(smoothstep(0, 1, 0.5), 0.5, 1e-12)
  assert.equal(smoothstep(0, 1, 1.2), 1)
  assert.equal(smoothstep(1, 1, 0.5), 0)
  assert.equal(smoothstep(1, 1, 1), 1)

  approx(easeInQuad(0.5), 0.25, 1e-12)
  approx(easeOutCubic(0.5), 0.875, 1e-12)
  approx(easeInOutCubic(0.5), 0.5, 1e-12)
  assert.equal(cubicBezier(0.42, 0, 0.58, 1, 0), 0)
  assert.equal(cubicBezier(0.42, 0, 0.58, 1, 1), 1)
  approx(cubicBezier(0.42, 0, 0.58, 1, 0.5), 0.5, 1e-5)
})

test('riseAndFall peaks at exactly 1.0 and returns 0 for t <= 0', () => {
  const cases: Array<[number, number]> = [
    [0.098, 2.2],
    [0.069, 3.0],
    [0.072, 1.8],
    [0.176, 2.5],
  ]
  for (const [peak, sharpness] of cases) {
    assert.equal(riseAndFall(0, peak, sharpness), 0)
    assert.equal(riseAndFall(-0.05, peak, sharpness), 0)
    approx(riseAndFall(peak, peak, sharpness), 1.0, 1e-12, `peak=${peak}`)
    assert.ok(riseAndFall(peak * 0.5, peak, sharpness) < 1.0)
    assert.ok(riseAndFall(peak * 1.5, peak, sharpness) < 1.0)
  }
})

test('evaluateSpringState covers underdamped, critically damped, overdamped, and non-zero initial velocity', () => {
  const at0 = evaluateSpringState(0, DEFAULT_SPRINGS.standard)
  assert.equal(at0.value, 0)
  assert.equal(at0.velocity, 0)

  // Underdamped standard spring should overshoot and settle near 0.45s.
  const peakOpen = evaluateSpringState(0.24, DEFAULT_SPRINGS.standard)
  assert.ok(peakOpen.value > 1.02, `expected overshoot > 1.02, got ${peakOpen.value}`)
  const endOpen = evaluateSpring(0.45, DEFAULT_SPRINGS.standard)
  approx(endOpen, 1.0, 0.005, 'standard spring at 0.45s')

  // Critically damped spring must never overshoot.
  const critical = { mass: 1, stiffness: 400, dampingRatio: 1.0 }
  for (let t = 0.01; t <= 0.5; t += 0.02) {
    const s = evaluateSpringState(t, critical)
    assert.ok(s.value >= 0 && s.value <= 1.0 + 1e-9, `critical overshoot at t=${t}`)
  }

  // Overdamped spring lags behind critical damping.
  const overdamped = { mass: 1, stiffness: 400, dampingRatio: 1.5 }
  const sCrit = evaluateSpringState(0.1, critical).value
  const sOver = evaluateSpringState(0.1, overdamped).value
  assert.ok(sOver < sCrit && sOver > 0, 'overdamped should lag critical damping')

  // Non-zero initial velocity preserves initial state and direction.
  const withVel = evaluateSpringState(0.01, critical, 0.2, 10, 1)
  assert.ok(withVel.value > 0.2, 'positive initial velocity should push value forward')
  assert.equal(evaluateSpringState(0, critical, 0.2, 10, 1).velocity, 10)
})

test('createSpringChannel supports continuous re-anchoring, impulse, snap, seek, and settling', () => {
  const ch = createSpringChannel({
    params: DEFAULT_SPRINGS.standard,
    initialValue: 0,
    initialTarget: 0,
  })
  assert.equal(ch.getState().settled, true)

  ch.setTarget(1)
  assert.equal(ch.getState().settled, false)
  const mid = ch.step(0.1)
  assert.ok(mid.value > 0 && mid.velocity > 0)

  // Mid-flight target change must preserve instantaneous position and velocity.
  const beforeInterrupt = ch.getState()
  ch.setTarget(0)
  const afterInterrupt = ch.getState()
  assert.equal(afterInterrupt.value, beforeInterrupt.value)
  assert.equal(afterInterrupt.velocity, beforeInterrupt.velocity)
  assert.equal(afterInterrupt.target, 0)

  // Impulse mutates velocity immediately without moving position.
  ch.impulse(5)
  assert.equal(ch.getState().value, afterInterrupt.value)
  approx(ch.getState().velocity, afterInterrupt.velocity + 5, 1e-12)

  // Deterministic seek and step-to-settle convergence.
  ch.snap(0, 0)
  ch.setTarget(1)
  const seeked = ch.seek(0.2)
  approx(seeked.value, evaluateSpring(0.2, DEFAULT_SPRINGS.standard), 1e-6)
  for (let i = 0; i < 120; i += 1) {
    ch.step(1 / 60)
  }
  const finalState = ch.getState()
  assert.equal(finalState.settled, true)
  assert.equal(finalState.value, 1)
  assert.equal(finalState.velocity, 0)
})

test('createMorphTimeline handles open/close, mid-flight reversals, seek, and reducedMotion', () => {
  const timeline = createMorphTimeline()
  const events: string[] = []
  const unsub = timeline.subscribe((s) => events.push(s.phase))

  assert.equal(timeline.getState().phase, 'closed')
  assert.equal(timeline.getState().progress, 0)

  // Verify 70ms corner delay.
  timeline.open()
  const at50ms = timeline.step(0.05)
  assert.equal(at50ms.phase, 'opening')
  assert.ok(at50ms.progress > 0)
  assert.equal(at50ms.cornerProgress, 0, 'cornerProgress waits during 70ms delay')

  const at120ms = timeline.step(0.07)
  assert.ok(at120ms.cornerProgress > 0, 'cornerProgress advances after 70ms delay')

  // Mid-flight close() reversal preserves progress and cornerProgress without snapping.
  timeline.close()
  const closeStart = timeline.getState()
  assert.equal(closeStart.phase, 'closing')
  approx(closeStart.progress, at120ms.progress, 1e-12, 'mid-flight close preserves progress')
  approx(
    closeStart.cornerProgress,
    at120ms.cornerProgress,
    1e-12,
    'mid-flight close preserves cornerProgress',
  )

  // Smoothly decays over subsequent frame steps.
  const closeAfter16ms = timeline.step(1 / 60)
  assert.ok(Math.abs(closeAfter16ms.progress - closeStart.progress) < 0.2)

  // Mid-flight open() reversal also remains continuous.
  timeline.open()
  const reopenStart = timeline.getState()
  approx(reopenStart.progress, closeAfter16ms.progress, 1e-12, 'mid-flight reopen preserves progress')

  // Step through to open completion.
  timeline.step(0.5)
  assert.equal(timeline.getState().phase, 'open')
  assert.equal(timeline.getState().progress, 1)
  assert.equal(timeline.getState().styleMix, 1)

  // Deterministic seek.
  const seeked = timeline.seek('opening', 0.5)
  assert.equal(seeked.phase, 'opening')
  approx(seeked.normalizedT, 0.5, 1e-12)
  approx(seeked.progress, evaluateSpring(0.225, DEFAULT_SPRINGS.standard), 1e-6)

  // reducedMotion falls back to a 0.15s linear transition.
  timeline.reset('closed')
  timeline.setReducedMotion(true)
  timeline.open()
  const rmMid = timeline.step(0.075)
  assert.equal(rmMid.reducedMotion, true)
  approx(rmMid.progress, 0.5, 1e-6)
  approx(rmMid.cornerProgress, 0.5, 1e-6)
  const rmEnd = timeline.step(0.08)
  assert.equal(rmEnd.phase, 'open')
  assert.equal(rmEnd.progress, 1)

  unsub()
  const countBeforeDispose = events.length
  timeline.dispose()
  timeline.close()
  assert.equal(events.length, countBeforeDispose)
})

test('createMorphTimeline mid-flight close after brief open does not snap to closed prematurely', () => {
  const timeline = createMorphTimeline()
  timeline.open()
  timeline.step(0.03)
  timeline.close()

  let prev = timeline.getState()
  assert.equal(prev.phase, 'closing')
  assert.ok(prev.progress > 0)

  // Step 10 frames at 60Hz; the re-anchored spring must not snap to 0 around frame 4.
  for (let i = 0; i < 10; i += 1) {
    const next = timeline.step(1 / 60)
    assert.equal(next.phase, 'closing', `frame ${i + 1} must remain closing`)
    assert.ok(next.progress > 0, `frame ${i + 1} progress must stay > 0`)
    assert.ok(
      Math.abs(next.progress - prev.progress) < 0.15 && next.progress !== prev.progress,
      `frame ${i + 1} must advance smoothly without snapping`,
    )
    prev = next
  }

  // Step past the full 0.5s closeDurationSec to verify accurate settling to closed/0.
  for (let i = 0; i < 21; i += 1) {
    timeline.step(1 / 60)
  }
  const done = timeline.getState()
  assert.equal(done.phase, 'closed')
  assert.equal(done.progress, 0)
})

test('createElasticPressController handles press growth, rubber-band drag, and release rebound', () => {
  const press = createElasticPressController()
  const box = { width: 120, height: 40 }

  press.pressStart(box)
  for (let i = 0; i < 40; i += 1) press.step(1 / 60)
  const maxGrowth = Math.min(0.25, 16 / 120)
  approx(press.getState().scaleX, 1 + maxGrowth, 1e-2, 'ElasticPress max growth')

  press.pressMove({ x: 1000, y: -1000 }, box)
  for (let i = 0; i < 40; i += 1) press.step(1 / 60)
  const dragLimit = (7 / 32) * 40
  const dragMag = Math.hypot(press.getState().offsetX, press.getState().offsetY)
  assert.ok(dragMag > 0 && dragMag < dragLimit, `dragMag ${dragMag} must stay below ${dragLimit}`)

  press.pressRelease()
  for (let i = 0; i < 100; i += 1) press.step(1 / 60)
  approx(press.getState().scaleX, 1, 1e-3)
  approx(press.getState().offsetX, 0, 1e-2)
  approx(press.getState().offsetY, 0, 1e-2)

  press.setReducedMotion(true)
  press.pressStart(box)
  assert.equal(press.getState().scaleX, 1)
  assert.equal(press.getState().lift, 0)
  press.reset()
})
