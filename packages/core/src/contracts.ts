/**
 * Core contracts for `@meniscus/core`.
 * Defines the generic N-primitive continuous glass field, spring physics,
 * optical material presets, and renderer interfaces without host-specific semantics.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface EdgeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Maximum active primitives supported per WebGL2 fragment shader draw call. */
export const MAX_GPU_PRIMITIVES = 16

/** Single rounded-rectangle or capsule glass primitive in logical CSS pixels. */
export interface GlassPrimitive {
  id?: string
  center: Point
  size: Size
  radius: number
  /** Optional primitive weight reserved for future extensions (defaults to 1). */
  weight?: number
}

/** Instantaneous geometry and optical blending state of an N-primitive glass field. */
export interface GlassFieldState {
  primitives: readonly GlassPrimitive[]
  blendK: number
  /** Soft rim highlight intensity multiplier in [0, 1] (defaults to 1). */
  rimOpacity?: number
  /** Material transition weight from directional to soft rim highlights in [0, 1] (defaults to 0). */
  styleMix?: number
}

/** Rim highlight mode: 'directional' favors directional speculars; 'soft' favors wide diffuse glow. */
export type RimMode = 'directional' | 'soft'

export type ThemeMode = 'light' | 'dark'

export type OpticalPresetVariant = 'crisp' | 'frosted'

export interface OpticalMaterial {
  bevel: number
  refraction: number
  blur: number
  dispersion: number
  saturation: number
  brightness: number
  contrast: number
  /** Normalized RGBA tint channels [r, g, b, a] in [0, 1]. */
  tintRgba: readonly [number, number, number, number]
  rimMode: RimMode
  rimOpacity: number
  rimWidth: number
  rimTail: number
  rimFocus: number
  rimAdded: number
  hairlineWidth: number
  hairlineSideAlpha: number
  hairlineCornerAlpha: number
  hairlineFlatAlpha: number
  shadowBlur: number
  shadowOffsetY: number
  shadowAlpha: number
  /** Optional uniform inner border width in CSS px; 0 or undefined uses directional rim highlights only. */
  borderWidth?: number
  /** Optional normalized inner border RGBA color [r, g, b, a]. */
  borderRgba?: readonly [number, number, number, number]
  /** Optional bottom directional highlight ratio relative to the top edge (defaults to 0.72). */
  rimBottomRatio?: number
}

export const DEFAULT_OPTICAL_MATERIALS = {
  light: {
    crisp: {
      bevel: 20,
      refraction: 60,
      blur: 2.5,
      dispersion: 0,
      saturation: 2.08,
      brightness: 1.0,
      contrast: 0.4,
      tintRgba: [253 / 255, 253 / 255, 253 / 255, 0x8a / 255],
      rimMode: 'directional',
      rimOpacity: 0.28,
      rimWidth: 1.2,
      rimTail: 0.17,
      rimFocus: 1.0,
      rimAdded: 0.38,
      hairlineWidth: 0.67,
      hairlineSideAlpha: 0.75,
      hairlineCornerAlpha: 0.5,
      hairlineFlatAlpha: 0.25,
      shadowBlur: 29,
      shadowOffsetY: 8,
      shadowAlpha: 0.118,
    },
    frosted: {
      bevel: 20,
      refraction: 60,
      blur: 12,
      dispersion: 0,
      saturation: 2.0,
      brightness: 1.1,
      contrast: 0,
      tintRgba: [0.975, 0.975, 0.98, 0.55],
      rimMode: 'soft',
      rimOpacity: 0.16,
      rimWidth: 5.0,
      rimTail: 0,
      rimFocus: 1.0,
      rimAdded: 1.0,
      hairlineWidth: 0.67,
      hairlineSideAlpha: 0.25,
      hairlineCornerAlpha: 0.15,
      hairlineFlatAlpha: 0.09,
      shadowBlur: 29,
      shadowOffsetY: 8,
      shadowAlpha: 0.118,
    },
  },
  dark: {
    crisp: {
      bevel: 20,
      refraction: 60,
      blur: 2.5,
      dispersion: 0,
      saturation: 2.84,
      brightness: 1.0,
      contrast: -0.4,
      tintRgba: [0.207, 0.207, 0.22, 0.62],
      rimMode: 'directional',
      rimOpacity: 0.28,
      rimWidth: 1.2,
      rimTail: 0.17,
      rimFocus: 1.0,
      rimAdded: 0.38,
      hairlineWidth: 0.67,
      hairlineSideAlpha: 0.75,
      hairlineCornerAlpha: 0.35,
      hairlineFlatAlpha: 0,
      shadowBlur: 29,
      shadowOffsetY: 8,
      shadowAlpha: 0.177,
    },
    frosted: {
      bevel: 20,
      refraction: 60,
      blur: 12,
      dispersion: 0,
      saturation: 1.75,
      brightness: 1.8,
      contrast: -0.53,
      tintRgba: [0.207, 0.207, 0.22, 0.63],
      rimMode: 'soft',
      rimOpacity: 0.22,
      rimWidth: 5.0,
      rimTail: 0,
      rimFocus: 1.0,
      rimAdded: 1.0,
      hairlineWidth: 0.67,
      hairlineSideAlpha: 0.27,
      hairlineCornerAlpha: 0.1,
      hairlineFlatAlpha: 0.02,
      shadowBlur: 29,
      shadowOffsetY: 8,
      shadowAlpha: 0.177,
    },
  },
} as const satisfies Record<ThemeMode, Record<OpticalPresetVariant, OpticalMaterial>>

export interface SpringParams {
  mass: number
  stiffness: number
  dampingRatio: number
}

export const DEFAULT_SPRINGS = {
  standard: { mass: 1, stiffness: 400, dampingRatio: 0.754 },
  corners: { mass: 1, stiffness: 324, dampingRatio: 0.75 },
  soft: { mass: 1, stiffness: 165, dampingRatio: 0.8 },
  elasticPress: { mass: 1, stiffness: 311, dampingRatio: 0.593 },
} as const satisfies Record<'standard' | 'corners' | 'soft' | 'elasticPress', SpringParams>

export interface SdfSample {
  distance: number
  normal: Point
}

export interface SminSample {
  distance: number
  normal: Point
  blendH: number
}

export interface RendererCapabilities {
  webgl2: boolean
  floatFbo: boolean
  maxTextureSize: number
  fallbackNotice?: string
}

/** Per-frame input for the overlay optical border renderer. */
export interface OverlayRenderFrame {
  viewport: Size
  dpr: number
  theme: ThemeMode
  field: GlassFieldState
  material: OpticalMaterial
  opacity: number
  blurBumpPx?: number
}

/** Optical border renderer contract (WebGL2 primary path with 2D Canvas fallback). */
export interface IGlassOverlayRenderer {
  readonly capabilities: RendererCapabilities
  mount(canvas: HTMLCanvasElement): RendererCapabilities
  render(frame: OverlayRenderFrame): void
  clear(): void
  dispose(): void
}
