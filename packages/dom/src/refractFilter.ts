/**
 * Headless Route B3 SVG `<filter>` DOM controller for Chromium liquid-glass refraction.
 *
 * Manages an off-screen SVG filter graph driven by `@sessile/core`'s Stored-PNG
 * displacement map (`createRefractMapBuilder`) and Rec.709 color optics matrix
 * (`buildColorOpticsMatrix`), dynamically switching between single-pass displacement
 * and 3-channel RGB chromatic dispersion while self-masking to the displacement map alpha
 * to avoid rectangular `backdrop-filter` bounds leakage.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  buildColorOpticsMatrix,
  createRefractMapBuilder,
  type GlassFieldState,
  type Rect,
  type RefractMapBuilder,
} from '@sessile/core'

export const SVG_NS = 'http://www.w3.org/2000/svg'
const FULL_RES_MAP_THRESHOLD_PX = 128
const MIN_ACTIVE_SIZE = 0.01

export interface RefractFilterConfig {
  /** Bezel lens rim width in CSS px; `0` selects `computeAutoBezel` from active primitives. */
  bezel?: number
  /** Dimensionless refraction multiplier (lens displacement peak = bezel * strength * scaleMultiplier). */
  strength?: number
  /** Chromatic RGB dispersion delta in px (`0` uses a single displacement map pass). */
  dispersion?: number
  /** Rim lens curvature exponent (higher concentrates refraction closer to the outer perimeter). */
  falloff?: number
  /** Extra scale factor applied to computed displacement strength (defaults to `1`). */
  scaleMultiplier?: number
  /** Base resolution multiplier for Stored-PNG displacement maps (defaults to `0.5`). */
  mapScale?: number
}

export interface RefractFilterFrame extends RefractFilterConfig {
  bounds: Rect
  field: GlassFieldState
  blurSigma: number
  saturate: number
  brightness: number
  contrast: number
  contrastFirst?: boolean
}

export interface RefractFilterControllerOptions extends RefractFilterConfig {
  id: string
  document?: Document
  mountTarget?: Element | null
}

export interface RefractFilterController {
  readonly id: string
  readonly svgElement: SVGSVGElement | null
  readonly mounted: boolean
  mount(target?: Element | null): boolean
  updateConfig(config: Partial<RefractFilterConfig>): void
  updateFrame(frame: RefractFilterFrame): void
  dispose(): void
}

interface NormalizedConfig {
  bezel: number
  strength: number
  dispersion: number
  falloff: number
  scaleMultiplier: number
  mapScale: number
}

interface DisplacementNodeBinding {
  element: Element
  offsetSign: number
}

function normalizePositiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeNonNegativeOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeConfig(input?: RefractFilterConfig, base?: NormalizedConfig): NormalizedConfig {
  const b = base ?? {
    bezel: 0,
    strength: 1.32,
    dispersion: 0,
    falloff: 2.6,
    scaleMultiplier: 1,
    mapScale: 0.5,
  }
  return {
    bezel: normalizeNonNegativeOrDefault(input?.bezel, b.bezel),
    strength: normalizeNonNegativeOrDefault(input?.strength, b.strength),
    dispersion: normalizeNonNegativeOrDefault(input?.dispersion, b.dispersion),
    falloff: normalizeNonNegativeOrDefault(input?.falloff, b.falloff),
    scaleMultiplier: normalizeNonNegativeOrDefault(input?.scaleMultiplier, b.scaleMultiplier),
    mapScale: normalizePositiveOrDefault(input?.mapScale, b.mapScale),
  }
}

/** Computes automatic lens bezel width (clamped to `[6, 22]` CSS px) from element dimensions. */
export function computeAutoBezel(width: number, height: number): number {
  const minDim = Math.max(0, Math.min(width, height))
  return Math.max(6, Math.min(22, minDim * 0.3))
}

/** Resolves effective bezel width across all active primitives in an N-primitive glass field. */
export function resolveFieldBezel(requestedBezel: number, field: GlassFieldState): number {
  let refW = 0
  let refH = 0
  let hasActive = false

  for (let i = 0; i < field.primitives.length; i++) {
    const p = field.primitives[i]!
    if (p.size.width > MIN_ACTIVE_SIZE && p.size.height > MIN_ACTIVE_SIZE) {
      if (p.size.width > refW) refW = p.size.width
      if (p.size.height > refH) refH = p.size.height
      hasActive = true
    }
  }

  if (!hasActive) {
    return requestedBezel > 0 ? Math.max(1, requestedBezel) : 6
  }

  return requestedBezel > 0
    ? Math.max(1, Math.min(requestedBezel, refW * 0.5, refH * 0.5))
    : computeAutoBezel(refW, refH)
}

