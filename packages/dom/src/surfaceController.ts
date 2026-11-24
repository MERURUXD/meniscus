/**
 * Framework-agnostic headless 3-layer DOM surface controller for Sessile.
 *
 * Orchestrates three sibling layers around live interactive DOM content:
 * 1. `refractBackdrop` (unclipped Route B3 Chromium SVG `backdrop-filter: url(#id)` layer)
 * 2. `veil` (SDF contour-clipped tint/frosted layer, also serving Safari/Firefox/solid fallback)
 * 3. `overlayCanvas` (transparent WebGL2/2D Canvas perimeter highlight and outer shadow layer)
 *
 * Keeps live DOM interactive text/controls positioned cleanly between `veil` and `overlayCanvas`,
 * applies lazy SVG filter mounting, and reuses preallocated structures on the 60/120fps hot path.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_OPTICAL_MATERIALS,
  clamp,
  computeFieldBounds,
  createGlassOverlayRenderer,
  extractFieldContourPath,
  type BackdropVeilOptics,
  type GlassFieldState,
  type GlassPrimitive,
  type IGlassOverlayRenderer,
  type OpticalMaterial,
  type Rect,
  type RendererCapabilities,
  type Size,
  type ThemeMode,
} from '@sessile/core'
import {
  createFrameLoop,
  detectSurfaceCapabilities,
  measureElementBorderBox,
  observeElementResize,
  observeReducedMotion,
  resolveEffectiveRenderMode,
  type CapabilityEnv,
  type FrameLoop,
  type FrameScheduler,
  type SurfaceCapabilities,
  type SurfaceRenderMode,
} from './capabilities.ts'
import {
  buildBackdropFilterCss,
  formatOpaqueSolidCss,
  formatRgbaCss,
  resolveElementTheme,
} from './cssSurface.ts'
import {
  createRefractFilterController,
  type RefractFilterConfig,
  type RefractFilterController,
} from './refractFilter.ts'

const MIN_ACTIVE_SIZE = 0.01
const MIN_VISIBLE_OPACITY = 0.005
const REFRACT_MARGIN_PX = 6

const DEFAULT_VEIL_OPTICS: BackdropVeilOptics = {
  brightness: 1,
  contrast: 1,
  contrastFirst: false,
}

const EMPTY_OVERLAY_CAPABILITIES: RendererCapabilities = {
  webgl2: false,
  floatFbo: false,
  maxTextureSize: 0,
}

let nextAutoFilterId = 1

export interface GlassSurfaceElements {
  refractBackdrop?: HTMLElement | null
  veil?: HTMLElement | null
  overlayCanvas?: HTMLCanvasElement | null
}

export interface GlassSurfaceZIndex {
  refract?: number | string
  veil?: number | string
  overlay?: number | string
}

export interface GlassSurfaceCapabilities extends SurfaceCapabilities {
  overlay: RendererCapabilities
}

export interface GlassSurfaceFrame {
  field: GlassFieldState
  bounds?: Rect
  refractBounds?: Rect
  material?: OpticalMaterial
  veilOptics?: BackdropVeilOptics
  opacity?: number
  theme?: ThemeMode
  blurBumpPx?: number
  dpr?: number
  solidBackground?: string
  frostedBackground?: string
  refractTintBackground?: string
  refraction?: Partial<RefractFilterConfig>
}

export type SurfaceFrameProducer = (
  dtSec: number,
  nowMs: number,
) => GlassSurfaceFrame | boolean | void

export interface GlassSurfaceControllerOptions {
  container?: HTMLElement | null
  elements?: GlassSurfaceElements
  /** Reference child before which managed backdrop siblings (`refractBackdrop`, `veil`) are inserted. */
  insertBackdropBefore?: Node | null
  mode?: SurfaceRenderMode
  theme?: ThemeMode
  material?: OpticalMaterial
  refraction?: Partial<RefractFilterConfig>
  filterId?: string
  svgMountTarget?: Element | null
  positioning?: 'absolute' | 'fixed'
  zIndex?: GlassSurfaceZIndex
  disableRefractOnReducedMotion?: boolean
  observeResize?: boolean | Element
  onResize?: (size: Size) => void
  onCapabilitiesChange?: (capabilities: GlassSurfaceCapabilities) => void
  document?: Document
  env?: CapabilityEnv
  overlayRenderer?: IGlassOverlayRenderer
  scheduler?: Partial<FrameScheduler>
  ResizeObserverCtor?: typeof ResizeObserver
}

