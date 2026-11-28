import assert from 'node:assert/strict'
import test from 'node:test'
import { createDragMergeController } from '../src/entries/experimental.ts'

test('createDragMergeController: hitTest corner precision & stacking priority', () => {
  const ctrl = createDragMergeController({
    nodes: [
      { id: 'back', center: { x: 100, y: 100 }, size: { width: 80, height: 80 }, radius: 24 },
      { id: 'front', center: { x: 120, y: 100 }, size: { width: 80, height: 80 }, radius: 24 },
      { id: 'pinned', center: { x: 300, y: 100 }, size: { width: 60, height: 60 }, radius: 30, pinned: true },
    ],
  })

  // Overlapping point hits front node first
  assert.equal(ctrl.hitTest({ x: 110, y: 100 }), 'front')
  // Left-only point hits back node
  assert.equal(ctrl.hitTest({ x: 70, y: 100 }), 'back')
  // Point inside outer bounding box corner but outside radius=24 rounded fillet misses
  assert.equal(ctrl.hitTest({ x: 61, y: 61 }), null)
  // Pinned node hits hitTest but refuses startDrag
  assert.equal(ctrl.hitTest({ x: 300, y: 100 }), 'pinned')
  assert.equal(ctrl.startDrag('pinned', { x: 300, y: 100 }), false)
  assert.equal(ctrl.startDrag('missing', { x: 0, y: 0 }), false)
  ctrl.dispose()
})

test('createDragMergeController: grab offset, proximity bridge detection, magnetic pull, neighbor tug, and bounds clamping', () => {
  const ctrl = createDragMergeController({
    blendK: 32,
    magneticRadiusPx: 48,
    magneticStrength: 0.2,
    neighborTugRatio: 0.15,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    nodes: [
      { id: 'a', center: { x: 80, y: 150 }, size: { width: 80, height: 80 }, radius: 20 },
      { id: 'b', center: { x: 240, y: 150 }, size: { width: 80, height: 80 }, radius: 20 },
    ],
  })

  const init = ctrl.getState()
  assert.equal(init.links.length, 1)
  assert.equal(init.links[0]!.gapPx, 80)
  assert.equal(init.links[0]!.merged, false)
  assert.equal(init.links[0]!.bridgeStrength, 0)

  // Start dragging 'a' with +10px grab offset from center
  assert.equal(ctrl.startDrag('a', { x: 90, y: 150 }), true)
  // Move pointer near 'b' so surface gap enters both magnetic range (<=48) and smin neck (<=16)
  ctrl.moveDrag({ x: 162, y: 150 }) // rawTarget = (152, 150), raw gap to 'b' (240) = 240 - 152 - 80 = 8px
  const duringDrag = ctrl.getState()
  assert.equal(duringDrag.activeDragId, 'a')
  assert.equal(duringDrag.nearestCandidateId, 'b')

  const nodeA = duringDrag.nodes.find((n) => n.id === 'a')!
  const nodeB = duringDrag.nodes.find((n) => n.id === 'b')!
  assert.ok(nodeA.targetCenter.x > 152, 'magnetic pull nudges dragged node target toward neighbor')
  assert.ok(nodeB.targetCenter.x < 240, 'unpinned neighbor receives subtle elastic tug toward dragged node')

  for (let i = 0; i < 90; i += 1) {
    ctrl.step(1 / 60)
  }
  const mergedStep = ctrl.getState()
  assert.equal(mergedStep.links[0]!.merged, true)
  assert.ok(mergedStep.links[0]!.bridgeStrength > 0)

  // Bounds clamp prevents leaving [40..360] even during underdamped spring frames
  ctrl.moveDrag({ x: 999, y: -200 })
  for (let i = 0; i < 90; i += 1) {
    const stepped = ctrl.step(1 / 60)
    const steppedA = stepped.nodes.find((n) => n.id === 'a')!
    assert.ok(steppedA.center.x <= 360 + 1e-6, `frame ${i}: x=${steppedA.center.x} exceeded bounds`)
    assert.ok(steppedA.center.y >= 40 - 1e-6, `frame ${i}: y=${steppedA.center.y} fell below bounds`)
  }
  const clampedA = ctrl.getState().nodes.find((n) => n.id === 'a')!
  assert.ok(Math.abs(clampedA.center.x - 360) < 0.1)
  assert.ok(Math.abs(clampedA.center.y - 40) < 0.1)

  // Pinning active dragged node mid-drag cancels drag and restores tugged neighbors to rest base
  ctrl.moveDrag({ x: 162, y: 150 })
  for (let i = 0; i < 20; i += 1) {
    ctrl.step(1 / 60)
  }
  ctrl.updateNode('a', { pinned: true })
  const pinnedState = ctrl.getState()
  assert.equal(pinnedState.activeDragId, null)
  assert.equal(pinnedState.nodes.find((n) => n.id === 'b')!.targetCenter.x, 240)
  for (let i = 0; i < 90; i += 1) {
    ctrl.step(1 / 60)
  }
  const settledAfterPinB = ctrl.getState().nodes.find((n) => n.id === 'b')!
  assert.ok(Math.abs(settledAfterPinB.center.x - 240) < 0.1)
  ctrl.updateNode('a', { pinned: false })

  // Releasing relaxes neighbor 'b' back to its rest anchor
  ctrl.endDrag()
  for (let i = 0; i < 90; i += 1) {
    ctrl.step(1 / 60)
  }
  const settledB = ctrl.getState().nodes.find((n) => n.id === 'b')!
  assert.ok(Math.abs(settledB.center.x - 240) < 0.1)
  ctrl.dispose()
})

