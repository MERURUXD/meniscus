/**
 * Public entry point for `@meniscus/presets`.
 * Framework-agnostic interaction presets built on `@meniscus/core`.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export {
  POPOVER_MORPH_DEFAULTS,
  computePopoverMorphGeometry,
  computePopoverTargetRect,
  createPopoverMorphController,
  createPopoverMorphSnapshot,
  evaluatePopoverMotion,
  getPopoverPhaseDurationSec,
  type EvaluatePopoverMotionOptions,
  type PopoverAnchorConfig,
  type PopoverContentTransform,
  type PopoverFrameGeometry,
  type PopoverGlyphTransform,
  type PopoverInterruptStart,
  type PopoverMorphController,
  type PopoverMorphControllerOptions,
  type PopoverMorphPhase,
  type PopoverMorphSnapshot,
  type PopoverMotionState,
  type PopoverPanelConfig,
  type PopoverPlacement,
} from './popover.ts'

export {
  SEGMENTED_PILL_DEFAULTS,
  createSegmentedPillController,
  type SegmentItem,
  type SegmentedPillController,
  type SegmentedPillOptions,
  type SegmentedPillState,
} from './segmented.ts'

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
} from './dragMerge.ts'
