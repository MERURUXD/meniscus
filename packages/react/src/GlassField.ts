/**
 * Declarative `<GlassField>` container component managing a `@meniscus/dom`
 * `GlassSurfaceController` lifecycle, 3-layer DOM synchronization, and child primitives.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  createElement,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import type {
  BackdropVeilOptics,
  GlassPrimitive as CoreGlassPrimitive,
  IGlassOverlayRenderer,
  OpticalMaterial,
  Rect,
  Size,
  ThemeMode,
} from '@meniscus/core'
import {
  GlassSurfaceController,
  resolveElementTheme,
  type CapabilityEnv,
  type FrameScheduler,
  type GlassSurfaceCapabilities,
  type GlassSurfaceFrame,
  type GlassSurfaceZIndex,
  type RefractFilterConfig,
  type SurfaceRenderMode,
} from '@meniscus/dom'
import {
  GlassFieldContext,
  assignRef,
  useIsomorphicLayoutEffect,
  type GlassFieldContextValue,
  type RegisteredGlassPrimitive,
} from './GlassFieldContext.ts'

export interface GlassFieldProps {
  /** Smooth-union (`smin`) blend radius in CSS px (default: `24`). */
  blendK?: number
  /** Controlled array of core primitives combined with any child `<GlassPrimitive>` elements. */
  primitives?: readonly CoreGlassPrimitive[]
  /** Soft rim highlight intensity multiplier in `[0, 1]`. */
  rimOpacity?: number
  /** Material transition weight from directional to soft rim highlights in `[0, 1]`. */
  styleMix?: number
  /** Requested rendering tier (`'refract'`, `'frosted'`, or `'solid'`). */
  mode?: SurfaceRenderMode
  /** Explicit surface theme override; auto-resolved from host DOM/media when omitted. */
  theme?: ThemeMode
  /** Explicit optical material overriding theme defaults. */
  material?: OpticalMaterial
  /** Backdrop brightness/contrast tuning for frosted/refract veil. */
  veilOptics?: BackdropVeilOptics
  /** Surface opacity multiplier in `[0, 1]` (default: `1`). */
  opacity?: number
  /** Additional dynamic blur bump in CSS px during motion (default: `0`). */
  blurBumpPx?: number
  /** Route B3 SVG refraction overrides. */
  refraction?: Partial<RefractFilterConfig>
  /** Explicit SVG `<filter>` DOM id override. */
  filterId?: string
  /** Target element where the shared `<svg>` filter definitions are mounted. */
  svgMountTarget?: Element | null
  /** CSS positioning strategy for managed surface layers (default: `'absolute'`). */
  positioning?: 'absolute' | 'fixed'
  /** Stacking z-index overrides for managed layers. */
  zIndex?: GlassSurfaceZIndex
  /** Downgrade SVG refraction to frosted blur when `(prefers-reduced-motion: reduce)` matches. */
  disableRefractOnReducedMotion?: boolean
  /** Observes container border-box resizes to keep DOM-measured primitives aligned (default: `true`). */
  observeResize?: boolean
  /** Explicit surface bounds override relative to container. */
  bounds?: Rect
  /** Explicit Route B3 refraction bounds override relative to container. */
  refractBounds?: Rect
  solidBackground?: string
  frostedBackground?: string
  refractTintBackground?: string
  dpr?: number
  onResize?: (size: Size) => void
  onCapabilitiesChange?: (capabilities: GlassSurfaceCapabilities) => void
  /** Imperative ref receiving the active `GlassSurfaceController` instance. */
  controllerRef?: Ref<GlassSurfaceController | null>
  /** Ref receiving the host container `<div>` element. */
  containerRef?: Ref<HTMLDivElement | null>
  env?: CapabilityEnv
  overlayRenderer?: IGlassOverlayRenderer
  scheduler?: Partial<FrameScheduler>
  ResizeObserverCtor?: typeof ResizeObserver
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

const CONTENT_WRAPPER_STYLE: CSSProperties = { display: 'contents' }