test('createDragMergeController: snapToNearestOnRelease, returnToRestOnRelease, cancelDrag, node mutations, and reducedMotion', () => {
  // snapToNearestOnRelease
  const snapCtrl = createDragMergeController({
    magneticRadiusPx: 48,
    snapToNearestOnRelease: true,
    nodes: [
      { id: 'a', center: { x: 80, y: 100 }, size: { width: 60, height: 60 }, radius: 16 },
      { id: 'b', center: { x: 220, y: 100 }, size: { width: 60, height: 60 }, radius: 16 },
    ],
  })
  snapCtrl.startDrag('a', { x: 80, y: 100 })
  snapCtrl.moveDrag({ x: 140, y: 100 }) // gap = 220 - 140 - 60 = 20px <= 48px
  snapCtrl.endDrag()
  for (let i = 0; i < 90; i += 1) {
    snapCtrl.step(1 / 60)
  }
  const snappedA = snapCtrl.getState().nodes.find((n) => n.id === 'a')!
  assert.ok(Math.abs(snappedA.center.x - 220) < 0.1)
  snapCtrl.dispose()

  // returnToRestOnRelease + cancelDrag + mutations + reducedMotion
  const retCtrl = createDragMergeController({
    returnToRestOnRelease: true,
    nodes: [
      { id: 'a', center: { x: 60, y: 100 }, size: { width: 60, height: 60 }, radius: 16 },
    ],
  })
  retCtrl.startDrag('a', { x: 60, y: 100 })
  retCtrl.moveDrag({ x: 260, y: 100 })
  retCtrl.endDrag()
  for (let i = 0; i < 90; i += 1) {
    retCtrl.step(1 / 60)
  }
  assert.ok(Math.abs(retCtrl.getState().nodes[0]!.center.x - 60) < 0.1)

  // cancelDrag snaps/returns to drag start origin
  retCtrl.startDrag('a', { x: 60, y: 100 })
  retCtrl.moveDrag({ x: 200, y: 200 })
  retCtrl.step(0.05)
  retCtrl.cancelDrag()
  for (let i = 0; i < 90; i += 1) {
    retCtrl.step(1 / 60)
  }
  assert.ok(Math.abs(retCtrl.getState().nodes[0]!.center.x - 60) < 0.1)
  assert.ok(Math.abs(retCtrl.getState().nodes[0]!.center.y - 100) < 0.1)

  // addNode / updateNode / removeNode
  retCtrl.addNode({ id: 'c', center: { x: 300, y: 100 }, size: { width: 40, height: 40 }, radius: 12 })
  assert.equal(retCtrl.getState().nodes.length, 2)
  retCtrl.updateNode('c', { radius: 999 })
  assert.equal(retCtrl.getState().nodes.find((n) => n.id === 'c')?.radius, 20)
  retCtrl.removeNode('c')
  assert.equal(retCtrl.getState().nodes.length, 1)

  // reducedMotion performs immediate updates with no spring animation lag
  retCtrl.setReducedMotion(true)
  retCtrl.startDrag('a', { x: 60, y: 100 })
  retCtrl.moveDrag({ x: 180, y: 120 })
  assert.deepEqual(retCtrl.getState().nodes[0]!.center, { x: 180, y: 120 })
  retCtrl.endDrag()
  assert.deepEqual(retCtrl.getState().nodes[0]!.center, { x: 60, y: 100 })
  assert.equal(retCtrl.getState().isAnimating, false)

  retCtrl.dispose()
})

