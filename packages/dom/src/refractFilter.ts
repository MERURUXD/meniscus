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
  DEFAULT_REFRACTION_IOR,
  buildColorOpticsMatrix,
  createRefractMapBuilder,
  resolveRefractTiles,
  type GlassFieldState,
  type GlassPrimitive,
  type Rect,
  type RefractMapBuilder,
  type RefractionProfileSpec,
} from '@sessile/core'

export const SVG_NS = 'http://www.w3.org/2000/svg'
const FULL_RES_MAP_THRESHOLD_PX = 128
const MIN_ACTIVE_SIZE = 0.01
const MIN_NINE_SLICE_DIM = 4

export interface RefractFilterConfig {
  /** Bezel lens rim width in CSS px; `0` selects `computeAutoBezel` from active primitives. */
  bezel?: number
  /** Dimensionless thickness-to-bezel ratio controlling Snell ray deflection (`0` disables refraction). */
  strength?: number
  /** Chromatic RGB dispersion delta in px (`0` uses a single displacement map pass). */
  dispersion?: number
  /** Extra scale factor applied to computed displacement strength (defaults to `1`). */
  scaleMultiplier?: number
  /** Base resolution multiplier for Stored-PNG displacement maps (defaults to `0.5`). */
  mapScale?: number
  /** Bezel refraction cross-section profile (`'squircle'`, `'circle'`, `'parabolic'`, `'lip'`, or custom height fn). */
  profile?: RefractionProfileSpec
  /** Index of refraction (`1` = air, `1.5` = glass; defaults to `1.5`). */
  ior?: number
  /** Allow steep-edge caustic folds (defaults to `false`). */
  caustics?: boolean
  /** Enable 9-slice tile fast path for single-primitive rounded rects (defaults to `true`). */
  nineSlice?: boolean
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
  scaleMultiplier: number
  mapScale: number
  profile: RefractionProfileSpec
  ior: number
  caustics: boolean
  nineSlice: boolean
}

interface DisplacementNodeBinding {
  element: Element
  offsetSign: number
}

interface NineSlicePiece {
  element: Element
  mergeNode: Element
}

interface NineSliceNodes {
  center: NineSlicePiece
  top: NineSlicePiece
  bottom: NineSlicePiece
  left: NineSlicePiece
  right: NineSlicePiece
  tl: NineSlicePiece
  tr: NineSlicePiece
  bl: NineSlicePiece
  br: NineSlicePiece
  merge: Element
  attached: Element[]
  activeMask: number
  prevTileKey: string
  prevGeomKey: string
}

function normalizePositiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeNonNegativeOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeIorOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, value) : fallback
}

function normalizeConfig(input?: RefractFilterConfig, base?: NormalizedConfig): NormalizedConfig {
  const b = base ?? {
    bezel: 0,
    strength: 1.32,
    dispersion: 0,
    scaleMultiplier: 1,
    mapScale: 0.5,
    profile: 'squircle',
    ior: DEFAULT_REFRACTION_IOR,
    caustics: false,
    nineSlice: true,
  }
  return {
    bezel: normalizeNonNegativeOrDefault(input?.bezel, b.bezel),
    strength: normalizeNonNegativeOrDefault(input?.strength, b.strength),
    dispersion: normalizeNonNegativeOrDefault(input?.dispersion, b.dispersion),
    scaleMultiplier: normalizeNonNegativeOrDefault(input?.scaleMultiplier, b.scaleMultiplier),
    mapScale: normalizePositiveOrDefault(input?.mapScale, b.mapScale),
    profile: input?.profile !== undefined ? input.profile : b.profile,
    ior: normalizeIorOrDefault(input?.ior, b.ior),
    caustics: input?.caustics !== undefined ? Boolean(input.caustics) : b.caustics,
    nineSlice: input?.nineSlice !== undefined ? Boolean(input.nineSlice) : b.nineSlice,
  }
}

function isNearInt(v: number): boolean {
  return Math.abs(v - Math.round(v)) < 1e-3
}

function formatSvgCoord(v: number): string {
  return Math.abs(v - Math.round(v)) < 1e-4 ? String(Math.round(v)) : v.toFixed(3)
}

function findSingleActivePrimitive(field: GlassFieldState): GlassPrimitive | null {
  let single: GlassPrimitive | null = null
  const primitives = field.primitives
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i]!
    if (p.size.width > MIN_ACTIVE_SIZE && p.size.height > MIN_ACTIVE_SIZE) {
      if (single !== null) {
        return null
      }
      single = p
    }
  }
  return single
}

