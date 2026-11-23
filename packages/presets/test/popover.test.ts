import assert from 'node:assert/strict'
import test from 'node:test'
import {
  POPOVER_MORPH_DEFAULTS,
  computePopoverMorphGeometry,
  computePopoverTargetRect,
  createPopoverMorphController,
  createPopoverMorphSnapshot,
  evaluatePopoverMotion,
  getPopoverPhaseDurationSec,
  type PopoverAnchorConfig,
  type PopoverPanelConfig,
} from '../src/index.ts'

function approx(actual: number, expected: number, eps = 1e-4, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label ? `${label}: ` : ''}expected ${actual} ~= ${expected} (+/-${eps})`,
  )
}

test('computePopoverTargetRect: placement modes, flips, safe-insets clamping, and override', () => {
  const panel: PopoverPanelConfig = { size: { width: 220, height: 260 } }
  const viewportSize = { width: 400, height: 700 }

  // overAnchorEnd right-aligns with anchor right edge
  const endRect = computePopoverTargetRect(
    {
      anchorRect: { x: 300, y: 400, width: 48, height: 40 },
      placement: 'overAnchorEnd',
      viewportSize,
    },
    panel,
  )
  assert.equal(endRect.x, 300 + 48 - 220)
  assert.equal(endRect.y, 400 - POPOVER_MORPH_DEFAULTS.anchorOverlapY)

  // overAnchorStart clamps against screenMargin + safeInsets.left
  const startRect = computePopoverTargetRect(
    {
      anchorRect: { x: 8, y: 400, width: 48, height: 40 },
      placement: 'overAnchorStart',
      viewportSize,
      safeInsets: { top: 0, right: 0, bottom: 0, left: 10 },
    },
    panel,
  )
  assert.equal(startRect.x, 26)
  assert.equal(startRect.y, 392)

  // belowPoint flips above avoidRect when room below is insufficient
  const flippedAbove = computePopoverTargetRect(
    {
      anchorRect: { x: 100, y: 550, width: 10, height: 10 },
      avoidRect: { x: 80, y: 520, width: 100, height: 40 },
      placement: 'belowPoint',
      viewportSize,
    },
    panel,
  )
  assert.equal(flippedAbove.y, 520 - POPOVER_MORPH_DEFAULTS.avoidGap - 260)

  // abovePoint flips below avoidRect when room above is insufficient
  const flippedBelow = computePopoverTargetRect(
    {
      anchorRect: { x: 100, y: 80, width: 40, height: 40 },
      avoidRect: { x: 80, y: 70, width: 100, height: 40 },
      placement: 'abovePoint',
      viewportSize,
    },
    panel,
  )
  assert.equal(flippedBelow.y, 70 + 40 + POPOVER_MORPH_DEFAULTS.avoidGap)

  // targetRectOverride returns an un-clamped shallow clone
  const override = { x: 912, y: 42, width: 280, height: 282 }
  const resolvedOverride = computePopoverTargetRect(
    {
      anchorRect: { x: 1140, y: 12, width: 40, height: 40 },
      placement: 'belowPoint',
      viewportSize: { width: 800, height: 600 },
    },
    {
      size: { width: 280, height: 282 },
      targetRectOverride: override,
    },
  )
  assert.deepEqual(resolvedOverride, override)
  resolvedOverride.x = 0
  assert.equal(override.x, 912)
})

test('evaluatePopoverMotion: open/close envelopes, reduced motion, and point close durations', () => {
  assert.equal(getPopoverPhaseDurationSec('closed'), 0)
  assert.equal(getPopoverPhaseDurationSec('open'), 0)
  assert.equal(getPopoverPhaseDurationSec('opening', true, false), 0.45)
  assert.equal(getPopoverPhaseDurationSec('closing', true, false), 0.5)
  assert.equal(getPopoverPhaseDurationSec('closing', false, false), 0.2)
  assert.equal(getPopoverPhaseDurationSec('opening', true, true), 0.15)

  // Corner delay holds cornerProgress at 1 before 70ms
  const at50ms = evaluatePopoverMotion('opening', 0.05 / POPOVER_MORPH_DEFAULTS.openDurationSec)
  assert.equal(at50ms.cornerProgress, 1)
  approx(at50ms.bareGlassOpacity, 0.5, 1e-4)

  // Peak dip & blur bump
  const atDipPeak = evaluatePopoverMotion(
    'opening',
    POPOVER_MORPH_DEFAULTS.openDipPeakSec / POPOVER_MORPH_DEFAULTS.openDurationSec,
  )
  approx(atDipPeak.platterDipEnvelope, 1, 1e-6)
  assert.ok(atDipPeak.cornerProgress < 1)

  const atBlurPeak = evaluatePopoverMotion(
    'opening',
    POPOVER_MORPH_DEFAULTS.openBlurBumpPeakSec / POPOVER_MORPH_DEFAULTS.openDurationSec,
  )
  approx(atBlurPeak.blurBumpPx, POPOVER_MORPH_DEFAULTS.openBlurBumpAmpPx, 1e-6)

  // Closing timing checkpoints
  const at100msClose = evaluatePopoverMotion(
    'closing',
    0.1 / POPOVER_MORPH_DEFAULTS.closeDurationSec,
  )
  assert.equal(at100msClose.contentOpacity, 0)
  assert.equal(at100msClose.contentBlurPx, POPOVER_MORPH_DEFAULTS.closeContentBlurMaxPx)

  const at450msClose = evaluatePopoverMotion(
    'closing',
    0.45 / POPOVER_MORPH_DEFAULTS.closeDurationSec,
  )
  assert.equal(at450msClose.absorbed, 1)
  assert.equal(at450msClose.bareGlassOpacity, 0)

  const atEndClose = evaluatePopoverMotion('closing', 1)
  assert.equal(atEndClose.ringing, 0)
  assert.equal(atEndClose.morphProgress, 1)
})

test('computePopoverMorphGeometry: beyondRound, internal merge, bareSource, externalTrigger, and close trajectory', () => {
  const anchor: PopoverAnchorConfig = {
    anchorRect: { x: 260, y: 560, width: 96, height: 40 },
    placement: 'overAnchorEnd',
    bareSource: false,
    viewportSize: { width: 420, height: 720 },
  }
  const panel: PopoverPanelConfig = { size: { width: 220, height: 280 } }

  // Start of opening preserves beyondRound width elongation (96 - 40 = 56)
  const mStart = evaluatePopoverMotion('opening', 0)
  const gStart = computePopoverMorphGeometry(mStart, anchor, panel)
  approx(
    gStart.platter.size.width,
    POPOVER_MORPH_DEFAULTS.minPlatterScaleRatio * 40 + 56,
    1e-4,
  )
  approx(gStart.droplet.size.width, 96, 1e-4)
  assert.equal(gStart.blendK, POPOVER_MORPH_DEFAULTS.dropletBlendK)
  assert.equal(gStart.field.primitives.length, 2)

  // Open resting state settles cleanly into merged card
  const mOpen = evaluatePopoverMotion('open', 1)
  const gOpen = computePopoverMorphGeometry(mOpen, anchor, panel)
  assert.equal(gOpen.isMerged, true)
  assert.ok(gOpen.mergeDepth >= 0)
  assert.equal(gOpen.rimOpacity, 1)
  approx(gOpen.contentTransform.scale, 1, 1e-4)
  approx(gOpen.contentTransform.translateX, 0, 1e-4)
  approx(gOpen.contentTransform.translateY, 0, 1e-4)

  // bareSource inflates anchor unless inflateBareAnchor === false
  const gBare = computePopoverMorphGeometry(mStart, { ...anchor, bareSource: true }, panel)
  approx(gBare.droplet.size.width, 96 + 24, 1e-4)
  approx(gBare.droplet.size.height, 40 + 12, 1e-4)

  const gBareUninflated = computePopoverMorphGeometry(
    mStart,
    { ...anchor, bareSource: true, inflateBareAnchor: false },
    panel,
  )
  approx(gBareUninflated.droplet.size.width, 96, 1e-4)
  approx(gBareUninflated.droplet.size.height, 40, 1e-4)

  // externalTrigger pinches off cleanly at resting open state with scale 1 trigger droplet
  const extAnchor: PopoverAnchorConfig = {
    anchorRect: { x: 80, y: 120, width: 44, height: 44 },
    placement: 'belowPoint',
    externalTrigger: true,
    viewportSize: { width: 420, height: 720 },
  }
  const gExtEarly = computePopoverMorphGeometry(evaluatePopoverMotion('opening', 0.12), extAnchor, panel)
  assert.ok(gExtEarly.blendK > 0)
  assert.equal(gExtEarly.isMerged, false)

  const gExtPinched = computePopoverMorphGeometry(evaluatePopoverMotion('opening', 0.25), extAnchor, panel)
  assert.equal(gExtPinched.blendK, 0)

  const gExtOpen = computePopoverMorphGeometry(mOpen, extAnchor, panel)
  assert.equal(gExtOpen.blendK, 0)
  assert.equal(gExtOpen.rimOpacity, 1)
  approx(gExtOpen.droplet.center.x, 102, 1e-4)
  approx(gExtOpen.droplet.center.y, 142, 1e-4)
  approx(gExtOpen.droplet.size.width, 44, 1e-4)
  approx(gExtOpen.glyphTransform.scale, 1, 1e-4)

  // Point close uses single primitive field (droplet has zero size)
  const gPointClose = computePopoverMorphGeometry(
    evaluatePopoverMotion('closing', 0.5, { hasControlSource: false }),
    anchor,
    panel,
  )
  assert.equal(gPointClose.field.primitives.length, 1)
  assert.equal(gPointClose.blendK, 0)
})

test('createPopoverMorphController: lifecycle, mid-flight reversals, snapshot capture, and reduced motion', () => {
  const anchor: PopoverAnchorConfig = {
    anchorRect: { x: 260, y: 560, width: 96, height: 40 },
    placement: 'overAnchorEnd',
    viewportSize: { width: 420, height: 720 },
  }
  const panel: PopoverPanelConfig = { size: { width: 220, height: 280 } }

  const ctrl = createPopoverMorphController()
  let notifications = 0
  const unsub = ctrl.subscribe(() => {
    notifications += 1
  })

  // Opening mid-flight -> snapshot close preserves exact instantaneous geometry
  ctrl.open(true)
  const midOpen = ctrl.step(0.12)
  assert.equal(midOpen.phase, 'opening')
  const midGeom = ctrl.evaluateGeometry(anchor, panel)
  const snapshot = createPopoverMorphSnapshot(midGeom, midOpen)
  ctrl.close(snapshot)
  assert.equal(ctrl.getCloseSnapshot(), snapshot)
  const closeStart = ctrl.getState()
  approx(closeStart.contentOpacity, midOpen.contentOpacity, 1e-6)
  approx(closeStart.bareGlassOpacity, midOpen.bareGlassOpacity, 1e-6)

  const gClose0 = ctrl.evaluateGeometry(anchor, panel)
  approx(gClose0.platter.size.width, snapshot.platter.size.width, 1e-4)
  approx(gClose0.droplet.center.x, snapshot.droplet.center.x, 1e-4)

  // Re-opening during closing resumes progress cleanly without jumping back to 0
  ctrl.step(0.14)
  const midClose = ctrl.getState()
  assert.equal(midClose.phase, 'closing')
  const expectedOpenFraction = Math.min(Math.max(1 - midClose.morphProgress, 0), 0.95)
  ctrl.open(true)
  const resumed = ctrl.getState()
  assert.equal(resumed.phase, 'opening')
  approx(resumed.morphProgress, expectedOpenFraction, 0.015)
  assert.ok(resumed.elapsedSec > 0)

  // Stepping past duration settles to open
  ctrl.step(0.6)
  assert.equal(ctrl.getState().phase, 'open')
  assert.equal(ctrl.getState().isAnimating, false)

  // Point-menu close completes in 200ms
  ctrl.reset('closed')
  ctrl.open(false)
  ctrl.step(0.5)
  ctrl.close()
  assert.equal(ctrl.step(0.1).phase, 'closing')
  assert.equal(ctrl.step(0.11).phase, 'closed')

  // Reduced motion settles in 150ms and preserves crossfade on reversal
  ctrl.setReducedMotion(true)
  ctrl.open(true)
  ctrl.step(0.2)
  assert.equal(ctrl.getState().phase, 'open')
  ctrl.close()
  const rmMidClose = ctrl.step(0.06)
  assert.ok(rmMidClose.settled > 0.05 && rmMidClose.settled < 0.95)
  ctrl.open(true)
  approx(ctrl.getState().settled, rmMidClose.settled, 1e-4)

  assert.ok(notifications > 0)
  unsub()
  const countAfterUnsub = notifications
  ctrl.step(0.05)
  assert.equal(notifications, countAfterUnsub)
  ctrl.dispose()
})
