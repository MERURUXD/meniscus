import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateFieldDistance } from '@sessile/core'
import { createSegmentedPillController, type SegmentItem } from '../src/entries/experimental.ts'

const TABS: SegmentItem[] = [
  { id: 'overview', rect: { x: 8, y: 8, width: 84, height: 36 } },
  { id: 'physics', rect: { x: 96, y: 8, width: 96, height: 36 } },
  { id: 'optics', rect: { x: 196, y: 8, width: 88, height: 36 } },
]

test('createSegmentedPillController: rest single primitive transitions into 2-lobe smin stretch and settles', () => {
  const ctrl = createSegmentedPillController({
    segments: TABS,
    initialActiveId: 'overview',
  })

  const rest = ctrl.getState()
  assert.equal(rest.activeId, 'overview')
  assert.equal(rest.isAnimating, false)
  assert.equal(rest.field.blendK, 0)
  assert.equal(rest.field.primitives.length, 1)
  assert.deepEqual(rest.primitive?.center, { x: 50, y: 26 })
  assert.deepEqual(rest.primitive?.size, { width: 84, height: 36 })
  assert.equal(rest.primitive?.radius, 18)

  // Activate third tab so lead outruns trail and opens smin bridge
  ctrl.setActive('optics')
  const early = ctrl.step(0.04)
  assert.equal(early.activeId, 'optics')
  assert.equal(early.isAnimating, true)
  assert.equal(early.field.primitives.length, 2)
  assert.ok(early.field.blendK > 0)
  assert.ok(early.stretchRatio > 0)

  const [lead, trail] = early.field.primitives
  assert.ok(lead && trail)
  assert.ok(lead.center.x > trail.center.x, 'lead lobe must travel ahead of trailing tail')
  assert.ok(trail.size.height < 36, 'cross-axis squeeze should subtly narrow the trailing tail')

  // Stepping until settled collapses cleanly back to 1 crisp primitive at target
  for (let i = 0; i < 120; i += 1) {
    ctrl.step(1 / 60)
  }
  const settled = ctrl.getState()
  assert.equal(settled.isAnimating, false)
  assert.equal(settled.field.blendK, 0)
  assert.equal(settled.field.primitives.length, 1)
  assert.ok(Math.abs((settled.primitive?.center.x ?? 0) - 240) < 0.1)
  assert.ok(Math.abs((settled.primitive?.size.width ?? 0) - 88) < 0.1)
  ctrl.dispose()
})

test('createSegmentedPillController: mid-flight retargeting preserves instantaneous position without snapping', () => {
  const ctrl = createSegmentedPillController({
    segments: TABS,
    initialActiveId: 'overview',
  })

  ctrl.setActive('optics')
  const beforeSwitch = ctrl.step(0.05)
  const cxBefore = beforeSwitch.primitive!.center.x
  assert.ok(cxBefore > 50 && cxBefore < 240)

  ctrl.setActive('physics')
  const immediatelyAfter = ctrl.getState()
  assert.equal(immediatelyAfter.activeId, 'physics')
  assert.equal(immediatelyAfter.primitive!.center.x, cxBefore)

  for (let i = 0; i < 120; i += 1) {
    ctrl.step(1 / 60)
  }
  const end = ctrl.getState()
  assert.equal(end.activeId, 'physics')
  assert.ok(Math.abs(end.primitive!.center.x - 144) < 0.1)
  ctrl.dispose()
})

test('createSegmentedPillController: handles setSegments resize, snapTo, reducedMotion, and empty/unknown guards', () => {
  const ctrl = createSegmentedPillController({
    segments: TABS,
    initialActiveId: 'overview',
  })

  // Unknown id is a safe no-op
  ctrl.setActive('missing')
  assert.equal(ctrl.getState().activeId, 'overview')

  // snapTo jumps immediately with zero animation
  ctrl.snapTo('optics')
  const snapped = ctrl.getState()
  assert.equal(snapped.activeId, 'optics')
  assert.equal(snapped.isAnimating, false)
  assert.equal(snapped.field.primitives.length, 1)
  assert.equal(snapped.primitive?.center.x, 240)

  // Reduced motion disables liquid trail and snaps on setActive
  ctrl.setReducedMotion(true)
  ctrl.setActive('overview')
  const rmState = ctrl.getState()
  assert.equal(rmState.reducedMotion, true)
  assert.equal(rmState.isAnimating, false)
  assert.equal(rmState.field.primitives.length, 1)
  assert.equal(rmState.field.blendK, 0)
  assert.equal(rmState.primitive?.center.x, 50)

  // Resizing segments updates active geometry cleanly
  ctrl.setSegments([
    { id: 'overview', rect: { x: 12, y: 12, width: 120, height: 40 }, radius: 12 },
  ])
  const resized = ctrl.getState()
  assert.equal(resized.primitive?.center.x, 72)
  assert.equal(resized.primitive?.size.width, 120)
  assert.equal(resized.primitive?.radius, 12)

  // Empty segments produce null primitive and empty field
  ctrl.setSegments([])
  const empty = ctrl.getState()
  assert.equal(empty.activeId, null)
  assert.equal(empty.primitive, null)
  assert.equal(empty.field.primitives.length, 0)

  // Repopulating recovers cleanly
  ctrl.setSegments(TABS)
  assert.equal(ctrl.getState().activeId, 'overview')
  assert.equal(ctrl.getState().field.primitives.length, 1)

  ctrl.dispose()
})