function setElementRect(el: Element, x: number, y: number, w: number, h: number): void {
  el.setAttribute('x', formatSvgCoord(x))
  el.setAttribute('y', formatSvgCoord(y))
  el.setAttribute('width', formatSvgCoord(w))
  el.setAttribute('height', formatSvgCoord(h))
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
  let currentMapMode: 'full' | 'nine-slice' = 'full'
  let nineSliceNodes: NineSliceNodes | null = null

  let prevWidth = -1
  let prevHeight = -1
  let prevSigma = ''
  let prevMatrix = ''
  let prevScaleKey = ''
  let disposed = false
  let mapBuilder: RefractMapBuilder | null = null

  const createFloodPiece = (resultName: string): NineSlicePiece => {
    const element = createSvgEl('feFlood')
    element.setAttribute('flood-color', 'rgb(128, 128, 128)')
    element.setAttribute('result', resultName)
    const mergeNode = createSvgEl('feMergeNode')
    mergeNode.setAttribute('in', resultName)
    return { element, mergeNode }
  }

  const createTilePiece = (resultName: string): NineSlicePiece => {
    const element = createSvgEl('feImage')
    element.setAttribute('preserveAspectRatio', 'none')
    element.setAttribute('result', resultName)
    const mergeNode = createSvgEl('feMergeNode')
    mergeNode.setAttribute('in', resultName)
    return { element, mergeNode }
  }

  const ensureNineSliceNodes = (): NineSliceNodes => {
    if (nineSliceNodes) return nineSliceNodes
    const merge = createSvgEl('feMerge')
    merge.setAttribute('result', 'map')
    nineSliceNodes = {
      center: createFloodPiece('ns-center'),
      top: createTilePiece('ns-top'),
      bottom: createTilePiece('ns-bottom'),
      left: createTilePiece('ns-left'),
      right: createTilePiece('ns-right'),
      tl: createTilePiece('ns-tl'),
      tr: createTilePiece('ns-tr'),
      bl: createTilePiece('ns-bl'),
      br: createTilePiece('ns-br'),
      merge,
      attached: [],
      activeMask: -1,
      prevTileKey: '',
      prevGeomKey: '',
    }
    return nineSliceNodes
  }

  const detachNineSliceNodes = (ns: NineSliceNodes): void => {
    for (let i = 0; i < ns.attached.length; i++) {
      const node = ns.attached[i]!
      if (node.parentNode) {
        node.parentNode.removeChild(node)
      }
    }
    ns.attached = []
    while (ns.merge.firstChild) {
      ns.merge.removeChild(ns.merge.firstChild)
    }
  }

  const activateFullMapMode = (): void => {
    if (currentMapMode === 'full') return
    if (nineSliceNodes) {
      detachNineSliceNodes(nineSliceNodes)
      nineSliceNodes.activeMask = -1
    }
    if (feImageEl.parentNode !== filterEl) {
      filterEl.insertBefore(feImageEl, bgBlurEl)
    }
    prevWidth = -1
    prevHeight = -1
    mapBuilder?.reset()
    currentMapMode = 'full'
  }

  const activateNineSliceMode = (mask: number): NineSliceNodes => {
    const ns = ensureNineSliceNodes()
    if (currentMapMode !== 'nine-slice') {
      if (feImageEl.parentNode) {
        feImageEl.parentNode.removeChild(feImageEl)
      }
      currentMapMode = 'nine-slice'
      ns.activeMask = -1
      ns.prevTileKey = ''
      ns.prevGeomKey = ''
    }
    if (ns.activeMask === mask) {
      return ns
    }

    detachNineSliceNodes(ns)

    const appendPiece = (piece: NineSlicePiece): void => {
      filterEl.insertBefore(piece.element, bgBlurEl)
      ns.attached.push(piece.element)
      ns.merge.appendChild(piece.mergeNode)
    }

    // Painter's order: plateau center -> edge strips -> corners so corners cover the strip overlap.
    if ((mask & 1) !== 0) appendPiece(ns.center)
    if ((mask & 2) !== 0) {
      appendPiece(ns.top)
      appendPiece(ns.bottom)
    }
    if ((mask & 4) !== 0) {
      appendPiece(ns.left)
      appendPiece(ns.right)
    }
    appendPiece(ns.tl)
    appendPiece(ns.tr)
    appendPiece(ns.bl)
    appendPiece(ns.br)

    filterEl.insertBefore(ns.merge, bgBlurEl)
    ns.attached.push(ns.merge)
    ns.activeMask = mask
    return ns
  }

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
    const scaleMultiplier =
      frame.scaleMultiplier !== undefined
        ? normalizeNonNegativeOrDefault(frame.scaleMultiplier, config.scaleMultiplier)
        : config.scaleMultiplier
    const rawMapScale =
      frame.mapScale !== undefined
        ? normalizePositiveOrDefault(frame.mapScale, config.mapScale)
        : config.mapScale
    const profile = frame.profile !== undefined ? frame.profile : config.profile
    const ior =
      frame.ior !== undefined ? normalizeIorOrDefault(frame.ior, config.ior) : config.ior
    const caustics =
      frame.caustics !== undefined ? Boolean(frame.caustics) : config.caustics
    const nineSlice =
      frame.nineSlice !== undefined ? Boolean(frame.nineSlice) : config.nineSlice

    rebuildDisplacementStage(dispersion > 0)

    const frameBezel = resolveFieldBezel(requestedBezel, frame.field)
    let maxDisplacementPx = 0
    let usedNineSlice = false

    if (nineSlice) {
      const single = findSingleActivePrimitive(frame.field)
      if (
        single &&
        single.size.width >= MIN_NINE_SLICE_DIM &&
        single.size.height >= MIN_NINE_SLICE_DIM
      ) {
        const rectW = single.size.width
        const rectH = single.size.height
        const rectX = single.center.x - rectW * 0.5 - frame.bounds.x
        const rectY = single.center.y - rectH * 0.5 - frame.bounds.y
        const minHalf = Math.min(rectW, rectH) * 0.5
        const rad = Math.max(0, Math.min(single.radius, minHalf))
        const effBezel = Math.max(1e-3, Math.min(frameBezel, minHalf))
        const slice = Math.min(Math.ceil(Math.max(rad, effBezel)), minHalf)
        const span = rectW - 2 * slice
        const rise = rectH - 2 * slice
        const canNineSlice =
          slice >= 2 &&
          (span > 1e-3 || isNearInt(rectX + slice)) &&
          (rise > 1e-3 || isNearInt(rectY + slice))

        if (canNineSlice) {
          const tiles = resolveRefractTiles({
            radius: rad,
            bezel: effBezel,
            slice,
            profile,
            ior,
            thicknessRatio: strength,
            caustics,
          })
          const hasHStrips = span > 1e-3
          const hasVStrips = rise > 1e-3
          const hasCenter = hasHStrips && hasVStrips
          const mask = (hasCenter ? 1 : 0) | (hasHStrips ? 2 : 0) | (hasVStrips ? 4 : 0)
          const ns = activateNineSliceMode(mask)

          if (tiles.key !== ns.prevTileKey) {
            // Sync all 8 tile URLs even if strip pieces are omitted in the current mask
            // so a subsequent resize enabling them already has valid tile hrefs.
            ns.tl.element.setAttribute('href', tiles.tl)
            ns.tr.element.setAttribute('href', tiles.tr)
            ns.bl.element.setAttribute('href', tiles.bl)
            ns.br.element.setAttribute('href', tiles.br)
            ns.top.element.setAttribute('href', tiles.top)
            ns.bottom.element.setAttribute('href', tiles.bottom)
            ns.left.element.setAttribute('href', tiles.left)
            ns.right.element.setAttribute('href', tiles.right)
            ns.prevTileKey = tiles.key
          }

          const geomKey =
            `${formatSvgCoord(rectX)}:${formatSvgCoord(rectY)}:` +
            `${formatSvgCoord(rectW)}:${formatSvgCoord(rectH)}:` +
            `${formatSvgCoord(slice)}:${mask}`
          if (geomKey !== ns.prevGeomKey) {
            const pad = Math.min(1, slice * 0.25)
            if (hasCenter) {
              setElementRect(
                ns.center.element,
                rectX + slice - pad,
                rectY + slice - pad,
                span + 2 * pad,
                rise + 2 * pad,
              )
            }
            if (hasHStrips) {
              setElementRect(ns.top.element, rectX + slice - pad, rectY, span + 2 * pad, slice)
              setElementRect(
                ns.bottom.element,
                rectX + slice - pad,
                rectY + rectH - slice,
                span + 2 * pad,
                slice,
              )
            }
            if (hasVStrips) {
              setElementRect(ns.left.element, rectX, rectY + slice - pad, slice, rise + 2 * pad)
              setElementRect(
                ns.right.element,
                rectX + rectW - slice,
                rectY + slice - pad,
                slice,
                rise + 2 * pad,
              )
            }
            setElementRect(ns.tl.element, rectX, rectY, slice, slice)
            setElementRect(ns.tr.element, rectX + rectW - slice, rectY, slice, slice)
            setElementRect(ns.bl.element, rectX, rectY + rectH - slice, slice, slice)
            setElementRect(ns.br.element, rectX + rectW - slice, rectY + rectH - slice, slice, slice)
            ns.prevGeomKey = geomKey
          }

          maxDisplacementPx = tiles.maxDisplacementPx
          usedNineSlice = true
        }
      }
    }

    if (!usedNineSlice) {
      activateFullMapMode()
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
        mapScale: frameMapScale,
        profile,
        ior,
        thicknessRatio: strength,
        caustics,
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
      maxDisplacementPx = mapResult.maxDisplacementPx
    }

    const baseScale = Math.max(0, 2 * maxDisplacementPx * scaleMultiplier)
    // Guard against phantom single-channel blue/red edge shifts when base refraction is zero.
    const effectiveDispersion = baseScale > 0 ? Math.min(dispersion, baseScale * 0.5) : 0
    const scaleKey = `${baseScale.toFixed(2)}:${effectiveDispersion.toFixed(2)}`
    if (scaleKey !== prevScaleKey) {
      for (let i = 0; i < dispNodes.length; i++) {
        const binding = dispNodes[i]!
        const scale = Math.max(0, baseScale + binding.offsetSign * effectiveDispersion)
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
    if (nineSliceNodes) {
      detachNineSliceNodes(nineSliceNodes)
      nineSliceNodes = null
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
