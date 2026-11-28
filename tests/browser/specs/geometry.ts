/**
 * Shared scene geometry in CSS pixels on the 800x600 fixture.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { OpticalMaterial } from '@sessile/core'
import type { PrimitiveSpec } from '../fixtures/harness.ts'
import type { Region } from './pixels.ts'

/** One 320x200 rounded rect with 48px corners, spanning x 240..560 and y 200..400. */
export const PANE: PrimitiveSpec = { x: 400, y: 300, width: 320, height: 200, radius: 48 }

/** The flat interior, well inside the default 20px bezel: refraction leaves it in place. */
export const CENTER: Region = { x: 340, y: 270, width: 120, height: 60 }

/** Inside the bezel along the straight edges, where the lens displaces the backdrop most. */
export const BEZEL: readonly Region[] = [
  { x: 243, y: 270, width: 13, height: 60 },
  { x: 544, y: 270, width: 13, height: 60 },
  { x: 340, y: 203, width: 120, height: 13 },
  { x: 340, y: 384, width: 120, height: 13 },
]

/**
 * Inside the pane's bounding box but outside its rounded corners. Anything painted here is the
 * rectangular backdrop-filter leak that Route B3's self-masking and the veil clip-path prevent.
 */
export const OUTSIDE_CORNERS: readonly Region[] = [
  { x: 241, y: 201, width: 9, height: 9 },
  { x: 550, y: 201, width: 9, height: 9 },
  { x: 241, y: 390, width: 9, height: 9 },
  { x: 550, y: 390, width: 9, height: 9 },
]

/** Far from any glass. */
export const FAR: Region = { x: 20, y: 20, width: 100, height: 100 }

/** Halfway between the two circles of the morph scene (centered at x = 400). */
export const GAP: Region = { x: 392, y: 290, width: 16, height: 20 }

/**
 * The frosted material the fallback specs mount: a 12px blur plus a half-opaque blue tint. Blur is
 * only visible in Chromium's screenshots; the tint is ordinary painting, so it shows the veil's
 * coverage and clip in every engine.
 */
export const FROST: Partial<OpticalMaterial> = { blur: 12, tintRgba: [0.2, 0.4, 0.9, 0.5] }

/** `blueShift` a FROST veil must reach over the checkerboard (it measures about 90). */
export const TINT_MIN = 40
