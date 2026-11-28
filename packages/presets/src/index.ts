/**
 * Public entry point for `@sessile/presets`.
 * Framework-agnostic interaction presets built on `@sessile/core`.
 *
 * The morphing popover is the stable preset. Segmented pill and drag-merge ship as
 * `@sessile/presets/experimental` until a production host adopts them.
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
  type PopoverReopenOrigin,
} from './popover.ts'
