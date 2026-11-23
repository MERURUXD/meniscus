/**
 * @meniscus/core 统一核心契约定义。
 * 描述通用 N-图元连续玻璃场、物理弹簧参数、光学材质与渲染器接口，
 * 不包含任何特定宿主业务或菜单交互语义。
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

/** WebGL2 片元着色器单次绘制支持的最大活跃图元数量。 */
export const MAX_GPU_PRIMITIVES = 16

/** 逻辑 CSS 像素坐标系下的单个圆角矩形/胶囊玻璃图元。 */
export interface GlassPrimitive {
  id?: string
  center: Point
  size: Size
  radius: number
  /** 可选图元权重（预留扩展，默认 1）。 */
  weight?: number
}

/** N-图元玻璃场的瞬时几何与融合光学混合状态。 */
export interface GlassFieldState {
  primitives: readonly GlassPrimitive[]
  blendK: number
  /** 柔和边缘高光强度系数，范围 [0, 1]（未指定时默认 1）。 */
  rimOpacity?: number
  /** 从方向性高光到柔和边缘高光的材质过渡权重，范围 [0, 1]（未指定时默认 0）。 */
  styleMix?: number
}

/** 边缘高光模式：'directional' 偏向定向高光，'soft' 偏向宽柔散射高光。 */
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
  /** 归一化线性/sRGB RGBA 染色通道 [r, g, b, a]，范围 [0, 1]。 */
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
  /** 可选等宽内边框宽度（CSS px，0 或未定义表示仅使用方向性边缘高光）。 */
  borderWidth?: number
  /** 可选归一化内边框 RGBA 颜色 [r, g, b, a]。 */
  borderRgba?: readonly [number, number, number, number]
  /** 可选底部方向高光相对顶部的比例（默认 0.72）。 */
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

/** 叠加层光学边界渲染器的单帧输入。 */
export interface OverlayRenderFrame {
  viewport: Size
  dpr: number
  theme: ThemeMode
  field: GlassFieldState
  material: OpticalMaterial
  opacity: number
  blurBumpPx?: number
}

/** 光学边界渲染器契约（WebGL2 主路径 + 2D Canvas 降级）。 */
export interface IGlassOverlayRenderer {
  readonly capabilities: RendererCapabilities
  mount(canvas: HTMLCanvasElement): RendererCapabilities
  render(frame: OverlayRenderFrame): void
  clear(): void
  dispose(): void
}
