/**
 * Pure standard CSS optical surface extraction and material composition for `@meniscus/dom`.
 *
 * Reads only standard DOM computed styles (`backdrop-filter`, `background-color`,
 * `border-top-*`, `box-shadow`, `border-top-left-radius`, `color-scheme`) without any
 * host-specific CSS custom properties.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_OPTICAL_MATERIALS,
  clamp,
  interpolateCssGlassSurfaceToMaterial,
  parseCssGlassSurface,
  parseCssRgba,
  type BackdropVeilOptics,
  type ExtractedCssGlassSurface,
  type OpticalMaterial,
  type OpticalPresetVariant,
  type ThemeMode,
} from '@meniscus/core'

export interface MeasuredCssGlassSurface {
  surface: ExtractedCssGlassSurface
  backgroundRgba: [number, number, number, number]
  blurPx: number | null
  saturation: number | null
  borderRadiusPx: number
  theme: ThemeMode
}

export interface ResolveElementThemeOptions {
  fallbackTheme?: ThemeMode
  getComputedStyle?: (el: Element) => CSSStyleDeclaration
  matchMedia?: ((query: string) => MediaQueryList | null) | null
}

export interface ReadElementGlassSurfaceOptions extends ResolveElementThemeOptions {
  /** Attribute temporarily stripped while reading resting computed styles (defaults to `'data-meniscus-morphing'`). */
  temporarilyClearAttribute?: string | null
}

export interface BuildMaterialFromCssSurfaceOptions {
  theme?: ThemeMode
  preset?: OpticalPresetVariant
  baseMaterial?: OpticalMaterial
  overrides?: Partial<OpticalMaterial>
}

export interface BuildBackdropFilterCssParams {
  blurPx: number
  saturation?: number
  veil?: BackdropVeilOptics
}

const DEFAULT_MORPH_ATTRIBUTE = 'data-meniscus-morphing'
const DEFAULT_LIGHT_SOLID = 'rgb(250, 250, 252)'
const DEFAULT_DARK_SOLID = 'rgb(32, 32, 36)'

function resolveComputedStyleFn(
  customFn?: (el: Element) => CSSStyleDeclaration,
): ((el: Element) => CSSStyleDeclaration) | null {
  if (customFn) {
    return customFn
  }
  if (typeof globalThis.getComputedStyle === 'function') {
    return (target: Element) => globalThis.getComputedStyle(target)
  }
  return null
}

function resolveThemeMatchMedia(
  options?: ResolveElementThemeOptions,
): ((query: string) => MediaQueryList | null) | null {
  if (options && 'matchMedia' in options) {
    return options.matchMedia ?? null
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return (query: string) => window.matchMedia(query)
  }
  if (typeof globalThis.matchMedia === 'function') {
    return (query: string) => globalThis.matchMedia(query)
  }
  return null
}

function parseExactThemeToken(value: string | null | undefined): ThemeMode | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'light' || normalized === 'dark') {
    return normalized
  }
  return null
}

/**
 * Resolves the active light/dark theme for `el` using standard DOM attributes,
 * `color-scheme`, `(prefers-color-scheme: light)`, and finally `fallbackTheme`.
 */
export function resolveElementTheme(
  el?: Element | null,
  options?: ResolveElementThemeOptions,
): ThemeMode {
  const scopedAttr =
    el && typeof el.closest === 'function'
      ? parseExactThemeToken(el.closest('[data-theme]')?.getAttribute('data-theme'))
      : parseExactThemeToken(el?.getAttribute?.('data-theme'))
  if (scopedAttr) {
    return scopedAttr
  }

  const rootEl = typeof document !== 'undefined' ? document.documentElement : null
  const docAttr = parseExactThemeToken(rootEl?.getAttribute?.('data-theme'))
  if (docAttr) {
    return docAttr
  }

  const getCs = resolveComputedStyleFn(options?.getComputedStyle)
  if (getCs) {
    if (el) {
      const elScheme = parseExactThemeToken(getCs(el).colorScheme)
      if (elScheme) return elScheme
    }
    if (rootEl && rootEl !== el) {
      const rootScheme = parseExactThemeToken(getCs(rootEl).colorScheme)
      if (rootScheme) return rootScheme
    }
  }

  const matchMedia = resolveThemeMatchMedia(options)
  if (matchMedia) {
    const mql = matchMedia('(prefers-color-scheme: light)')
    if (mql) {
      return mql.matches ? 'light' : 'dark'
    }
  }

  return options?.fallbackTheme ?? 'dark'
}

/** Extracts the CSS `blur(<num>px)` (or `blur(0)`) radius from a filter string, or `null`. */
export function parseCssBackdropBlur(filterStr: string): number | null {
  if (!filterStr || filterStr === 'none') {
    return null
  }
  const regex = /blur\(\s*([^)]+)\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(filterStr)) !== null) {
    const token = match[1].trim()
    if (token === '0') {
      return 0
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)px$/i.test(token)) {
      const parsed = Number.parseFloat(token)
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed
      }
    }
  }
  return null
}