interface MutablePrimitive {
  id?: string
  center: { x: number; y: number }
  size: { width: number; height: number }
  radius: number
  weight?: number
}

interface LayerStyleCache {
  visibility?: string
  transform?: string
  width?: string
  height?: string
  clipPath?: string
  backdropFilter?: string
  background?: string
  opacity?: string
}

function hasActivePrimitive(field: GlassFieldState): boolean {
  for (let i = 0; i < field.primitives.length; i++) {
    const p = field.primitives[i]!
    if (p.size.width > MIN_ACTIVE_SIZE && p.size.height > MIN_ACTIVE_SIZE) {
      return true
    }
  }
  return false
}

function resolveCurrentDpr(explicitDpr?: number): number {
  if (explicitDpr !== undefined && Number.isFinite(explicitDpr) && explicitDpr > 0) {
    return explicitDpr
  }
  if (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0) {
    return window.devicePixelRatio
  }
  return 1
}

function setVisibilityCached(el: HTMLElement | null, cache: LayerStyleCache, value: 'visible' | 'hidden'): void {
  if (!el || cache.visibility === value) return
  el.style.visibility = value
  cache.visibility = value
}

function setTransformSizeCached(
  el: HTMLElement,
  cache: LayerStyleCache,
  bounds: Rect,
): void {
  const transform = `translate3d(${bounds.x}px, ${bounds.y}px, 0)`
  const width = `${bounds.width}px`
  const height = `${bounds.height}px`

  if (cache.transform !== transform) {
    el.style.transform = transform
    cache.transform = transform
  }
  if (cache.width !== width) {
    el.style.width = width
    cache.width = width
  }
  if (cache.height !== height) {
    el.style.height = height
    cache.height = height
  }
}

function setBackdropFilterCached(
  el: HTMLElement | null,
  cache: LayerStyleCache,
  value: string,
): void {
  if (!el || cache.backdropFilter === value) return
  el.style.backdropFilter = value
  if (typeof el.style.setProperty === 'function') {
    el.style.setProperty('-webkit-backdrop-filter', value)
  }
  cache.backdropFilter = value
}

/** A backdrop-filter that changes nothing but keeps the veil's filtered compositing state. */
const VEIL_IDENTITY_BACKDROP_FILTER = 'blur(0px)'

/**
 * Chromium (seen in 156) loses a composited element's `clip-path: path()` mask when its
 * backdrop-filter is removed and clips it to the path's bounding box instead, so a
 * frosted -> refract/solid switch left the veil tint as a rectangle. Once the veil has carried a
 * filter it keeps an identity one instead of `none`; a veil that never had one stays filter-free.
 */
function setVeilBackdropFilterCached(
  el: HTMLElement | null,
  cache: LayerStyleCache,
  value: string,
): void {
  const hadFilter = cache.backdropFilter !== undefined && cache.backdropFilter !== 'none'
  setBackdropFilterCached(
    el,
    cache,
    value === 'none' && hadFilter ? VEIL_IDENTITY_BACKDROP_FILTER : value,
  )
}

function setClipPathCached(el: HTMLElement, cache: LayerStyleCache, value: string): void {
  if (cache.clipPath === value) return
  el.style.clipPath = value
  cache.clipPath = value
}

function setBackgroundCached(el: HTMLElement, cache: LayerStyleCache, value: string): void {
  if (cache.background === value) return
  el.style.background = value
  cache.background = value
}

function setOpacityCached(el: HTMLElement, cache: LayerStyleCache, value: string): void {
  if (cache.opacity === value) return
  el.style.opacity = value
  cache.opacity = value
}

