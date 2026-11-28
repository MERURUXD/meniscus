/**
 * `@sessile/presets/experimental`: segmented pill and drag-merge presets.
 * Their API may change in any minor release.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  SEGMENTED_PILL_DEFAULTS,
  createSegmentedPillController,
  type SegmentItem,
  type SegmentedPillController,
  type SegmentedPillOptions,
  type SegmentedPillState,
} from '../segmented.ts'

export {
  DRAG_MERGE_DEFAULTS,
  createDragMergeController,
  type DragMergeController,
  type DragMergeLink,
  type DragMergeNodeInput,
  type DragMergeNodePatch,
  type DragMergeNodeState,
  type DragMergeOptions,
  type DragMergeState,
} from '../dragMerge.ts'