/** Extracts the cumulative `saturate(...)` multiplier from a CSS filter string, or `null`. */
export function parseCssBackdropSaturate(filterStr: string): number | null {
  if (!filterStr || filterStr === 'none') {
    return null
  }
  const regex = /saturate\(\s*([^)]+)\s*\)/gi
  let match: RegExpExecArray | null
  let product = 1
  let found = false

  while ((match = regex.exec(filterStr)) !== null) {
    const token = match[1].trim()
    let val = Number.NaN
    if (token.endsWith('%')) {
      const numPart = token.slice(0, -1).trim()
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(numPart)) {
        val = Number.parseFloat(numPart) / 100
      }
    } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      val = Number.parseFloat(token)
    }
    if (Number.isFinite(val) && val >= 0) {
      product *= val
      found = true
    }
  }

  return found ? product : null
}

/**
 * Reads resting computed glass optical properties from `el` using standard CSS properties only.
 * Temporarily strips `temporarilyClearAttribute` (with transitions suppressed) so resting styles
 * can be sampled cleanly even if an active morph rule overrides visual styles.
 */
export function readElementGlassSurface(
  el: HTMLElement,
  options?: ReadElementGlassSurfaceOptions,
): MeasuredCssGlassSurface {
  const getCs = resolveComputedStyleFn(options?.getComputedStyle)
  if (!getCs) {
    throw new Error('getComputedStyle is unavailable in this environment')
  }

  const clearAttr =
    options?.temporarilyClearAttribute === undefined
      ? DEFAULT_MORPH_ATTRIBUTE
      : options.temporarilyClearAttribute

  const hasClearAttr = Boolean(clearAttr && el.hasAttribute(clearAttr))
  const prevAttrValue = hasClearAttr && clearAttr ? el.getAttribute(clearAttr) : null
  const prevTransition = el.style ? el.style.transition : ''

  if (hasClearAttr && clearAttr) {
    if (el.style) {
      el.style.transition = 'none'
    }
    el.removeAttribute(clearAttr)
  }

  let cs: CSSStyleDeclaration
  let theme: ThemeMode
  try {
    cs = getCs(el)
    theme = resolveElementTheme(el, {
      fallbackTheme: options?.fallbackTheme,
      getComputedStyle: getCs,
      matchMedia: options && 'matchMedia' in options ? options.matchMedia : undefined,
    })
  } finally {
    if (hasClearAttr && clearAttr) {
      el.setAttribute(clearAttr, prevAttrValue ?? 'true')
      if (el.style) {
        el.style.transition = prevTransition
      }
    }
  }

  const webkitBf =
    typeof cs.getPropertyValue === 'function'
      ? cs.getPropertyValue('-webkit-backdrop-filter')
      : ''
  const backdropFilter = cs.backdropFilter || webkitBf || ''
  const borderWidthPx = Number.parseFloat(cs.borderTopWidth) || 0
  const borderColor = cs.borderTopColor || ''
  const boxShadow = cs.boxShadow || ''
  const backgroundColor = cs.backgroundColor || ''
  const rawRadius = Number.parseFloat(cs.borderTopLeftRadius)
  const borderRadiusPx = Number.isFinite(rawRadius) && rawRadius >= 0 ? rawRadius : 0

  const surface = parseCssGlassSurface({
    backdropFilter,
    borderWidthPx,
    borderColor,
    boxShadow,
  })

  return {
    surface,
    backgroundRgba: parseCssRgba(backgroundColor),
    blurPx: parseCssBackdropBlur(backdropFilter),
    saturation: parseCssBackdropSaturate(backdropFilter),
    borderRadiusPx,
    theme,
  }
}

function applyMaterialOverrides(
  material: OpticalMaterial,
  overrides?: Partial<OpticalMaterial>,
): OpticalMaterial {
  if (!overrides) {
    return material
  }
  const merged: OpticalMaterial = { ...material }
  if (overrides.bevel !== undefined) merged.bevel = overrides.bevel
  if (overrides.refraction !== undefined) merged.refraction = overrides.refraction
  if (overrides.blur !== undefined) merged.blur = overrides.blur
  if (overrides.dispersion !== undefined) merged.dispersion = overrides.dispersion
  if (overrides.saturation !== undefined) merged.saturation = overrides.saturation
  if (overrides.brightness !== undefined) merged.brightness = overrides.brightness
  if (overrides.contrast !== undefined) merged.contrast = overrides.contrast
  if (overrides.tintRgba !== undefined) merged.tintRgba = overrides.tintRgba
  if (overrides.rimMode !== undefined) merged.rimMode = overrides.rimMode
  if (overrides.rimOpacity !== undefined) merged.rimOpacity = overrides.rimOpacity
  if (overrides.rimWidth !== undefined) merged.rimWidth = overrides.rimWidth
  if (overrides.rimTail !== undefined) merged.rimTail = overrides.rimTail
  if (overrides.rimFocus !== undefined) merged.rimFocus = overrides.rimFocus
  if (overrides.rimAdded !== undefined) merged.rimAdded = overrides.rimAdded
  if (overrides.hairlineWidth !== undefined) merged.hairlineWidth = overrides.hairlineWidth
  if (overrides.hairlineSideAlpha !== undefined) merged.hairlineSideAlpha = overrides.hairlineSideAlpha
  if (overrides.hairlineCornerAlpha !== undefined) {
    merged.hairlineCornerAlpha = overrides.hairlineCornerAlpha
  }
  if (overrides.hairlineFlatAlpha !== undefined) merged.hairlineFlatAlpha = overrides.hairlineFlatAlpha
  if (overrides.shadowBlur !== undefined) merged.shadowBlur = overrides.shadowBlur
  if (overrides.shadowOffsetY !== undefined) merged.shadowOffsetY = overrides.shadowOffsetY
  if (overrides.shadowAlpha !== undefined) merged.shadowAlpha = overrides.shadowAlpha
  if ('borderWidth' in overrides) merged.borderWidth = overrides.borderWidth
  if ('borderRgba' in overrides) merged.borderRgba = overrides.borderRgba
  if ('rimBottomRatio' in overrides) merged.rimBottomRatio = overrides.rimBottomRatio
  return merged
}