test('createSegmentedPillController: diagonal jump with large maxStretchPx preserves continuous smin bridge', () => {
  const diagCtrl = createSegmentedPillController({
    maxStretchPx: 80,
    segments: [
      { id: 'a', rect: { x: 0, y: 0, width: 120, height: 24 } },
      { id: 'b', rect: { x: 1000, y: 1000, width: 120, height: 24 } },
    ],
    initialActiveId: 'a',
  })

  diagCtrl.setActive('b')
  for (let i = 0; i < 12; i += 1) {
    const frame = diagCtrl.step(1 / 60)
    if (frame.field.primitives.length === 2) {
      const [lead, trail] = frame.field.primitives
      const midX = (lead!.center.x + trail!.center.x) * 0.5
      const midY = (lead!.center.y + trail!.center.y) * 0.5
      const midDist = evaluateFieldDistance(midX, midY, frame.field)
      assert.ok(midDist <= 0, `frame ${i}: bridge split at midpoint with SDF distance=${midDist}`)
    }
  }
  diagCtrl.dispose()
})

test('createSegmentedPillController: enforces exact 2D area conservation across horizontal, vertical, and diagonal travel', () => {
  const equalSegments: SegmentItem[] = [
    { id: 'tl', rect: { x: 0, y: 0, width: 90, height: 36 } },
    { id: 'tr', rect: { x: 180, y: 0, width: 90, height: 36 } },
    { id: 'bl', rect: { x: 0, y: 90, width: 90, height: 36 } },
    { id: 'diag', rect: { x: 180, y: 180, width: 90, height: 36 } },
  ]
  const expectedArea = 90 * 36
  const ctrl = createSegmentedPillController({
    segments: equalSegments,
    initialActiveId: 'tl',
    squeezeRatio: 0.16,
  })

  // Horizontal travel elongates width and narrows height while preserving exact 2D area on both lobes.
  ctrl.setActive('tr')
  const hFrame = ctrl.step(0.03)
  assert.equal(hFrame.field.primitives.length, 2)
  const [hLead, hTrail] = hFrame.field.primitives
  assert.ok(hLead!.size.width > 90 && hLead!.size.height < 36)
  assert.ok(hTrail!.size.width > 90 && hTrail!.size.height < 36)
  assert.ok(Math.abs(hLead!.size.width * hLead!.size.height - expectedArea) < 1e-6)
  assert.ok(Math.abs(hTrail!.size.width * hTrail!.size.height - expectedArea) < 1e-6)

  // Vertical travel elongates height and narrows width with exact 2D area conservation.
  ctrl.snapTo('tl')
  ctrl.setActive('bl')
  const vFrame = ctrl.step(0.03)
  assert.equal(vFrame.field.primitives.length, 2)
  const [vLead, vTrail] = vFrame.field.primitives
  assert.ok(vLead!.size.height > 36 && vLead!.size.width < 90)
  assert.ok(vTrail!.size.height > 36 && vTrail!.size.width < 90)
  assert.ok(Math.abs(vLead!.size.width * vLead!.size.height - expectedArea) < 1e-6)
  assert.ok(Math.abs(vTrail!.size.width * vTrail!.size.height - expectedArea) < 1e-6)

  // Diagonal 45-degree jump keeps exact 2D area conservation without artificial axis bias.
  ctrl.snapTo('tl')
  ctrl.setActive('diag')
  const dFrame = ctrl.step(0.03)
  assert.equal(dFrame.field.primitives.length, 2)
  const [dLead, dTrail] = dFrame.field.primitives
  assert.ok(Math.abs(dLead!.size.width * dLead!.size.height - expectedArea) < 1e-6)
  assert.ok(Math.abs(dTrail!.size.width * dTrail!.size.height - expectedArea) < 1e-6)

  ctrl.dispose()
})
