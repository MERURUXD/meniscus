/**
 * @meniscus/core 纯标准 CSS 光学解析、SVG 光学矩阵生成与 OpticalMaterial 插值。
 *
 * 从标准计算后 CSS（`backdrop-filter`、`border`、`box-shadow`）解析玻璃光学参数，
 * 生成圆形倒角查找表、Rec.709 色彩矩阵与轮廓 Alpha Data URL，
 * 并提供跨主题预设的 `OpticalMaterial` 平滑插值。
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_OPTICAL_MATERIALS,
  type OpticalMaterial,
  type ThemeMode,
} from './contracts.ts'
import { clamp, lerp } from './physics.ts'

/** 圆形倒角查找表及校准后的 Sobel 导数参数。 */
export interface CircularBevelTable {
  tableValues: string
  peakSobelEffective: number
  blurStd: number
  divisor: number
}

/** 背景遮罩（veil）光学参数，保留 brightness/contrast 乘积及先后顺序。 */
export interface BackdropVeilOptics {
  brightness: number
  contrast: number
  contrastFirst: boolean
}

/** 解析后的单层 CSS `box-shadow` 结构。 */
export interface ParsedBoxShadowLayer {
  inset: boolean
  offsetX: number
  offsetY: number
  blur: number
  spread: number
  rgba: [number, number, number, number]
}

/** 从标准计算后 CSS 提取的归一化玻璃表面光学指标。 */
export interface ExtractedCssGlassSurface {
  veil: BackdropVeilOptics
  borderWidth: number
  borderRgba: [number, number, number, number]
  outlineWidth: number
  outlineAlpha: number
  rimOpacity: number
  rimWidth: number
  rimTail: number
  rimFocus: number
  rimBottomRatio: number
  shadowBlur: number
  shadowOffsetY: number
  shadowAlpha: number
}

/** `parseCssGlassSurface` 的输入参数（均为标准 CSS 字符串/数值）。 */
export interface ParseCssGlassSurfaceInput {
  backdropFilter: string
  veilFallback?: string
  borderWidthPx: number
  borderColor: string
  boxShadow: string
}

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax)
  return sign * y
}

function inverseHalfPlaneGaussian(a: number, sigma: number): number {
  const clamped = clamp(a, 0.0001, 0.9999)
  let lo = -sigma * 4.5
  let hi = sigma * 4.5
  const invRoot2Sigma = 1 / (Math.SQRT2 * sigma)
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) * 0.5
    const v = 0.5 + 0.5 * erfApprox(mid * invRoot2Sigma)
    if (v < clamped) lo = mid
    else hi = mid
  }
  return (lo + hi) * 0.5
}

/**
 * 对圆形倒角斜率曲线 `1 - sqrt(1 - rise^2)` 按距离 `d` 积分，
 * 并映射至高斯模糊 Alpha 分布 `A(d)`，使离散 Sobel 滤波器产生连续内向高光梯度。
 */
export function buildCircularBevelTable(
  bezel: number,
  blurStd?: number,
  steps = 21,
): CircularBevelTable {
  const safeBezel = Math.max(1, bezel)
  const effectiveBlurStd = blurStd ?? Math.max(4, Math.min(12.5, safeBezel * 0.425))

  const integrateHalf = (dMax: number): number => {
    const n = 48
    const absD = Math.abs(dMax)
    const sign = dMax < 0 ? -1 : 1
    let sum = 0
    for (let i = 0; i < n; i += 1) {
      const d = ((i + 0.5) / n) * absD
      const rise = Math.max(0, 1 - d / safeBezel)
      const m = 1 - Math.sqrt(Math.max(0, 1 - rise * rise))
      sum += m * (absD / n)
    }
    return sign * sum
  }

  const maxIntegral = integrateHalf(safeBezel)
  const raw: number[] = []
  for (let i = 0; i < steps; i += 1) {
    const a = i / (steps - 1)
    const d = inverseHalfPlaneGaussian(a, effectiveBlurStd)
    const clampedD = clamp(d, -safeBezel, safeBezel)
    const val = 0.5 + 0.5 * (integrateHalf(clampedD) / maxIntegral)
    raw.push(clamp(val, 0, 1))
  }

  // [-1px, +1px] 范围内平均 Sobel 导数约为理论尖点导数的 0.78 倍
  const peakSobelEffective = (4 / maxIntegral) * 0.78
  const divisor = Number((peakSobelEffective / 0.48).toFixed(2))

  return {
    tableValues: raw.map((v) => v.toFixed(4)).join(' '),
    peakSobelEffective,
    blurStd: effectiveBlurStd,
    divisor,
  }
}