/**
 * Builds a complete `OpticalMaterial` from a measured CSS glass surface and explicit theme/preset defaults.
 * Keeps `veil` (`brightness`/`contrast` affine optics) separate from `OpticalMaterial.contrast`, which
 * represents a signed shader offset rather than a CSS filter multiplier.
 */
export function buildMaterialFromCssSurface(
  measured: MeasuredCssGlassSurface,
  options?: BuildMaterialFromCssSurfaceOptions,
): OpticalMaterial {
  const theme = options?.theme ?? measured.theme
  const preset = options?.preset ?? 'frosted'
  const base = options?.baseMaterial ?? DEFAULT_OPTICAL_MATERIALS[theme][preset]

  const material = interpolateCssGlassSurfaceToMaterial(base, measured.surface, measured.surface, 1)

  if (measured.blurPx !== null) {
    material.blur = measured.blurPx
  }
  if (measured.saturation !== null) {
    material.saturation = measured.saturation
  }
  if (measured.backgroundRgba[3] > 0.001) {
    material.tintRgba = [
      measured.backgroundRgba[0],
      measured.backgroundRgba[1],
      measured.backgroundRgba[2],
      measured.backgroundRgba[3],
    ]
  }

  return applyMaterialOverrides(material, options?.overrides)
}

function toByteChannel(channel: number): number {
  if (!Number.isFinite(channel)) return 0
  return Math.round(clamp(channel, 0, 1) * 255)
}

/** Formats normalized `[0..1]` RGBA channels into a standard CSS `rgba(...)` string. */
export function formatRgbaCss(rgba: readonly [number, number, number, number]): string {
  const r = toByteChannel(rgba[0])
  const g = toByteChannel(rgba[1])
  const b = toByteChannel(rgba[2])
  const aRaw = Number.isFinite(rgba[3]) ? clamp(rgba[3], 0, 1) : 0
  const a = Number(aRaw.toFixed(4))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Formats normalized `[0..1]` RGBA into an opaque `rgb(...)` background for `'solid'` fallback mode. */
export function formatOpaqueSolidCss(
  rgba: readonly [number, number, number, number],
  theme: ThemeMode,
): string {
  if (!Number.isFinite(rgba[3]) || rgba[3] <= 0.001) {
    return theme === 'light' ? DEFAULT_LIGHT_SOLID : DEFAULT_DARK_SOLID
  }
  const r = toByteChannel(rgba[0])
  const g = toByteChannel(rgba[1])
  const b = toByteChannel(rgba[2])
  return `rgb(${r}, ${g}, ${b})`
}

/** Composes a standard CSS `backdrop-filter` declaration preserving affine brightness/contrast ordering. */
export function buildBackdropFilterCss({
  blurPx,
  saturation,
  veil,
}: BuildBackdropFilterCssParams): string {
  const parts: string[] = []

  if (Number.isFinite(blurPx) && blurPx > 0.01) {
    parts.push(`blur(${blurPx.toFixed(2)}px)`)
  }

  if (
    saturation !== undefined &&
    Number.isFinite(saturation) &&
    Math.abs(saturation - 1) > 1e-4
  ) {
    parts.push(`saturate(${Number(Math.max(0, saturation).toFixed(3))})`)
  }

  if (veil) {
    const hasBrightness = Number.isFinite(veil.brightness) && Math.abs(veil.brightness - 1) > 1e-4
    const hasContrast = Number.isFinite(veil.contrast) && Math.abs(veil.contrast - 1) > 1e-4
    const bToken = hasBrightness
      ? `brightness(${Number(Math.max(0, veil.brightness).toFixed(4))})`
      : null
    const cToken = hasContrast
      ? `contrast(${Number(Math.max(0, veil.contrast).toFixed(4))})`
      : null

    if (veil.contrastFirst) {
      if (cToken) parts.push(cToken)
      if (bToken) parts.push(bToken)
    } else {
      if (bToken) parts.push(bToken)
      if (cToken) parts.push(cToken)
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'none'
}
