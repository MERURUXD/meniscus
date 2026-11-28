import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as entry0 from '../src/index.ts'
import * as entry1 from '../src/entries/experimental.ts'

/**
 * Snapshot of every runtime export per entry point. A change here is a public API change:
 * update the list on purpose and record it in CHANGELOG.md.
 */
const ENTRIES: ReadonlyArray<readonly [string, object, readonly string[]]> = [
  ['@sessile/presets', entry0, [
    'POPOVER_MORPH_DEFAULTS',
    'computePopoverMorphGeometry',
    'computePopoverTargetRect',
    'createPopoverMorphController',
    'createPopoverMorphSnapshot',
    'evaluatePopoverMotion',
    'getPopoverPhaseDurationSec',
  ]],
  ['@sessile/presets/experimental', entry1, [
    'DRAG_MERGE_DEFAULTS',
    'SEGMENTED_PILL_DEFAULTS',
    'createDragMergeController',
    'createSegmentedPillController',
  ]],
]

for (const [spec, mod, expected] of ENTRIES) {
  test(`${spec} exposes exactly the documented runtime exports`, () => {
    assert.deepEqual(Object.keys(mod).sort(), [...expected].sort())
  })
}
