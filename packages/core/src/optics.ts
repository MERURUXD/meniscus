/**
 * @sessile/core pure CSS optics parsing, SVG optical matrix generation, and OpticalMaterial interpolation.
 *
 * Extracts glass surface optical metrics from standard computed CSS (`backdrop-filter`, `border`, `box-shadow`),
 * builds circular-bevel lookup tables, Rec.709 color matrices, and contour alpha Data URLs,
 * and interpolates `OpticalMaterial` across theme presets without hardcoded host CSS variables.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_OPTICAL_MATERIALS,
  type OpticalMaterial,
  type ThemeMode,
} from './contracts.ts'
import { clamp, lerp } from './physics.ts'

/** Circular bevel lookup table and calibrated Sobel derivative parameters. */
export interface CircularBevelTable {
  tableValues: string
  peakSobelEffective: number
  blurStd: number
  divisor: number
}

/** Backdrop veil optical parameters preserving brightness/contrast products and filter order. */
export interface BackdropVeilOptics {
  brightness: number
  contrast: number
  contrastFirst: boolean
}

/** Parsed single layer of a computed CSS `box-shadow` declaration. */
export interface ParsedBoxShadowLayer {
  inset: boolean
  offsetX: number
  offsetY: number
  blur: number
  spread: number
  rgba: [number, number, number, number]
}

/** Normalized glass surface optical metrics extracted from standard computed CSS. */
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

/** Input parameters for `parseCssGlassSurface` (standard computed CSS strings and pixel values). */
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
 * Integrates the circular-bevel slope `1 - sqrt(1 - rise^2)` with respect to distance `d`,
 * mapped onto the Gaussian-blurred alpha distribution `A(d)` so a discrete Sobel filter
 * produces smooth inward rim gradients.
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

  // Average Sobel derivative across [-1px, +1px] is ~0.78x the theoretical cusp slope.
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
 * Fuses Rec.709 `saturate`, `brightness`, and `contrast` into a single SVG `feColorMatrix` string.
 * Adjusts the constant offset to match CSS `contrast() brightness()` (`contrastFirst=true`)
 * versus `brightness() contrast()` (`contrastFirst=false`).
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

/** Encodes a contour SVG path as an inline Data URL for use as an `feImage` alpha mask. */
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

/**
 * Parses a browser-computed `rgb(...)`, `rgba(...)`, `color(srgb ...)`, `oklab(...)` or
 * `oklch(...)` string into normalized `[0..1]` sRGB RGBA.
 */
export function parseCssRgba(color: string): [number, number, number, number] {
  return tryParseCssRgba(color) ?? [0, 0, 0, 0]
}

/**
 * Like `parseCssRgba`, but returns `null` instead of transparent black for anything it cannot
 * resolve (`var()`, percentage `color(srgb ...)` channels, other color spaces), so callers can
 * tell a real transparent color from an unsupported one.
 *
 * Browsers serialize `color-mix()` and alpha-modified theme colors (Tailwind's `text-white/90`)
 * as `oklab()` / `oklch()`, so a host reading computed styles meets these routinely.
 */