function parseBorderRadiusPx(rawValue: string | undefined, width: number, height: number): number {
  if (!rawValue) return 0
  const trimmed = rawValue.trim()
  if (!trimmed) return 0
  if (trimmed.endsWith('%')) {
    const pct = Number.parseFloat(trimmed)
    if (!Number.isFinite(pct) || pct <= 0) return 0
    return Math.min(width, height) * (pct / 100)
  }
  const px = Number.parseFloat(trimmed)
  return Number.isFinite(px) && px > 0 ? px : 0
}

/**
 * Resolves a registered primitive's CSS coordinates in the managed layers' frame.
 * Assumes an untransformed ancestor subtree for `'absolute'` positioning; ancestors
 * with CSS transforms already form a Backdrop Root that alters backdrop sampling.
 */
function resolveRegisteredPrimitive(
  entry: RegisteredGlassPrimitive,
  container: HTMLDivElement | null,
  positioning: 'absolute' | 'fixed' = 'absolute',
): CoreGlassPrimitive | null {
  if (entry.active === false) {
    return null
  }

  const el = entry.getElement?.() ?? null
  const needsOrigin = entry.x === undefined || entry.y === undefined
  const needsSize = entry.width === undefined || entry.height === undefined

  let measuredX = 0
  let measuredY = 0
  let measuredW = 0
  let measuredH = 0

  if (el && (needsOrigin || needsSize)) {
    const elRect = el.getBoundingClientRect()
    measuredW = Math.max(0, elRect.width)
    measuredH = Math.max(0, elRect.height)
    if (container && positioning !== 'fixed' && needsOrigin) {
      const containerRect = container.getBoundingClientRect()
      // Align coordinates against the container's padding box where managed `top: 0; left: 0` layers sit.
      const originX = containerRect.left + (container.clientLeft || 0)
      const originY = containerRect.top + (container.clientTop || 0)
      measuredX = elRect.left - originX
      measuredY = elRect.top - originY
    } else if (needsOrigin) {
      // Fixed-positioned surface layers anchor at viewport (0, 0), matching getBoundingClientRect().
      measuredX = elRect.left
      measuredY = elRect.top
    }
  }

  const x = entry.x ?? measuredX
  const y = entry.y ?? measuredY
  const width = Math.max(0, entry.width ?? measuredW)
  const height = Math.max(0, entry.height ?? measuredH)

  let radius = entry.radius
  if (radius === undefined) {
    if (el && typeof globalThis.getComputedStyle === 'function') {
      const computed = globalThis.getComputedStyle(el)
      radius = parseBorderRadiusPx(computed.borderTopLeftRadius, width, height)
    } else {
      radius = 0
    }
  }

  return {
    id: entry.id,
    center: {
      x: x + width * 0.5,
      y: y + height * 0.5,
    },
    size: {
      width,
      height,
    },
    radius: Math.max(0, radius),
    weight: entry.weight,
  }
}

interface FrameConfigSnapshot {
  blendK: number
  primitives?: readonly CoreGlassPrimitive[]
  rimOpacity?: number
  styleMix?: number
  material?: OpticalMaterial
  veilOptics?: BackdropVeilOptics
  opacity?: number
  blurBumpPx?: number
  refraction?: Partial<RefractFilterConfig>
  positioning?: 'absolute' | 'fixed'
  bounds?: Rect
  refractBounds?: Rect
  solidBackground?: string
  frostedBackground?: string
  refractTintBackground?: string
  dpr?: number
}

interface FieldCallbacks {
  onResize?: (size: Size) => void
  onCapabilitiesChange?: (capabilities: GlassSurfaceCapabilities) => void
  resizeObserverCtor?: typeof ResizeObserver
}

interface FieldStore extends GlassFieldContextValue {
  syncFrameConfig(config: FrameConfigSnapshot, callbacks: FieldCallbacks): void
  setContainer(next: HTMLDivElement | null): void
  setController(next: GlassSurfaceController | null): void
  hasRegisteredPrimitives(): boolean
  getCallbacks(): FieldCallbacks
  flushRender(): void
}