function applyManagedBaseLayerStyles(
  el: HTMLElement,
  positioning: 'absolute' | 'fixed',
  zIndex?: number | string,
  isolate?: boolean,
): void {
  el.setAttribute('aria-hidden', 'true')
  el.style.position = positioning
  el.style.top = '0'
  el.style.left = '0'
  el.style.pointerEvents = 'none'
  el.style.visibility = 'hidden'
  if (zIndex !== undefined) {
    el.style.zIndex = String(zIndex)
  }
  if (isolate) {
    el.style.isolation = 'isolate'
  }
}

/**
 * Computes integer-snapped surface overlay bounds expanding the active primitives by
 * outer shadow blur/offset and `smin` blend radius so contours and shadows never clip.
 */
export function computeAutoSurfaceBounds(
  field: GlassFieldState,
  material: OpticalMaterial,
): Rect {
  const shadowPad =
    material.shadowAlpha > 0.001
      ? Math.ceil(material.shadowBlur * 1.5 + Math.abs(material.shadowOffsetY) + 8)
      : 0
  const pad = Math.max(24, Math.ceil(Math.max(0, field.blendK)) + Math.max(8, shadowPad))
  const raw = computeFieldBounds(field, pad)
  if (raw.width <= 0 || raw.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  const minX = Math.floor(raw.x)
  const minY = Math.floor(raw.y)
  const maxX = Math.ceil(raw.x + raw.width)
  const maxY = Math.ceil(raw.y + raw.height)
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/**
 * Computes tight Route B3 refraction backdrop bounds clamped inside `surfaceBounds`
 * while preserving enough padding for multi-primitive `smin` liquid bridges.
 */
export function computeClampedRefractBounds(
  field: GlassFieldState,
  surfaceBounds: Rect,
): Rect {
  const sMinX = Math.floor(surfaceBounds.x)
  const sMinY = Math.floor(surfaceBounds.y)
  const sMaxX = Math.ceil(surfaceBounds.x + surfaceBounds.width)
  const sMaxY = Math.ceil(surfaceBounds.y + surfaceBounds.height)
  const fallbackSurface: Rect = {
    x: sMinX,
    y: sMinY,
    width: Math.max(1, sMaxX - sMinX),
    height: Math.max(1, sMaxY - sMinY),
  }

  const margin = Math.ceil(Math.max(0, field.blendK)) + REFRACT_MARGIN_PX
  const raw = computeFieldBounds(field, margin)
  if (raw.width <= 0 || raw.height <= 0) {
    return fallbackSurface
  }

  const minX = Math.max(sMinX, Math.floor(raw.x))
  const minY = Math.max(sMinY, Math.floor(raw.y))
  const maxX = Math.min(sMaxX, Math.ceil(raw.x + raw.width))
  const maxY = Math.min(sMaxY, Math.ceil(raw.y + raw.height))

  if (maxX <= minX || maxY <= minY) {
    return fallbackSurface
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

/**
 * Stateful headless controller coordinating the 3-layer DOM glass presentation,
 * Route B3 SVG refraction filter, progressive fallback, resize observation, and rAF loop.
 */
export class GlassSurfaceController {
  private readonly doc: Document | null
  private readonly container: HTMLElement | null
  private readonly svgMountTarget: Element | null | undefined
  private readonly filterId: string
  private readonly baseRefraction: Partial<RefractFilterConfig> | undefined
  private readonly defaultMaterial: OpticalMaterial | undefined
  private readonly disableRefractOnReducedMotion: boolean
  private readonly onResizeCallback: ((size: Size) => void) | undefined
  private readonly onCapabilitiesChangeCallback:
    | ((capabilities: GlassSurfaceCapabilities) => void)
    | undefined

  private readonly refractBackdropEl: HTMLElement | null
  private readonly veilEl: HTMLElement | null
  private readonly overlayCanvasEl: HTMLCanvasElement | null
  private readonly ownsRefractBackdrop: boolean
  private readonly ownsVeil: boolean
  private readonly ownsOverlayCanvas: boolean
  private prevContainerPosition: string | null = null
  private prevContainerZIndex: string | null = null

  private readonly overlayRenderer: IGlassOverlayRenderer | null
  private overlayCapabilities: RendererCapabilities
  private surfaceCapabilities: SurfaceCapabilities

  private requestedMode: SurfaceRenderMode
  private effectiveMode: SurfaceRenderMode
  private activeTheme: ThemeMode
  private containerSize: Size | null = null
  private lastRenderedFrame: GlassSurfaceFrame | null = null
  private disposed = false

  private refractFilterController: RefractFilterController | null = null
  private stopReducedMotionObserver: (() => void) | null = null
  private stopResizeObserver: (() => void) | null = null
  private frameLoop: FrameLoop | null = null
  private readonly loopScheduler: Partial<FrameScheduler> | undefined

  private readonly refractCache: LayerStyleCache = {}
  private readonly veilCache: LayerStyleCache = {}
  private readonly overlayCache: LayerStyleCache = {}

  // Preallocated shifted-primitive pool for zero-GC overlay renderer frames.
  private readonly shiftedPrimitivesPool: MutablePrimitive[] = []
  private readonly shiftedField: {
    primitives: GlassPrimitive[]
    blendK: number
    rimOpacity: number | undefined
    styleMix: number | undefined
  } = {
    primitives: [],
    blendK: 0,
    rimOpacity: undefined,
    styleMix: undefined,
  }

  constructor(options: GlassSurfaceControllerOptions = {}) {
    this.doc =
      options.document ??
      options.container?.ownerDocument ??
      (typeof document !== 'undefined' ? document : null)
    this.container = options.container ?? null
    this.svgMountTarget = options.svgMountTarget
    this.filterId = options.filterId ?? `sessile-refract-${nextAutoFilterId++}`
    this.baseRefraction = options.refraction
    this.defaultMaterial = options.material
    this.disableRefractOnReducedMotion = options.disableRefractOnReducedMotion ?? false
    this.onResizeCallback = options.onResize
    this.onCapabilitiesChangeCallback = options.onCapabilitiesChange
    this.loopScheduler = options.scheduler

    const elements = options.elements ?? {}
    const positioning = options.positioning ?? 'absolute'
    const zIndex = options.zIndex
    const hasCustomRefractSlot = 'refractBackdrop' in elements
    const hasCustomVeilSlot = 'veil' in elements
    const hasCustomOverlaySlot = 'overlayCanvas' in elements
    const defaultRefractZ = !hasCustomRefractSlot ? -2 : undefined
    const defaultVeilZ = !hasCustomVeilSlot ? -1 : undefined
    const defaultOverlayZ = !hasCustomOverlaySlot ? 1 : undefined

    let refractEl: HTMLElement | null = null
    let ownsRefract = false
    if (hasCustomRefractSlot) {
      refractEl = elements.refractBackdrop ?? null
    } else if (this.container && this.doc) {
      refractEl = this.doc.createElement('div')
      refractEl.setAttribute('data-sessile-layer', 'refract')
      applyManagedBaseLayerStyles(refractEl, positioning, zIndex?.refract ?? defaultRefractZ)
      ownsRefract = true
    }

    let veilEl: HTMLElement | null = null
    let ownsVeil = false
    if (hasCustomVeilSlot) {
      veilEl = elements.veil ?? null
    } else if (this.container && this.doc) {
      veilEl = this.doc.createElement('div')
      veilEl.setAttribute('data-sessile-layer', 'veil')
      applyManagedBaseLayerStyles(veilEl, positioning, zIndex?.veil ?? defaultVeilZ, true)
      ownsVeil = true
    }

    let canvasEl: HTMLCanvasElement | null = null
    let ownsCanvas = false
    if (hasCustomOverlaySlot) {
      canvasEl = elements.overlayCanvas ?? null
    } else if (this.container && this.doc) {
      canvasEl = this.doc.createElement('canvas')
      canvasEl.setAttribute('data-sessile-layer', 'overlay')
      applyManagedBaseLayerStyles(canvasEl, positioning, zIndex?.overlay ?? defaultOverlayZ)
      ownsCanvas = true
    }

    this.refractBackdropEl = refractEl
    this.veilEl = veilEl
    this.overlayCanvasEl = canvasEl
    this.ownsRefractBackdrop = ownsRefract
    this.ownsVeil = ownsVeil
    this.ownsOverlayCanvas = ownsCanvas

    if (this.container && (ownsRefract || ownsVeil || ownsCanvas)) {
      // Establish a positioning + z-index stacking context on the host container WITHOUT
      // `isolation: isolate` (which would form a CSS Backdrop Root and block exterior refraction)
      // so negative-zIndex backdrops paint behind normal-flow DOM content and overlayCanvas paints on top.
      const computed =
        typeof globalThis.getComputedStyle === 'function'
          ? globalThis.getComputedStyle(this.container)
          : null
      const effectivePosition = computed?.position || this.container.style.position || 'static'
      const effectiveZIndex = computed?.zIndex || this.container.style.zIndex || 'auto'

      if (effectivePosition === 'static') {
        this.prevContainerPosition = this.container.style.position
        this.container.style.position = 'relative'
      }
      if (effectiveZIndex === 'auto') {
        this.prevContainerZIndex = this.container.style.zIndex
        this.container.style.zIndex = '0'
      }
    }

    if (this.container) {
      const refNode =
        'insertBackdropBefore' in options
          ? (options.insertBackdropBefore ?? null)
          : this.container.firstChild
      const validRefNode = refNode && refNode.parentNode === this.container ? refNode : null

      if (ownsRefract && refractEl) {
        if (validRefNode) {
          this.container.insertBefore(refractEl, validRefNode)
        } else {
          this.container.appendChild(refractEl)
        }
      }
      if (ownsVeil && veilEl) {
        if (validRefNode) {
          this.container.insertBefore(veilEl, validRefNode)
        } else {
          this.container.appendChild(veilEl)
        }
      }
      if (ownsCanvas && canvasEl) {
        this.container.appendChild(canvasEl)
      }
    }

    if (this.overlayCanvasEl) {
      this.overlayRenderer = options.overlayRenderer ?? createGlassOverlayRenderer()
      this.overlayCapabilities = this.overlayRenderer.mount(this.overlayCanvasEl)
    } else {
      this.overlayRenderer = options.overlayRenderer ?? null
      this.overlayCapabilities = { ...EMPTY_OVERLAY_CAPABILITIES }
    }

    this.surfaceCapabilities = detectSurfaceCapabilities(options.env)
    this.requestedMode = options.mode ?? 'refract'
    this.effectiveMode = resolveEffectiveRenderMode(this.requestedMode, this.surfaceCapabilities, {
      disableRefractOnReducedMotion: this.disableRefractOnReducedMotion,
    })
    if (options.theme !== undefined) {
      this.activeTheme = options.theme
    } else {
      const themeOpts =
        options.env && 'matchMedia' in options.env
          ? { matchMedia: options.env.matchMedia ?? null }
          : undefined
      this.activeTheme = resolveElementTheme(this.container, themeOpts)
    }

    this.stopReducedMotionObserver = observeReducedMotion((reduced) => {
      if (this.disposed || reduced === this.surfaceCapabilities.reducedMotion) {
        return
      }
      this.surfaceCapabilities = {
        ...this.surfaceCapabilities,
        reducedMotion: reduced,
      }
      const nextEffective = resolveEffectiveRenderMode(
        this.requestedMode,
        this.surfaceCapabilities,
        { disableRefractOnReducedMotion: this.disableRefractOnReducedMotion },
      )
      if (nextEffective !== this.effectiveMode) {
        this.effectiveMode = nextEffective
        if (this.lastRenderedFrame) {
          this.render(this.lastRenderedFrame)
        } else if (nextEffective !== 'refract') {
          this.hideRefractBackdrop()
        }
      }
      this.onCapabilitiesChangeCallback?.(this.getCapabilities())
    }, options.env)

    const resizeTarget =
      options.observeResize === true
        ? this.container
        : options.observeResize && typeof options.observeResize === 'object'
          ? options.observeResize
          : null

    if (resizeTarget) {
      this.stopResizeObserver = observeElementResize(
        resizeTarget,
        (size) => {
          if (this.disposed) return
          this.containerSize = size
          this.onResizeCallback?.(size)
        },
        {
          ResizeObserverCtor: options.ResizeObserverCtor,
          emitInitial: true,
        },
      )
    } else if (this.container) {
      this.containerSize = measureElementBorderBox(this.container)
    }
  }

  private hideRefractBackdrop(): void {
    setVisibilityCached(this.refractBackdropEl, this.refractCache, 'hidden')
    setBackdropFilterCached(this.refractBackdropEl, this.refractCache, 'none')
  }

  private ensureRefractFilterController(): RefractFilterController | null {
    if (this.disposed) return null
    if (!this.refractFilterController) {
      this.refractFilterController = createRefractFilterController({
        id: this.filterId,
        document: this.doc ?? undefined,
        mountTarget: this.svgMountTarget,
        ...this.baseRefraction,
      })
      this.refractFilterController.mount(this.svgMountTarget)
    }
    return this.refractFilterController
  }

  private prepareShiftedField(source: GlassFieldState, ox: number, oy: number): GlassFieldState {
    const srcPrimitives = source.primitives
    const count = srcPrimitives.length
    while (this.shiftedPrimitivesPool.length < count) {
      this.shiftedPrimitivesPool.push({
        center: { x: 0, y: 0 },
        size: { width: 0, height: 0 },
        radius: 0,
      })
    }

    const dstPrimitives = this.shiftedField.primitives
    dstPrimitives.length = count
    for (let i = 0; i < count; i++) {
      const src = srcPrimitives[i]!
      const dst = this.shiftedPrimitivesPool[i]!
      dst.id = src.id
      dst.center.x = src.center.x - ox
      dst.center.y = src.center.y - oy
      dst.size.width = src.size.width
      dst.size.height = src.size.height
      dst.radius = src.radius
      dst.weight = src.weight
      dstPrimitives[i] = dst
    }

    this.shiftedField.blendK = source.blendK
    this.shiftedField.rimOpacity = source.rimOpacity
    this.shiftedField.styleMix = source.styleMix
    return this.shiftedField
  }

  /** Renders one frame across the 3 glass sibling layers and updates overlay highlights. */
  render(frame: GlassSurfaceFrame): void {
    if (this.disposed) return

    const opacity = clamp(frame.opacity ?? 1, 0, 1)
    if (opacity <= MIN_VISIBLE_OPACITY || !hasActivePrimitive(frame.field)) {
      this.clear()
      return
    }

    const theme = frame.theme ?? this.activeTheme
    const material =
      frame.material ?? this.defaultMaterial ?? DEFAULT_OPTICAL_MATERIALS[theme].frosted
    const veilOptics = frame.veilOptics ?? DEFAULT_VEIL_OPTICS
    const blurBumpPx = frame.blurBumpPx ?? 0
    const activeBlur = Math.max(0, material.blur + blurBumpPx)

    const bounds = frame.bounds ?? computeAutoSurfaceBounds(frame.field, material)
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.clear()
      return
    }

    this.lastRenderedFrame = frame

    const contourPath = extractFieldContourPath(frame.field, { x: bounds.x, y: bounds.y })
    const opacityStr = `${opacity}`

    if (this.veilEl) {
      setVisibilityCached(this.veilEl, this.veilCache, 'visible')
      setTransformSizeCached(this.veilEl, this.veilCache, bounds)
      setClipPathCached(this.veilEl, this.veilCache, contourPath ? `path("${contourPath}")` : 'none')
      setOpacityCached(this.veilEl, this.veilCache, opacityStr)
    }

    if (this.effectiveMode === 'solid') {
      this.hideRefractBackdrop()
      if (this.veilEl) {
        setVeilBackdropFilterCached(this.veilEl, this.veilCache, 'none')
        setBackgroundCached(
          this.veilEl,
          this.veilCache,
          frame.solidBackground ?? formatOpaqueSolidCss(material.tintRgba, theme),
        )
      }
    } else if (this.effectiveMode === 'refract' && contourPath && this.refractBackdropEl) {
      const filterController = this.ensureRefractFilterController()
      if (filterController && filterController.mounted) {
        const refractBounds =
          frame.refractBounds ?? computeClampedRefractBounds(frame.field, bounds)
        const refCfg = frame.refraction
        const bezel = refCfg?.bezel ?? this.baseRefraction?.bezel ?? material.bevel
        const strength =
          refCfg?.strength ?? this.baseRefraction?.strength ?? clamp(material.refraction / 50, 0, 2.5)
        const dispersion =
          refCfg?.dispersion ?? this.baseRefraction?.dispersion ?? material.dispersion
        const scaleMultiplier = refCfg?.scaleMultiplier ?? this.baseRefraction?.scaleMultiplier
        const mapScale = refCfg?.mapScale ?? this.baseRefraction?.mapScale
        const profile = refCfg?.profile ?? this.baseRefraction?.profile
        const ior = refCfg?.ior ?? this.baseRefraction?.ior
        const caustics = refCfg?.caustics ?? this.baseRefraction?.caustics

        filterController.updateFrame({
          bounds: refractBounds,
          field: frame.field,
          blurSigma: activeBlur,
          saturate: material.saturation,
          brightness: veilOptics.brightness,
          contrast: veilOptics.contrast,
          contrastFirst: veilOptics.contrastFirst,
          bezel,
          strength,
          dispersion,
          scaleMultiplier,
          mapScale,
          profile,
          ior,
          caustics,
        })

        // Route B3: keep `refractBackdrop` unclipped so Chromium avoids rectangular backdrop leaks
        // while the SVG filter self-masks output alpha to the displaced glass interior.
        const urlRef = `url(#${this.filterId})`
        setVisibilityCached(this.refractBackdropEl, this.refractCache, 'visible')
        setTransformSizeCached(this.refractBackdropEl, this.refractCache, refractBounds)
        setOpacityCached(this.refractBackdropEl, this.refractCache, opacityStr)
        setBackdropFilterCached(this.refractBackdropEl, this.refractCache, urlRef)

        if (this.veilEl) {
          setVeilBackdropFilterCached(this.veilEl, this.veilCache, 'none')
          setBackgroundCached(
            this.veilEl,
            this.veilCache,
            frame.refractTintBackground ?? formatRgbaCss(material.tintRgba),
          )
        }
      } else {
        this.applyFrostedVeil(activeBlur, material, veilOptics, frame.frostedBackground)
      }
    } else {
      this.applyFrostedVeil(activeBlur, material, veilOptics, frame.frostedBackground)
    }

    if (this.overlayCanvasEl) {
      setVisibilityCached(this.overlayCanvasEl, this.overlayCache, 'visible')
      setTransformSizeCached(this.overlayCanvasEl, this.overlayCache, bounds)
    }

    if (this.overlayRenderer) {
      const shifted = this.prepareShiftedField(frame.field, bounds.x, bounds.y)
      this.overlayRenderer.render({
        viewport: { width: bounds.width, height: bounds.height },
        dpr: resolveCurrentDpr(frame.dpr),
        theme,
        field: shifted,
        material,
        opacity,
        blurBumpPx,
      })
    }
  }

  private applyFrostedVeil(
    activeBlur: number,
    material: OpticalMaterial,
    veilOptics: BackdropVeilOptics,
    frostedBackground?: string,
  ): void {
    this.hideRefractBackdrop()
    if (!this.veilEl) return
    const bf = buildBackdropFilterCss({
      blurPx: activeBlur,
      saturation: material.saturation,
      veil: veilOptics,
    })
    setVeilBackdropFilterCached(this.veilEl, this.veilCache, bf)
    setBackgroundCached(
      this.veilEl,
      this.veilCache,
      frostedBackground ?? formatRgbaCss(material.tintRgba),
    )
  }

  /** Hides all surface layers and clears the overlay canvas without detaching DOM nodes. */
  clear(): void {
    this.lastRenderedFrame = null
    this.hideRefractBackdrop()
    setVisibilityCached(this.veilEl, this.veilCache, 'hidden')
    setVeilBackdropFilterCached(this.veilEl, this.veilCache, 'none')
    setVisibilityCached(this.overlayCanvasEl, this.overlayCache, 'hidden')
    this.overlayRenderer?.clear()
  }

  /** Changes the requested render mode and recomputes the effective downgraded mode. */
  setMode(mode: SurfaceRenderMode): SurfaceRenderMode {
    const prevEffective = this.effectiveMode
    this.requestedMode = mode
    this.effectiveMode = resolveEffectiveRenderMode(mode, this.surfaceCapabilities, {
      disableRefractOnReducedMotion: this.disableRefractOnReducedMotion,
    })
    if (this.effectiveMode !== prevEffective) {
      if (this.lastRenderedFrame) {
        this.render(this.lastRenderedFrame)
      } else if (this.effectiveMode !== 'refract') {
        this.hideRefractBackdrop()
      }
    }
    return this.effectiveMode
  }

  getMode(): SurfaceRenderMode {
    return this.requestedMode
  }

  getEffectiveMode(): SurfaceRenderMode {
    return this.effectiveMode
  }

  setTheme(theme: ThemeMode): void {
    if (theme === this.activeTheme) return
    this.activeTheme = theme
    if (this.lastRenderedFrame) {
      this.render(this.lastRenderedFrame)
    }
  }

  getTheme(): ThemeMode {
    return this.activeTheme
  }

  getCapabilities(): GlassSurfaceCapabilities {
    return {
      ...this.surfaceCapabilities,
      overlay: { ...this.overlayCapabilities },
    }
  }

  getContainerSize(): Size | null {
    if (this.containerSize) {
      return { ...this.containerSize }
    }
    if (this.container) {
      return measureElementBorderBox(this.container)
    }
    return null
  }

  getElements(): GlassSurfaceElements {
    return {
      refractBackdrop: this.refractBackdropEl,
      veil: this.veilEl,
      overlayCanvas: this.overlayCanvasEl,
    }
  }

  /** Starts a clamped `requestAnimationFrame` loop driving frames via `produceFrame`. */
  startLoop(produceFrame: SurfaceFrameProducer): void {
    if (this.disposed) return
    this.stopLoop()
    this.frameLoop = createFrameLoop(
      (dtSec, nowMs) => {
        if (this.disposed) return false
        const out = produceFrame(dtSec, nowMs)
        if (out === false) {
          return false
        }
        if (out && typeof out === 'object') {
          this.render(out)
        }
        return true
      },
      { scheduler: this.loopScheduler },
    )
    this.frameLoop.start()
  }

  stopLoop(): void {
    if (this.frameLoop) {
      this.frameLoop.stop()
      this.frameLoop = null
    }
  }

  isLoopRunning(): boolean {
    return this.frameLoop?.isRunning() ?? false
  }

  /** Disposes observers, rAF loop, SVG filter, overlay renderer, and any managed sibling nodes. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    this.stopLoop()
    this.stopReducedMotionObserver?.()
    this.stopReducedMotionObserver = null
    this.stopResizeObserver?.()
    this.stopResizeObserver = null

    this.clear()

    this.overlayRenderer?.dispose()
    this.refractFilterController?.dispose()
    this.refractFilterController = null

    if (this.ownsRefractBackdrop && this.refractBackdropEl?.parentNode) {
      this.refractBackdropEl.parentNode.removeChild(this.refractBackdropEl)
    }
    if (this.ownsVeil && this.veilEl?.parentNode) {
      this.veilEl.parentNode.removeChild(this.veilEl)
    }
    if (this.ownsOverlayCanvas && this.overlayCanvasEl?.parentNode) {
      this.overlayCanvasEl.parentNode.removeChild(this.overlayCanvasEl)
    }
    if (this.container) {
      if (this.prevContainerPosition !== null) {
        this.container.style.position = this.prevContainerPosition
        this.prevContainerPosition = null
      }
      if (this.prevContainerZIndex !== null) {
        this.container.style.zIndex = this.prevContainerZIndex
        this.prevContainerZIndex = null
      }
    }
  }
}

/** Factory helper creating a configured `GlassSurfaceController`. */
export function createGlassSurfaceController(
  options?: GlassSurfaceControllerOptions,
): GlassSurfaceController {
  return new GlassSurfaceController(options)
}
