/**
 * `@sessile/core/overlay`: WebGL2 / 2D Canvas perimeter highlight and shadow renderer.
 * Kept off the main entry so hosts that never draw an edge overlay skip ~1.2k lines of
 * renderer and shader source.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export type { IGlassOverlayRenderer, OverlayRenderFrame, RendererCapabilities } from '../contracts.ts'

export { createGlassOverlayRenderer, type GlassOverlayRendererOptions } from '../overlayRenderer.ts'