function createFieldStore(): FieldStore {
  const registered = new Map<string, RegisteredGlassPrimitive>()
  let container: HTMLDivElement | null = null
  let controller: GlassSurfaceController | null = null
  let frameConfig: FrameConfigSnapshot | null = null
  let callbacks: FieldCallbacks = {}
  let renderScheduled = false

  const flushRender = (): void => {
    renderScheduled = false
    if (!controller || !frameConfig) return

    const combined: CoreGlassPrimitive[] = []
    if (frameConfig.primitives) {
      for (let i = 0; i < frameConfig.primitives.length; i++) {
        combined.push(frameConfig.primitives[i]!)
      }
    }

    for (const entry of registered.values()) {
      const resolved = resolveRegisteredPrimitive(entry, container, frameConfig.positioning)
      if (resolved) {
        combined.push(resolved)
      }
    }

    if (combined.length === 0) {
      controller.clear()
      return
    }

    const frame: GlassSurfaceFrame = {
      field: {
        primitives: combined,
        blendK: frameConfig.blendK,
        rimOpacity: frameConfig.rimOpacity,
        styleMix: frameConfig.styleMix,
      },
      bounds: frameConfig.bounds,
      refractBounds: frameConfig.refractBounds,
      material: frameConfig.material,
      veilOptics: frameConfig.veilOptics,
      opacity: frameConfig.opacity,
      blurBumpPx: frameConfig.blurBumpPx,
      dpr: frameConfig.dpr,
      solidBackground: frameConfig.solidBackground,
      frostedBackground: frameConfig.frostedBackground,
      refractTintBackground: frameConfig.refractTintBackground,
      refraction: frameConfig.refraction,
    }
    controller.render(frame)
  }

  // Coalesce sibling primitive updates and ResizeObserver notifications within a single
  // commit or tick so multi-primitive fields avoid interleaved layout reads and duplicate renders.
  const scheduleRender = (): void => {
    if (renderScheduled || !controller || !frameConfig) return
    renderScheduled = true
    queueMicrotask(() => {
      if (!renderScheduled) return
      flushRender()
    })
  }

  return {
    syncFrameConfig(config, nextCallbacks) {
      frameConfig = config
      callbacks = nextCallbacks
    },
    setContainer(next) {
      container = next
    },
    setController(next) {
      controller = next
      if (!next) {
        renderScheduled = false
      }
    },
    hasRegisteredPrimitives() {
      return registered.size > 0
    },
    getCallbacks() {
      return callbacks
    },
    flushRender,
    registerPrimitive(entry) {
      registered.set(entry.id, entry)
    },
    updatePrimitive(entry) {
      registered.set(entry.id, entry)
    },
    unregisterPrimitive(id) {
      if (registered.delete(id)) {
        scheduleRender()
      }
    },
    requestRender() {
      scheduleRender()
    },
    getContainer() {
      return container
    },
    getController() {
      return controller
    },
    getResizeObserverCtor() {
      return callbacks.resizeObserverCtor
    },
  }
}

/**
 * Container component that hosts a 3-layer Meniscus `GlassSurfaceController` and collects
 * geometry from `<GlassPrimitive>` descendants and/or controlled `primitives`.
 */
