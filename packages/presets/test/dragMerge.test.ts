import assert from 'node:assert/strict'
import test from 'node:test'
import { createDragMergeController } from '../src/index.ts'

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

  // Bounds clamp prevents leaving [40..360]
  ctrl.moveDrag({ x: 999, y: -200 })
  for (let i = 0; i < 90; i += 1) {
    ctrl.step(1 / 60)
  }
  const clampedA = ctrl.getState().nodes.find((n) => n.id === 'a')!
  assert.ok(Math.abs(clampedA.center.x - 360) < 0.1)
  assert.ok(Math.abs(clampedA.center.y - 40) < 0.1)

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
