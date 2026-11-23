/**
 * @meniscus/core 弹簧物理、缓动数学与可打断形变时间线单元测试。
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

test('数学与缓动工具函数边界与单调性', () => {
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

test('riseAndFall 在峰值处精确为 1.0 且 t <= 0 时为 0', () => {
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

test('evaluateSpringState 覆盖欠阻尼、临界阻尼、过阻尼与非零初速度', () => {
  const at0 = evaluateSpringState(0, DEFAULT_SPRINGS.standard)
  assert.equal(at0.value, 0)
  assert.equal(at0.velocity, 0)

  // 欠阻尼弹簧应出现过冲并在 0.45s 附近收敛
  const peakOpen = evaluateSpringState(0.24, DEFAULT_SPRINGS.standard)
  assert.ok(peakOpen.value > 1.02, `expected overshoot > 1.02, got ${peakOpen.value}`)
  const endOpen = evaluateSpring(0.45, DEFAULT_SPRINGS.standard)
  approx(endOpen, 1.0, 0.005, 'standard spring at 0.45s')

  // 临界阻尼永不过冲
  const critical = { mass: 1, stiffness: 400, dampingRatio: 1.0 }
  for (let t = 0.01; t <= 0.5; t += 0.02) {
    const s = evaluateSpringState(t, critical)
    assert.ok(s.value >= 0 && s.value <= 1.0 + 1e-9, `critical overshoot at t=${t}`)
  }

  // 过阻尼收敛慢于临界阻尼
  const overdamped = { mass: 1, stiffness: 400, dampingRatio: 1.5 }
  const sCrit = evaluateSpringState(0.1, critical).value
  const sOver = evaluateSpringState(0.1, overdamped).value
  assert.ok(sOver < sCrit && sOver > 0, 'overdamped should lag critical damping')

  // 非零初速度保持初值与方向连续
  const withVel = evaluateSpringState(0.01, critical, 0.2, 10, 1)
  assert.ok(withVel.value > 0.2, 'positive initial velocity should push value forward')
  assert.equal(evaluateSpringState(0, critical, 0.2, 10, 1).velocity, 10)
})

test('createSpringChannel 支持无跳变重锚定、impulse、snap、seek 与收敛', () => {
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

  // 飞行中途修改目标：位置与速度瞬间完全连续
  const beforeInterrupt = ch.getState()
  ch.setTarget(0)
  const afterInterrupt = ch.getState()
  assert.equal(afterInterrupt.value, beforeInterrupt.value)
  assert.equal(afterInterrupt.velocity, beforeInterrupt.velocity)
  assert.equal(afterInterrupt.target, 0)

  // 施加脉冲应立刻改变速度但位置不变
  ch.impulse(5)
  assert.equal(ch.getState().value, afterInterrupt.value)
  approx(ch.getState().velocity, afterInterrupt.velocity + 5, 1e-12)

  // seek 确定性跳转与步进收敛
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

test('createMorphTimeline 正常开合、飞行中途反向打断无突变、seek 与 reducedMotion', () => {
  const timeline = createMorphTimeline()
  const events: string[] = []
  const unsub = timeline.subscribe((s) => events.push(s.phase))

  assert.equal(timeline.getState().phase, 'closed')
  assert.equal(timeline.getState().progress, 0)

  // 70ms 圆角延迟验证
  timeline.open()
  const at50ms = timeline.step(0.05)
  assert.equal(at50ms.phase, 'opening')
  assert.ok(at50ms.progress > 0)
  assert.equal(at50ms.cornerProgress, 0, 'cornerProgress waits during 70ms delay')

  const at120ms = timeline.step(0.07)
  assert.ok(at120ms.cornerProgress > 0, 'cornerProgress advances after 70ms delay')

  // 飞行中途打断反向 close()：位置无突变
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

  // 小步进后继续平滑回落
  const closeAfter16ms = timeline.step(1 / 60)
  assert.ok(Math.abs(closeAfter16ms.progress - closeStart.progress) < 0.2)

  // 反向再次打断 open()：同样连续无突变
  timeline.open()
  const reopenStart = timeline.getState()
  approx(reopenStart.progress, closeAfter16ms.progress, 1e-12, 'mid-flight reopen preserves progress')

  // 步进至完成 open
  timeline.step(0.5)
  assert.equal(timeline.getState().phase, 'open')
  assert.equal(timeline.getState().progress, 1)
  assert.equal(timeline.getState().styleMix, 1)

  // 确定性 seek
  const seeked = timeline.seek('opening', 0.5)
  assert.equal(seeked.phase, 'opening')
  approx(seeked.normalizedT, 0.5, 1e-12)
  approx(seeked.progress, evaluateSpring(0.225, DEFAULT_SPRINGS.standard), 1e-6)

  // reducedMotion 退化为 0.15s 线性平滑过渡
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

test('createElasticPressController 按压放大、橡胶带拖拽与松手回弹', () => {
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