/**
 * 将 Rec.709 `saturate`、`brightness` 与 `contrast` 合并为单个 SVG `feColorMatrix` 矩阵字符串，
 * 精确匹配 CSS `contrast() brightness()`（`contrastFirst=true`）或 `brightness() contrast()`。
 */
export function buildColorOpticsMatrix(
  saturate: number,
  brightness: number,
  contrast: number,
  contrastFirst = false,
): string {
  const lr = 0.2126
  const lg = 0.7152
  const lb = 0.0722
  const invS = 1 - saturate
  const k = brightness * contrast
  const offset = contrastFirst ? brightness * 0.5 * (1 - contrast) : 0.5 * (1 - contrast)

  const rr = k * (lr * invS + saturate)
  const rg = k * (lg * invS)
  const rb = k * (lb * invS)

  const gr = k * (lr * invS)
  const gg = k * (lg * invS + saturate)
  const gb = k * (lb * invS)

  const br = k * (lr * invS)
  const bg = k * (lg * invS)
  const bb = k * (lb * invS + saturate)

  const f = (n: number) => n.toFixed(4)
  return `${f(rr)} ${f(rg)} ${f(rb)} 0 ${f(offset)}  ${f(gr)} ${f(gg)} ${f(gb)} 0 ${f(offset)}  ${f(br)} ${f(bg)} ${f(bb)} 0 ${f(offset)}  0 0 0 1 0`
}

/** 将轮廓 SVG Path 编码为用于 `feImage` Alpha 遮罩的 Data URL。 */
export function buildContourAlphaDataUrl(
  contourPath: string,
  width: number,
  height: number,
): string {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${contourPath}" fill="white"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDoc)}`
}

/** 解析浏览器计算后的 `rgb(...)`、`rgba(...)` 或 `color(srgb ...)` 字符串为归一化 `[0..1]` RGBA。 */
export function parseCssRgba(color: string): [number, number, number, number] {
  const trimmed = color.trim().toLowerCase()
  if (!trimmed || trimmed === 'none' || trimmed === 'transparent') {
    return [0, 0, 0, 0]
  }

  const srgbMatch = trimmed.match(
    /^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/,
  )
  if (srgbMatch) {
    const r = Number(srgbMatch[1])
    const g = Number(srgbMatch[2])
    const b = Number(srgbMatch[3])
    const aRaw = srgbMatch[4]
    const a = aRaw !== undefined ? (aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : Number(aRaw)) : 1
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
      return [r, g, b, clamp(a, 0, 1)]
    }
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*([^)]+)\s*\)$/)
  if (rgbMatch) {
    const body = rgbMatch[1].replace(/\//g, ' ').trim()
    const parts = body.split(/[\s,]+/)
    if (parts.length >= 3) {
      const parseChannel = (token: string) =>
        token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token) / 255
      const r = parseChannel(parts[0])
      const g = parseChannel(parts[1])
      const b = parseChannel(parts[2])
      const a =
        parts[3] !== undefined
          ? parts[3].endsWith('%')
            ? parseFloat(parts[3]) / 100
            : parseFloat(parts[3])
          : 1
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1), clamp(a, 0, 1)]
      }
    }
  }

  return [0, 0, 0, 0]
}

/** 从标准 CSS `filter` / `backdrop-filter` 字符串提取 `brightness(...)` 与 `contrast(...)` 乘积及先后顺序。 */
export function parseCssFilterOptics(filterStr: string): BackdropVeilOptics {
  if (!filterStr || filterStr === 'none') {
    return { brightness: 1, contrast: 1, contrastFirst: false }
  }
  let brightness = 1
  let contrast = 1
  let firstBrightnessIdx = -1
  let firstContrastIdx = -1

  const regex = /(brightness|contrast)\(\s*([^)]+)\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(filterStr)) !== null) {
    const fn = match[1].toLowerCase()
    const raw = match[2].trim()
    const val = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
    if (!Number.isFinite(val)) continue
    if (fn === 'brightness') {
      brightness *= val
      if (firstBrightnessIdx < 0) firstBrightnessIdx = match.index
    } else {
      contrast *= val
      if (firstContrastIdx < 0) firstContrastIdx = match.index
    }
  }

  return {
    brightness,
    contrast,
    contrastFirst:
      firstContrastIdx >= 0 && firstBrightnessIdx >= 0 && firstContrastIdx < firstBrightnessIdx,
  }
}