export function tryParseCssRgba(color: string): [number, number, number, number] | null {
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

  const okMatch = trimmed.match(/^ok(lab|lch)\(\s*([^)]+)\s*\)$/)
  if (okMatch) {
    const [channels, alphaRaw] = okMatch[2]!.split('/')
    const parts = channels!.trim().split(/\s+/)
    if (parts.length === 3) {
      const polar = okMatch[1] === 'lch'
      // Percent references: L 100% = 1, a/b/C 100% = 0.4 (CSS Color 4).
      const num = (token: string, percentScale: number) =>
        token === 'none' ? 0 : token.endsWith('%') ? (parseFloat(token) / 100) * percentScale : parseFloat(token)
      const l = num(parts[0]!, 1)
      let a = num(parts[1]!, 0.4)
      let b = num(parts[2]!, 0.4)
      if (polar) {
        const hue = ((parts[2] === 'none' ? 0 : parseFloat(parts[2]!)) * Math.PI) / 180
        b = a * Math.sin(hue)
        a = a * Math.cos(hue)
      }
      const alphaToken = alphaRaw?.trim()
      const alpha =
        alphaToken === undefined || alphaToken === 'none'
          ? 1
          : alphaToken.endsWith('%')
            ? parseFloat(alphaToken) / 100
            : parseFloat(alphaToken)
      if ([l, a, b, alpha].every(Number.isFinite)) {
        const [r, g, bl] = oklabToSrgb(l, a, b)
        return [r, g, bl, clamp(alpha, 0, 1)]
      }
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

  return null
}

/** OKLab to gamma-encoded sRGB (Björn Ottosson's matrices); out-of-gamut channels are clipped. */
function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const encode = (linear: number) => {
    const x = clamp(linear, 0, 1)
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  }
  return [
    encode(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    encode(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    encode(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ]
}

const VEIL_SINGULAR_EPS = 1e-6

function veilOpticsToAffine(veil: BackdropVeilOptics): { scale: number; offset: number } {
  const scale = veil.brightness * veil.contrast
  const offset = veil.contrastFirst
    ? veil.brightness * 0.5 * (1 - veil.contrast)
    : 0.5 * (1 - veil.contrast)
  return { scale, offset }
}

function affineToVeilOptics(
  scale: number,
  offset: number,
  preferBrightnessFirst: boolean,
): BackdropVeilOptics {
  const canBrightnessFirst = Math.abs(1 - 2 * offset) > VEIL_SINGULAR_EPS
  const canContrastFirst = Math.abs(scale + 2 * offset) > VEIL_SINGULAR_EPS

  if (preferBrightnessFirst && canBrightnessFirst) {
    const contrast = 1 - 2 * offset
    return {
      brightness: scale / contrast,
      contrast,
      contrastFirst: false,
    }
  }

  if (canContrastFirst) {
    const brightness = scale + 2 * offset
    return {
      brightness,
      contrast: scale / brightness,
      contrastFirst: true,
    }
  }

  if (canBrightnessFirst) {
    const contrast = 1 - 2 * offset
    return {
      brightness: scale / contrast,
      contrast,
      contrastFirst: false,
    }
  }

  // Degenerate singular point (scale ~ -1, offset ~ 0.5) has no finite factorization.
  return {
    brightness: 0,
    contrast: 0,
    contrastFirst: !preferBrightnessFirst,
  }
}

/** Extracts `brightness(...)` and `contrast(...)` affine composition from a CSS filter string. */
export function parseCssFilterOptics(filterStr: string): BackdropVeilOptics {
  if (!filterStr || filterStr === 'none') {
    return { brightness: 1, contrast: 1, contrastFirst: false }
  }
  let scale = 1
  let offset = 0
  let hasSeenContrast = false
  let allBrightnessBeforeFirstContrast = true

  const regex = /(brightness|contrast)\(\s*([^)]+)\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(filterStr)) !== null) {
    const fn = match[1].toLowerCase()
    const raw = match[2].trim()
    const val = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
    if (!Number.isFinite(val)) continue
    if (fn === 'brightness') {
      scale *= val
      offset *= val
      if (hasSeenContrast) {
        allBrightnessBeforeFirstContrast = false
      }
    } else {
      scale *= val
      offset = offset * val + 0.5 * (1 - val)
      hasSeenContrast = true
    }
  }

  return affineToVeilOptics(scale, offset, allBrightnessBeforeFirstContrast)
}

/** Linearly interpolates two backdrop veil optics states in 1D affine `(scale, offset)` space. */
export function interpolateVeilOptics(
  from: BackdropVeilOptics,
  to: BackdropVeilOptics,
  t: number,
): BackdropVeilOptics {
  const u = clamp(t, 0, 1)
  const a = veilOpticsToAffine(from)
  const b = veilOpticsToAffine(to)
  const scale = lerp(a.scale, b.scale, u)
  const offset = lerp(a.offset, b.offset, u)
  const preferBrightnessFirst =
    from.contrastFirst === to.contrastFirst ? !from.contrastFirst : false
  return affineToVeilOptics(scale, offset, preferBrightnessFirst)
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

/** Parses a computed CSS `box-shadow` string into structured layers (supports leading or trailing colors). */
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

/** Standard normal CDF Phi(z) used to model Gaussian attenuation of CSS `inset box-shadow` edges. */
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
 * Extracts normalized glass surface optical metrics from standard computed DOM CSS properties.
 * Works generically across any standard CSS glass surface without relying on private custom properties.
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
 * Interpolates between two measured CSS glass surfaces at `styleMix` in `[0, 1]`,
 * overriding the base `OpticalMaterial` border, hairline, rim, and shadow fields for seamless landing.
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
    borderWidth: lerp(from.borderWidth, to.borderWidth, t),
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

/** Smoothly interpolates two `OpticalMaterial` definitions at `t` in `[0, 1]`, including optional border fields. */
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

  if (from.bevelProfile !== undefined || to.bevelProfile !== undefined) {
    result.bevelProfile =
      u < 0.5 ? (from.bevelProfile ?? to.bevelProfile) : (to.bevelProfile ?? from.bevelProfile)
  }

  if (from.lightAngle !== undefined || to.lightAngle !== undefined) {
    result.lightAngle = lerp(from.lightAngle ?? -45, to.lightAngle ?? -45, u)
  }

  if (from.lightElevation !== undefined || to.lightElevation !== undefined) {
    result.lightElevation = lerp(from.lightElevation ?? 22, to.lightElevation ?? 22, u)
  }

  if (from.rimShade !== undefined || to.rimShade !== undefined) {
    result.rimShade = lerp(from.rimShade ?? 0.32, to.rimShade ?? 0.32, u)
  }

  return result
}

/** Convenience resolver interpolating between `DEFAULT_OPTICAL_MATERIALS[theme].crisp` and `.frosted` by `styleMix`. */
export function resolveOpticalMaterial(
  theme: ThemeMode,
  styleMix: number,
): OpticalMaterial {
  const presets = DEFAULT_OPTICAL_MATERIALS[theme]
  return interpolateOpticalMaterial(presets.crisp, presets.frosted, styleMix)
}