test('createDragMergeController: applies velocity-driven area-preserving deformation and settles back to rest size', () => {
  const restW = 80
  const restH = 60
  const restArea = restW * restH

  const ctrl = createDragMergeController({
    velocityStretch: 0.14,
    velocityStretchReferencePxPerSec: 400,
    nodes: [
      { id: 'droplet', center: { x: 100, y: 120 }, size: { width: restW, height: restH }, radius: 20 },
      { id: 'anchor', center: { x: 350, y: 120 }, size: { width: 70, height: 70 }, radius: 35, pinned: true },
    ],
  })

  ctrl.startDrag('droplet', { x: 100, y: 120 })
  ctrl.moveDrag({ x: 320, y: 120 })
  const moving = ctrl.step(0.016)
  const dropletMoving = moving.nodes.find((n) => n.id === 'droplet')!
  const anchorPinned = moving.nodes.find((n) => n.id === 'anchor')!

  assert.equal(dropletMoving.size.width, restW)
  assert.equal(dropletMoving.size.height, restH)
  assert.ok(dropletMoving.primitive.size.width > restW, 'fast horizontal drag elongates primitive width')
  assert.ok(dropletMoving.primitive.size.height < restH, 'cross axis contracts to preserve area')
  assert.ok(
    Math.abs(dropletMoving.primitive.size.width * dropletMoving.primitive.size.height - restArea) < 1e-6,
    'moving primitive area equals nominal rest area',
  )
  assert.deepEqual(anchorPinned.primitive.size, { width: 70, height: 70 })

  ctrl.endDrag()
  for (let i = 0; i < 120; i += 1) {
    ctrl.step(1 / 60)
  }
  const settled = ctrl.getState().nodes.find((n) => n.id === 'droplet')!
  assert.equal(settled.settled, true)
  assert.deepEqual(settled.primitive.size, { width: restW, height: restH })

  // velocityStretch: 0 keeps primitive size rigid even during fast movement.
  const rigidCtrl = createDragMergeController({
    velocityStretch: 0,
    nodes: [{ id: 'a', center: { x: 100, y: 100 }, size: { width: restW, height: restH }, radius: 20 }],
  })
  rigidCtrl.startDrag('a', { x: 100, y: 100 })
  rigidCtrl.moveDrag({ x: 260, y: 100 })
  const rigidMoving = rigidCtrl.step(0.016)
  assert.deepEqual(rigidMoving.nodes[0]!.primitive.size, { width: restW, height: restH })

  ctrl.dispose()
  rigidCtrl.dispose()
})

test('createDragMergeController: aligns mid-flight hitTest, keeps stretched primitives in bounds, and isolates snapshot sizes', () => {
  // 1. Mid-flight hitTest tracks deformed silhouette (stretched width + contracted height).
  const hitCtrl = createDragMergeController({
    velocityStretch: 0.14,
    velocityStretchReferencePxPerSec: 300,
    nodes: [{ id: 'a', center: { x: 100, y: 120 }, size: { width: 80, height: 60 }, radius: 12 }],
  })
  hitCtrl.startDrag('a', { x: 100, y: 120 })
  hitCtrl.moveDrag({ x: 300, y: 120 })
  const moving = hitCtrl.step(0.016)
  const prim = moving.field.primitives[0]!
  assert.ok(prim.size.width > 80.5)
  assert.ok(prim.size.height < 59.8)
  assert.equal(
    hitCtrl.hitTest({ x: prim.center.x + prim.size.width * 0.5 - 0.1, y: prim.center.y }),
    'a',
    'hitTest must succeed just inside the stretched horizontal edge',
  )
  assert.equal(
    hitCtrl.hitTest({ x: prim.center.x, y: prim.center.y - 29.9 }),
    null,
    'hitTest must miss outside the contracted vertical edge',
  )
  hitCtrl.dispose()

  // 2. Boundary clearance keeps velocity stretch strictly inside configured bounds (X and Y).
  const xBoundCtrl = createDragMergeController({
    bounds: { x: 0, y: 0, width: 600, height: 300 },
    nodes: [{ id: 'xnode', center: { x: 150, y: 100 }, size: { width: 300, height: 60 }, radius: 16 }],
  })
  xBoundCtrl.startDrag('xnode', { x: 150, y: 100 })
  xBoundCtrl.moveDrag({ x: 160, y: 100 })
  for (let i = 0; i < 15; i += 1) {
    const s = xBoundCtrl.step(1 / 60)
    const p = s.field.primitives[0]!
    assert.ok(p.center.x - p.size.width * 0.5 >= -1e-9, `step ${i} left edge escaped bounds`)
    assert.ok(p.center.x + p.size.width * 0.5 <= 600 + 1e-9, `step ${i} right edge escaped bounds`)
  }
  xBoundCtrl.dispose()

  const yBoundCtrl = createDragMergeController({
    bounds: { x: 0, y: 0, width: 300, height: 400 },
    nodes: [{ id: 'ynode', center: { x: 150, y: 100 }, size: { width: 60, height: 200 }, radius: 16 }],
  })
  yBoundCtrl.startDrag('ynode', { x: 150, y: 100 })
  yBoundCtrl.moveDrag({ x: 150, y: 112 })
  for (let i = 0; i < 15; i += 1) {
    const s = yBoundCtrl.step(1 / 60)
    const p = s.field.primitives[0]!
    assert.ok(p.center.y - p.size.height * 0.5 >= -1e-9, `step ${i} top edge escaped bounds`)
    assert.ok(p.center.y + p.size.height * 0.5 <= 400 + 1e-9, `step ${i} bottom edge escaped bounds`)
  }
  yBoundCtrl.dispose()

  // 3. Snapshot primitive.size must be detached from internal node.size even at rest.
  const isoCtrl = createDragMergeController({
    nodes: [{ id: 'iso', center: { x: 100, y: 100 }, size: { width: 80, height: 60 }, radius: 16 }],
  })
  const snap1 = isoCtrl.getState()
  snap1.field.primitives[0]!.size.width = 999
  const snap2 = isoCtrl.getState()
  assert.equal(snap2.field.primitives[0]!.size.width, 80)
  isoCtrl.dispose()
})