export function GlassField(props: GlassFieldProps): ReactElement {
  const {
    blendK = 24,
    primitives,
    rimOpacity,
    styleMix,
    mode,
    theme,
    material,
    veilOptics,
    opacity,
    blurBumpPx,
    refraction,
    filterId,
    svgMountTarget,
    positioning,
    zIndex,
    disableRefractOnReducedMotion,
    observeResize = true,
    bounds,
    refractBounds,
    solidBackground,
    frostedBackground,
    refractTintBackground,
    dpr,
    onResize,
    onCapabilitiesChange,
    controllerRef: controllerRefProp,
    containerRef: containerRefProp,
    env,
    overlayRenderer,
    scheduler,
    ResizeObserverCtor,
    className,
    style,
    children,
  } = props

  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const [activeController, setActiveController] = useState<GlassSurfaceController | null>(null)
  const [store] = useState<FieldStore>(createFieldStore)

  useIsomorphicLayoutEffect(() => {
    store.syncFrameConfig(
      {
        blendK,
        primitives,
        rimOpacity,
        styleMix,
        material,
        veilOptics,
        opacity,
        blurBumpPx,
        refraction,
        positioning,
        bounds,
        refractBounds,
        solidBackground,
        frostedBackground,
        refractTintBackground,
        dpr,
      },
      {
        onResize,
        onCapabilitiesChange,
        resizeObserverCtor: ResizeObserverCtor,
      },
    )
  })

  useIsomorphicLayoutEffect(() => {
    store.setContainer(containerEl)
    if (!containerEl) return
    const cleanup = assignRef(containerRefProp, containerEl)
    return () => {
      if (cleanup) {
        cleanup()
      } else {
        assignRef(containerRefProp, null)
      }
      if (store.getContainer() === containerEl) {
        store.setContainer(null)
      }
    }
  }, [store, containerEl, containerRefProp])

  useIsomorphicLayoutEffect(() => {
    if (!activeController) return
    const cleanup = assignRef(controllerRefProp, activeController)
    return () => {
      if (cleanup) {
        cleanup()
      } else {
        assignRef(controllerRefProp, null)
      }
    }
  }, [activeController, controllerRefProp])

  const zIndexRefract = zIndex?.refract
  const zIndexVeil = zIndex?.veil
  const zIndexOverlay = zIndex?.overlay

  useIsomorphicLayoutEffect(() => {
    if (!containerEl) return
    store.setContainer(containerEl)

    // Material and refraction overrides flow dynamically via flushRender(); avoid
    // pinning initial overrides as sticky controller defaults if later cleared to undefined.
    const nextController = new GlassSurfaceController({
      container: containerEl,
      mode,
      theme,
      filterId,
      svgMountTarget,
      positioning,
      zIndex:
        zIndexRefract !== undefined || zIndexVeil !== undefined || zIndexOverlay !== undefined
          ? { refract: zIndexRefract, veil: zIndexVeil, overlay: zIndexOverlay }
          : undefined,
      disableRefractOnReducedMotion,
      observeResize,
      onResize: (size) => {
        store.getCallbacks().onResize?.(size)
        if (store.hasRegisteredPrimitives()) {
          store.flushRender()
        }
      },
      onCapabilitiesChange: (caps) => {
        store.getCallbacks().onCapabilitiesChange?.(caps)
      },
      env,
      overlayRenderer,
      scheduler,
      ResizeObserverCtor,
    })

    store.setController(nextController)
    setActiveController(nextController)

    return () => {
      store.setController(null)
      setActiveController(null)
      nextController.dispose()
    }
  }, [
    store,
    containerEl,
    filterId,
    svgMountTarget,
    positioning,
    zIndexRefract,
    zIndexVeil,
    zIndexOverlay,
    disableRefractOnReducedMotion,
    observeResize,
    env,
    overlayRenderer,
    scheduler,
    ResizeObserverCtor,
  ])

  useIsomorphicLayoutEffect(() => {
    const controller = store.getController()
    if (!controller) return
    controller.setMode(mode ?? 'refract')
  }, [store, containerEl, mode])

  useIsomorphicLayoutEffect(() => {
    const controller = store.getController()
    if (!controller) return
    if (theme !== undefined) {
      controller.setTheme(theme)
    } else if (containerEl) {
      const themeOpts = env && 'matchMedia' in env ? { matchMedia: env.matchMedia ?? null } : undefined
      controller.setTheme(resolveElementTheme(containerEl, themeOpts))
    }
  }, [store, containerEl, theme, env])

  useIsomorphicLayoutEffect(() => {
    store.flushRender()
  }, [
    store,
    containerEl,
    blendK,
    primitives,
    rimOpacity,
    styleMix,
    material,
    veilOptics,
    opacity,
    blurBumpPx,
    refraction,
    bounds,
    refractBounds,
    solidBackground,
    frostedBackground,
    refractTintBackground,
    dpr,
    filterId,
    svgMountTarget,
    positioning,
    zIndexRefract,
    zIndexVeil,
    zIndexOverlay,
    disableRefractOnReducedMotion,
    observeResize,
    env,
    overlayRenderer,
    scheduler,
    ResizeObserverCtor,
  ])

  // Isolate React children inside a layout-transparent `display: contents` node so text/number
  // reconciliation (`node.textContent = ...`) cannot wipe out controller-managed sibling layers.
  return createElement(
    GlassFieldContext.Provider,
    { value: store },
    createElement(
      'div',
      { ref: setContainerEl, className, style },
      createElement('div', { 'data-meniscus-content': '', style: CONTENT_WRAPPER_STYLE }, children),
    ),
  )
}
