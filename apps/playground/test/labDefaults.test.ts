import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_GPU_PRIMITIVES, extractFieldContourPath } from '@meniscus/core'
import {
  DEFAULT_OPTICS_LAB_CONFIG,
  DOCK_SEGMENTS,
  POPOVER_MENU_ITEMS,
  SHOWCASE_MATERIALS,
  buildOpticsLabMaterial,
  buildOpticsLabPrimitives,
  createExtraDropletInput,
  createInitialDragMergeNodes,
} from '../src/labDefaults.ts'

test('createInitialDragMergeNodes keeps all primitives inside compact and desktop stages', () => {
  for (const stage of [
    { width: 350, height: 420 },
    { width: 820, height: 520 },
  ]) {
    const nodes = createInitialDragMergeNodes(stage)
    assert.equal(nodes.length, 4)
    assert.equal(nodes[0]?.pinned, true)
    for (const node of nodes) {
      assert.ok(node.center.x - node.size.width * 0.5 >= 0)
      assert.ok(node.center.x + node.size.width * 0.5 <= stage.width)
      assert.ok(node.center.y - node.size.height * 0.5 >= 0)
      assert.ok(node.center.y + node.size.height * 0.5 <= stage.height)
    }
  }
})

test('createExtraDropletInput stays clamped within stage bounds and keeps unique IDs beyond MAX_GPU_PRIMITIVES', () => {
  const stage = { width: 420, height: 440 }
  const seenIds = new Set<string>()
  for (let i = 1; i <= MAX_GPU_PRIMITIVES + 8; i++) {
    const drop = createExtraDropletInput(i, stage)
    assert.ok(!seenIds.has(drop.id), `Expected unique ID for index ${i}, got duplicate ${drop.id}`)
    seenIds.add(drop.id)
    assert.ok(drop.center.x - drop.size.width * 0.5 >= 0)
    assert.ok(drop.center.x + drop.size.width * 0.5 <= stage.width)
    assert.ok(drop.center.y - drop.size.height * 0.5 >= 0)
    assert.ok(drop.center.y + drop.size.height * 0.5 <= stage.height)
    assert.ok(drop.radius > 0)
  }
})

test('buildOpticsLabMaterial maps light/dark config and rim mode accurately', () => {
  const lightMat = buildOpticsLabMaterial('light', DEFAULT_OPTICS_LAB_CONFIG)
  assert.equal(lightMat.bevel, DEFAULT_OPTICS_LAB_CONFIG.bevelPx)
  assert.equal(lightMat.dispersion, DEFAULT_OPTICS_LAB_CONFIG.dispersionPx)
  assert.equal(lightMat.blur, DEFAULT_OPTICS_LAB_CONFIG.blurPx)
  assert.equal(lightMat.rimMode, 'directional')

  const darkSoft = buildOpticsLabMaterial('dark', {
    ...DEFAULT_OPTICS_LAB_CONFIG,
    rimMode: 'soft',
    rimOpacity: 0.5,
  })
  assert.equal(darkSoft.rimMode, 'soft')
  assert.equal(darkSoft.rimOpacity, 0.5)
})

test('buildOpticsLabPrimitives aligns cleanly with extractFieldContourPath across gaps', () => {
  for (const gapPx of [-16, 0, 12, 40]) {
    const primitives = buildOpticsLabPrimitives({ width: 760, height: 520 }, gapPx)
    assert.equal(primitives.length, 2)
    const path = extractFieldContourPath({
      primitives,
      blendK: DEFAULT_OPTICS_LAB_CONFIG.blendK,
    })
    assert.ok(typeof path === 'string' && path.length > 20)
  }
  assert.ok(DOCK_SEGMENTS.length >= 4)
  assert.ok(POPOVER_MENU_ITEMS.length >= 4)
})

test('showcase material keeps the chart visible through the glass and is shared across frames', () => {
  for (const theme of ['light', 'dark'] as const) {
    const mat = SHOWCASE_MATERIALS[theme]
    assert.equal(mat, SHOWCASE_MATERIALS[theme])
    assert.ok(mat.tintRgba[3] <= 0.35, `${theme} tint must stay light enough to show refraction`)
    assert.ok(mat.blur <= 1.5, `${theme} blur must not wash out the displaced backdrop`)
    assert.ok(mat.dispersion > 0)
  }

  const tinted = buildOpticsLabMaterial('light', { ...DEFAULT_OPTICS_LAB_CONFIG, tintAlpha: 0.6 })
  assert.equal(tinted.tintRgba[3], 0.6)
  assert.deepEqual(tinted.tintRgba.slice(0, 3), SHOWCASE_MATERIALS.light.tintRgba.slice(0, 3))
})