/** Creates an imperative SVG `<filter>` controller implementing Route B3 self-masked refraction. */
export function createRefractFilterController(
  options: RefractFilterControllerOptions,
): RefractFilterController {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : null)
  const id = options.id
  let config = normalizeConfig(options)

  if (!doc || typeof doc.createElementNS !== 'function') {
    return {
      id,
      svgElement: null,
      mounted: false,
      mount: () => false,
      updateConfig(next) {
        config = normalizeConfig(next, config)
      },
      updateFrame: () => {},
      dispose: () => {},
    }
  }

  const createSvgEl = (tag: string): Element => doc.createElementNS(SVG_NS, tag)

  const svgEl = createSvgEl('svg') as SVGSVGElement
  svgEl.setAttribute('aria-hidden', 'true')
  if (svgEl.style) {
    svgEl.style.position = 'fixed'
    svgEl.style.top = '0'
    svgEl.style.left = '0'
    svgEl.style.width = '0'
    svgEl.style.height = '0'
    svgEl.style.overflow = 'hidden'
    svgEl.style.pointerEvents = 'none'
    svgEl.style.opacity = '0'
  }

  const defsEl = createSvgEl('defs')
  const filterEl = createSvgEl('filter')
  filterEl.setAttribute('id', id)
  filterEl.setAttribute('color-interpolation-filters', 'sRGB')
  filterEl.setAttribute('x', '0%')
  filterEl.setAttribute('y', '0%')
  filterEl.setAttribute('width', '100%')
  filterEl.setAttribute('height', '100%')

  const feImageEl = createSvgEl('feImage')
  feImageEl.setAttribute('x', '0')
  feImageEl.setAttribute('y', '0')
  feImageEl.setAttribute('width', '1')
  feImageEl.setAttribute('height', '1')
  feImageEl.setAttribute('preserveAspectRatio', 'none')
  feImageEl.setAttribute('result', 'map')

  const bgBlurEl = createSvgEl('feGaussianBlur')
  bgBlurEl.setAttribute('in', 'SourceGraphic')
  bgBlurEl.setAttribute('stdDeviation', '0')
  bgBlurEl.setAttribute('edgeMode', 'duplicate')
  bgBlurEl.setAttribute('result', 'bgBlur')

  const colorMatrixEl = createSvgEl('feColorMatrix')
  colorMatrixEl.setAttribute('in', 'bgBlur')
  colorMatrixEl.setAttribute('type', 'matrix')
  colorMatrixEl.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0')
  colorMatrixEl.setAttribute('result', 'bgOptics')

  const refractSmoothEl = createSvgEl('feGaussianBlur')
  refractSmoothEl.setAttribute('in', 'refractRaw')
  refractSmoothEl.setAttribute('stdDeviation', '0.5')
  refractSmoothEl.setAttribute('edgeMode', 'duplicate')
  refractSmoothEl.setAttribute('result', 'refractSmooth')

  const glassOnlyEl = createSvgEl('feComposite')
  glassOnlyEl.setAttribute('in', 'refractSmooth')
  glassOnlyEl.setAttribute('in2', 'map')
  glassOnlyEl.setAttribute('operator', 'in')
  glassOnlyEl.setAttribute('result', 'glassOnly')

  const mergeEl = createSvgEl('feMerge')
  const mergeBaseEl = createSvgEl('feMergeNode')
  mergeBaseEl.setAttribute('in', 'SourceGraphic')
  const mergeGlassEl = createSvgEl('feMergeNode')
  mergeGlassEl.setAttribute('in', 'glassOnly')
  mergeEl.appendChild(mergeBaseEl)
  mergeEl.appendChild(mergeGlassEl)

  filterEl.appendChild(feImageEl)
  filterEl.appendChild(bgBlurEl)
  filterEl.appendChild(colorMatrixEl)
  filterEl.appendChild(refractSmoothEl)
  filterEl.appendChild(glassOnlyEl)
  filterEl.appendChild(mergeEl)
  defsEl.appendChild(filterEl)
  svgEl.appendChild(defsEl)

  let stageNodes: Element[] = []
  let dispNodes: DisplacementNodeBinding[] = []
  let currentDispersive: boolean | null = null

  let prevWidth = -1
  let prevHeight = -1
  let prevSigma = ''
  let prevMatrix = ''
  let prevScaleKey = ''
  let disposed = false
  let mapBuilder: RefractMapBuilder | null = null

  const rebuildDisplacementStage = (dispersive: boolean): void => {
    if (currentDispersive === dispersive) {
      return
    }
    for (let i = 0; i < stageNodes.length; i++) {
      const node = stageNodes[i]!
      if (node.parentNode) {
        node.parentNode.removeChild(node)
      }
    }
    stageNodes = []
    dispNodes = []

    const appendStageNode = (node: Element): void => {
      filterEl.insertBefore(node, refractSmoothEl)
      stageNodes.push(node)
    }

    if (dispersive) {
      const channels = ['R', 'G', 'B'] as const
      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i]!
        const transferEl = createSvgEl('feComponentTransfer')
        transferEl.setAttribute('in', 'bgOptics')
        transferEl.setAttribute('result', `input-${ch}`)

        const funcR = createSvgEl('feFuncR')
        funcR.setAttribute('type', 'linear')
        funcR.setAttribute('slope', ch === 'R' ? '1' : '0')
        const funcG = createSvgEl('feFuncG')
        funcG.setAttribute('type', 'linear')
        funcG.setAttribute('slope', ch === 'G' ? '1' : '0')
        const funcB = createSvgEl('feFuncB')
        funcB.setAttribute('type', 'linear')
        funcB.setAttribute('slope', ch === 'B' ? '1' : '0')

        transferEl.appendChild(funcR)
        transferEl.appendChild(funcG)
        transferEl.appendChild(funcB)
        appendStageNode(transferEl)

        const dispEl = createSvgEl('feDisplacementMap')
        dispEl.setAttribute('in', `input-${ch}`)
        dispEl.setAttribute('in2', 'map')
        dispEl.setAttribute('xChannelSelector', 'R')
        dispEl.setAttribute('yChannelSelector', 'G')
        dispEl.setAttribute('scale', '0')
        dispEl.setAttribute('result', `lens-${ch}`)
        appendStageNode(dispEl)
        dispNodes.push({ element: dispEl, offsetSign: i - 1 })
      }

      const compRg = createSvgEl('feComposite')
      compRg.setAttribute('in', 'lens-R')
      compRg.setAttribute('in2', 'lens-G')
      compRg.setAttribute('operator', 'arithmetic')
      compRg.setAttribute('k1', '0')
      compRg.setAttribute('k2', '1')
      compRg.setAttribute('k3', '1')
      compRg.setAttribute('k4', '0')
      compRg.setAttribute('result', 'rg')
      appendStageNode(compRg)

      const compRgb = createSvgEl('feComposite')
      compRgb.setAttribute('in', 'rg')
      compRgb.setAttribute('in2', 'lens-B')
      compRgb.setAttribute('operator', 'arithmetic')
      compRgb.setAttribute('k1', '0')
      compRgb.setAttribute('k2', '1')
      compRgb.setAttribute('k3', '1')
      compRgb.setAttribute('k4', '0')
      compRgb.setAttribute('result', 'refractRaw')
      appendStageNode(compRgb)
    } else {
      const dispEl = createSvgEl('feDisplacementMap')
      dispEl.setAttribute('in', 'bgOptics')
      dispEl.setAttribute('in2', 'map')
      dispEl.setAttribute('xChannelSelector', 'R')
      dispEl.setAttribute('yChannelSelector', 'G')
      dispEl.setAttribute('scale', '0')
      dispEl.setAttribute('result', 'refractRaw')
      appendStageNode(dispEl)
      dispNodes.push({ element: dispEl, offsetSign: 0 })
    }

    currentDispersive = dispersive
    // Force scale re-sync immediately after swapping displacement DOM nodes.
    prevScaleKey = ''
  }

  rebuildDisplacementStage(config.dispersion > 0)

  const mount = (target?: Element | null): boolean => {
    if (disposed) return false
    const resolvedTarget = target ?? options.mountTarget ?? doc.body ?? doc.documentElement
    if (!resolvedTarget) return false
    if (svgEl.parentNode === resolvedTarget) {
      return true
    }
    resolvedTarget.appendChild(svgEl)
    return true
  }

  const updateConfig = (next: Partial<RefractFilterConfig>): void => {
    if (disposed) return
    config = normalizeConfig(next, config)
    rebuildDisplacementStage(config.dispersion > 0)
  }

  const updateFrame = (frame: RefractFilterFrame): void => {
    if (disposed) return

    const requestedBezel =
      frame.bezel !== undefined ? normalizeNonNegativeOrDefault(frame.bezel, config.bezel) : config.bezel
    const strength =
      frame.strength !== undefined
        ? normalizeNonNegativeOrDefault(frame.strength, config.strength)
        : config.strength
    const dispersion =
      frame.dispersion !== undefined
        ? normalizeNonNegativeOrDefault(frame.dispersion, config.dispersion)
        : config.dispersion
    const falloff =
      frame.falloff !== undefined
        ? normalizeNonNegativeOrDefault(frame.falloff, config.falloff)
        : config.falloff
    const scaleMultiplier =
      frame.scaleMultiplier !== undefined
        ? normalizeNonNegativeOrDefault(frame.scaleMultiplier, config.scaleMultiplier)
        : config.scaleMultiplier
    const rawMapScale =
      frame.mapScale !== undefined
        ? normalizePositiveOrDefault(frame.mapScale, config.mapScale)
        : config.mapScale

    rebuildDisplacementStage(dispersion > 0)

    const frameBezel = resolveFieldBezel(requestedBezel, frame.field)
    // Promote half-res maps to 1:1 for compact pills/buttons so rim displacement stays crisp.
    const frameMapScale =
      rawMapScale === 0.5 && Math.max(frame.bounds.width, frame.bounds.height) <= FULL_RES_MAP_THRESHOLD_PX
        ? 1
        : rawMapScale

    mapBuilder ??= createRefractMapBuilder()
    const mapResult = mapBuilder.build({
      bounds: frame.bounds,
      field: frame.field,
      bezel: frameBezel,
      falloff,
      mapScale: frameMapScale,
    })

    if (mapResult.width !== prevWidth || mapResult.height !== prevHeight) {
      feImageEl.setAttribute('width', String(mapResult.width))
      feImageEl.setAttribute('height', String(mapResult.height))
      prevWidth = mapResult.width
      prevHeight = mapResult.height
    }
    if (mapResult.changed) {
      feImageEl.setAttribute('href', mapResult.dataUrl)
    }

    const baseScale = Math.max(0, 2 * frameBezel * strength * scaleMultiplier)
    const scaleKey = `${baseScale.toFixed(2)}:${dispersion}`
    if (scaleKey !== prevScaleKey) {
      for (let i = 0; i < dispNodes.length; i++) {
        const binding = dispNodes[i]!
        const scale = Math.max(0, baseScale + binding.offsetSign * dispersion)
        binding.element.setAttribute('scale', String(scale))
      }
      prevScaleKey = scaleKey
    }

    const sigma =
      Number.isFinite(frame.blurSigma) && frame.blurSigma > 0.05
        ? frame.blurSigma.toFixed(2)
        : '0'
    if (sigma !== prevSigma) {
      bgBlurEl.setAttribute('stdDeviation', sigma)
      prevSigma = sigma
    }

    const matrix = buildColorOpticsMatrix(
      frame.saturate,
      frame.brightness,
      frame.contrast,
      frame.contrastFirst,
    )
    if (matrix !== prevMatrix) {
      colorMatrixEl.setAttribute('values', matrix)
      prevMatrix = matrix
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (svgEl.parentNode) {
      svgEl.parentNode.removeChild(svgEl)
    }
    stageNodes = []
    dispNodes = []
    mapBuilder?.reset()
    mapBuilder = null
  }

  return {
    id,
    get svgElement() {
      return disposed ? null : svgEl
    },
    get mounted() {
      return !disposed && svgEl.parentNode !== null
    },
    mount,
    updateConfig,
    updateFrame,
    dispose,
  }
}