/** 在两个背景遮罩光学参数之间按 `t ∈ [0, 1]` 线性插值。 */
export function interpolateVeilOptics(
  from: BackdropVeilOptics,
  to: BackdropVeilOptics,
  t: number,
): BackdropVeilOptics {
  const u = clamp(t, 0, 1)
  return {
    brightness: lerp(from.brightness, to.brightness, u),
    contrast: lerp(from.contrast, to.contrast, u),
    contrastFirst: u >= 0.5 ? to.contrastFirst : from.contrastFirst,
  }
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = input.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

/** 将计算后的 CSS `box-shadow` 字符串解析为结构化阴影层列表（支持前置或后置颜色语法）。 */
export function parseCssBoxShadow(boxShadowStr: string): ParsedBoxShadowLayer[] {
  if (!boxShadowStr || boxShadowStr === 'none') return []
  const layers: ParsedBoxShadowLayer[] = []

  for (const rawLayer of splitTopLevelCommas(boxShadowStr)) {
    let rest = rawLayer
    let colorStr = ''
    const colorMatch = rest.match(/(?:rgba?|color)\([^)]+\)/i)
    if (colorMatch) {
      colorStr = colorMatch[0]
      rest = rest.replace(colorMatch[0], '').trim()
    }
    const tokens = rest.split(/\s+/).filter(Boolean)
    let inset = false
    const nums: number[] = []
    for (const tok of tokens) {
      if (tok === 'inset') {
        inset = true
        continue
      }
      if (/^-?\d*\.?\d+(?:px)?$/i.test(tok)) {
        nums.push(parseFloat(tok))
      }
    }
    if (nums.length < 2) continue
    layers.push({
      inset,
      offsetX: nums[0] ?? 0,
      offsetY: nums[1] ?? 0,
      blur: nums[2] ?? 0,
      spread: nums[3] ?? 0,
      rgba: colorStr ? parseCssRgba(colorStr) : [0, 0, 0, 1],
    })
  }
  return layers
}

/** 标准正态累积分布函数 Phi(z)，用于近似 CSS 高斯阴影模糊衰减。 */
function normalCdf(z: number): number {
  const x = z / Math.SQRT2
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const poly =
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t)
  const erfVal = 1 - poly * Math.exp(-ax * ax)
  return 0.5 * (1 + (x < 0 ? -erfVal : erfVal))
}

function resolveCssInsetShadowMetrics(
  layer: ParsedBoxShadowLayer,
  edgePush: number,
): { effectiveAlpha: number; spanPx: number; hasTail: boolean } {
  const netReach = edgePush + layer.spread
  const rawAlpha = layer.rgba[3]
  if (layer.blur <= 0.1) {
    return netReach > 0.05
      ? { effectiveAlpha: rawAlpha, spanPx: Math.min(4.8, Math.max(0.8, netReach)), hasTail: false }
      : { effectiveAlpha: 0, spanPx: 0, hasTail: false }
  }
  const sigma = Math.max(layer.blur * 0.5, 0.5)
  const peakFactor = normalCdf(netReach / sigma)
  const spanPx =
    netReach < 0
      ? Math.min(4.8, Math.max(1.2, sigma + netReach * 0.5))
      : Math.min(4.8, Math.max(1.4, netReach + sigma * 1.1))
  return {
    effectiveAlpha: rawAlpha * peakFactor,
    spanPx,
    hasTail: netReach >= 0 && layer.blur >= 2.5,
  }
}

/**
 * 从实时 DOM 的标准计算后 CSS 属性中提取归一化玻璃表面光学指标。
 * 通用适配任意标准 CSS 玻璃表面，不依赖特定私有变量或业务预设。
 */
export function parseCssGlassSurface({
  backdropFilter,
  veilFallback,
  borderWidthPx,
  borderColor,
  boxShadow,
}: ParseCssGlassSurfaceInput): ExtractedCssGlassSurface {
  const veil = parseCssFilterOptics(
    backdropFilter && /(brightness|contrast)\(/i.test(backdropFilter)
      ? backdropFilter
      : (veilFallback ?? ''),
  )
  const borderRgba = parseCssRgba(borderColor)
  const borderWidth = borderWidthPx > 0.05 ? borderWidthPx : 0

  const layers = parseCssBoxShadow(boxShadow)
  let outlineWidth = 0
  let outlineAlpha = 0
  let shadowBlur = 0
  let shadowOffsetY = 0
  let shadowAlpha = 0

  let topAlpha = 0
  let botAlpha = 0
  let isoAlpha = 0
  let maxRimSpan = 0
  let rimHasTail = false

  for (const layer of layers) {
    const a = layer.rgba[3]
    if (a <= 0.001) continue

    if (!layer.inset) {
      if (
        layer.blur <= 0.1 &&
        Math.abs(layer.offsetX) <= 0.1 &&
        Math.abs(layer.offsetY) <= 0.1 &&
        layer.spread > 0
      ) {
        outlineWidth = Math.max(outlineWidth, layer.spread)
        outlineAlpha = Math.max(outlineAlpha, a)
      } else if (layer.blur >= shadowBlur) {
        shadowBlur = layer.blur
        shadowOffsetY = layer.offsetY
        shadowAlpha = a
      }
    } else if (Math.abs(layer.offsetY) <= 0.1 && Math.abs(layer.offsetX) <= 0.1) {
      const m = resolveCssInsetShadowMetrics(layer, 0)
      if (m.effectiveAlpha > 0.001) {
        isoAlpha = Math.max(isoAlpha, m.effectiveAlpha)
        maxRimSpan = Math.max(maxRimSpan, m.spanPx)
        rimHasTail = rimHasTail || m.hasTail
      }
    } else if (layer.offsetY > 0.1) {
      const m = resolveCssInsetShadowMetrics(layer, layer.offsetY)
      if (m.effectiveAlpha > 0.001) {
        topAlpha = Math.max(topAlpha, m.effectiveAlpha)
        maxRimSpan = Math.max(maxRimSpan, m.spanPx)
        rimHasTail = rimHasTail || m.hasTail
      }
    } else if (layer.offsetY < -0.1) {
      const m = resolveCssInsetShadowMetrics(layer, -layer.offsetY)
      if (m.effectiveAlpha > 0.001) {
        botAlpha = Math.max(botAlpha, m.effectiveAlpha)
        maxRimSpan = Math.max(maxRimSpan, m.spanPx)
        rimHasTail = rimHasTail || m.hasTail
      }
    }
  }

  const isIsotropic = isoAlpha > 0 && topAlpha === 0 && botAlpha === 0
  const rimOpacity = isIsotropic ? isoAlpha : Math.max(topAlpha, botAlpha)
  const rimFocus = isIsotropic ? 0 : 1
  const rimBottomRatio = isIsotropic
    ? 1
    : topAlpha > 0.001
      ? Math.min(1, botAlpha / topAlpha)
      : 1

  return {
    veil,
    borderWidth,
    borderRgba,
    outlineWidth,
    outlineAlpha,
    rimOpacity,
    rimWidth: rimOpacity > 0.001 ? Math.min(4.8, Math.max(1.2, maxRimSpan)) : 0,
    rimTail: rimOpacity > 0.001 && rimHasTail ? 0.14 : 0,
    rimFocus,
    rimBottomRatio,
    shadowBlur,
    shadowOffsetY,
    shadowAlpha,
  }
}

/**
 * 在起点与终点实测 CSS 玻璃表面之间按 `styleMix ∈ [0, 1]` 插值，
 * 并覆写基础 `OpticalMaterial` 的边框、描边、内高光与阴影参数以实现无跳变着陆。
 */
export function interpolateCssGlassSurfaceToMaterial(
  baseMaterial: OpticalMaterial,
  from: ExtractedCssGlassSurface,
  to: ExtractedCssGlassSurface,
  styleMix: number,
): OpticalMaterial {
  const t = clamp(styleMix, 0, 1)
  const outlineAlpha = lerp(from.outlineAlpha, to.outlineAlpha, t)

  return {
    ...baseMaterial,
    borderWidth: Math.max(from.borderWidth, to.borderWidth),
    borderRgba: [
      lerp(from.borderRgba[0], to.borderRgba[0], t),
      lerp(from.borderRgba[1], to.borderRgba[1], t),
      lerp(from.borderRgba[2], to.borderRgba[2], t),
      lerp(from.borderRgba[3], to.borderRgba[3], t),
    ],
    rimOpacity: lerp(from.rimOpacity, to.rimOpacity, t),
    rimWidth: lerp(from.rimWidth || to.rimWidth, to.rimWidth || from.rimWidth, t),
    rimTail: lerp(from.rimTail, to.rimTail, t),
    rimFocus: t >= 0.5 ? to.rimFocus : from.rimFocus,
    rimBottomRatio: lerp(from.rimBottomRatio, to.rimBottomRatio, t),
    hairlineWidth: lerp(from.outlineWidth || to.outlineWidth, to.outlineWidth || from.outlineWidth, t),
    hairlineSideAlpha: outlineAlpha,
    hairlineCornerAlpha: outlineAlpha,
    hairlineFlatAlpha: outlineAlpha,
    shadowBlur: lerp(from.shadowBlur, to.shadowBlur, t),
    shadowOffsetY: lerp(from.shadowOffsetY, to.shadowOffsetY, t),
    shadowAlpha: lerp(from.shadowAlpha, to.shadowAlpha, t),
  }
}

/**
 * 在两个 `OpticalMaterial` 材质之间按 `t ∈ [0, 1]` 平滑插值（包含可选边框与底部高光比例）。
 */
export function interpolateOpticalMaterial(
  from: OpticalMaterial,
  to: OpticalMaterial,
  t: number,
): OpticalMaterial {
  const u = clamp(t, 0, 1)
  const result: OpticalMaterial = {
    bevel: lerp(from.bevel, to.bevel, u),
    refraction: lerp(from.refraction, to.refraction, u),
    blur: lerp(from.blur, to.blur, u),
    dispersion: lerp(from.dispersion, to.dispersion, u),
    saturation: lerp(from.saturation, to.saturation, u),
    brightness: lerp(from.brightness, to.brightness, u),
    contrast: lerp(from.contrast, to.contrast, u),
    tintRgba: [
      lerp(from.tintRgba[0], to.tintRgba[0], u),
      lerp(from.tintRgba[1], to.tintRgba[1], u),
      lerp(from.tintRgba[2], to.tintRgba[2], u),
      lerp(from.tintRgba[3], to.tintRgba[3], u),
    ],
    rimMode: u < 0.5 ? from.rimMode : to.rimMode,
    rimOpacity: lerp(from.rimOpacity, to.rimOpacity, u),
    rimWidth: lerp(from.rimWidth, to.rimWidth, u),
    rimTail: lerp(from.rimTail, to.rimTail, u),
    rimFocus: lerp(from.rimFocus, to.rimFocus, u),
    rimAdded: lerp(from.rimAdded, to.rimAdded, u),
    hairlineWidth: lerp(from.hairlineWidth, to.hairlineWidth, u),
    hairlineSideAlpha: lerp(from.hairlineSideAlpha, to.hairlineSideAlpha, u),
    hairlineCornerAlpha: lerp(from.hairlineCornerAlpha, to.hairlineCornerAlpha, u),
    hairlineFlatAlpha: lerp(from.hairlineFlatAlpha, to.hairlineFlatAlpha, u),
    shadowBlur: lerp(from.shadowBlur, to.shadowBlur, u),
    shadowOffsetY: lerp(from.shadowOffsetY, to.shadowOffsetY, u),
    shadowAlpha: lerp(from.shadowAlpha, to.shadowAlpha, u),
  }

  if (from.borderWidth !== undefined || to.borderWidth !== undefined) {
    result.borderWidth = lerp(from.borderWidth ?? 0, to.borderWidth ?? 0, u)
  }

  if (from.borderRgba !== undefined || to.borderRgba !== undefined) {
    const a = from.borderRgba ?? [0, 0, 0, 0]
    const b = to.borderRgba ?? [0, 0, 0, 0]
    result.borderRgba = [
      lerp(a[0], b[0], u),
      lerp(a[1], b[1], u),
      lerp(a[2], b[2], u),
      lerp(a[3], b[3], u),
    ]
  }

  if (from.rimBottomRatio !== undefined || to.rimBottomRatio !== undefined) {
    result.rimBottomRatio = lerp(from.rimBottomRatio ?? 0.72, to.rimBottomRatio ?? 0.72, u)
  }

  return result
}

/**
 * 便捷解析器：在指定主题下 `DEFAULT_OPTICAL_MATERIALS[theme].crisp` 与 `frosted` 之间按 `styleMix` 插值。
 */
export function resolveOpticalMaterial(
  theme: ThemeMode,
  styleMix: number,
): OpticalMaterial {
  const presets = DEFAULT_OPTICAL_MATERIALS[theme]
  return interpolateOpticalMaterial(presets.crisp, presets.frosted, styleMix)
}
