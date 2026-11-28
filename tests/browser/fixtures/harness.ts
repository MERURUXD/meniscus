/**
 * In-page harness for the real-browser rendering tests. Specs drive it through `page.evaluate`
 * and read pixels from Playwright screenshots, so everything measured here is what the browser
 * actually composited: SVG `backdrop-filter` refraction, the CSS fallback veil, and the
 * WebGL2 / 2D overlay canvas.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  DEFAULT_OPTICAL_MATERIALS,
  DEFAULT_SPRINGS,
  createSpringChannel,
  type GlassFieldState,
  type OpticalMaterial,
  type RendererCapabilities,
} from '@sessile/core'
import { createGlassOverlayRenderer } from '@sessile/core/overlay'
import {
  createGlassSurfaceController,
  supportsSvgBackdropRefraction,
  type GlassSurfaceController,
  type GlassSurfaceFrame,
  type SurfaceRenderMode,
} from '@sessile/dom'
import { resetCapabilityCache } from '@sessile/dom/internal'

export interface PrimitiveSpec {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface BoxSpec {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface MountOptions {
  mode?: SurfaceRenderMode
  nineSlice?: boolean
  overlay?: 'none' | 'dedicated' | 'shared'
  material?: Partial<OpticalMaterial>
  /** Renders onto the container itself; the container is placed and rounded as `box`. */
  container?: BoxSpec
  disableRefractOnReducedMotion?: boolean
}

export interface RenderOptions {
  blendK?: number
  opacity?: number
}

export interface LayerInfo {
  visibility: string
  backdropFilter: string
  clipPath: string
  /** Closed subpaths in the veil's `clip-path: path()` (one per separate glass blob). */
  subpaths: number
}

export interface SurfaceInfo {
  requestedMode: SurfaceRenderMode
  effectiveMode: SurfaceRenderMode
  svgBackdropRefraction: boolean
  overlay: RendererCapabilities
  refract: LayerInfo | null
  veil: LayerInfo | null
  host: LayerInfo | null
  filter: {
    mounted: boolean
    mapMode: 'nine-slice' | 'full' | null
    feImages: number
    /** `feImage` nodes that already carry an encoded PNG displacement map. */
    mapImages: number
  }
}

export interface AnimateGapOptions {
  fromGap: number
  toGap: number
  diameter?: number
  blendK?: number
  /** Retargets the spring after this many frames, to exercise mid-flight interruption. */
  interruptAfterFrames?: number
  interruptToGap?: number
  timeoutMs?: number
}

export interface AnimateGapResult {
  frames: number
  finalGap: number
  settled: boolean
  loopStopped: boolean
}

/** A lens with no blur, tint or color shift: only displacement changes the backdrop. */
const CLEAR_LENS: Partial<OpticalMaterial> = {
  blur: 0,
  saturation: 1,
  brightness: 1,
  contrast: 1,
  dispersion: 0,
  tintRgba: [0, 0, 0, 0],
}

interface Entry {
  controller: GlassSurfaceController
  container: HTMLElement
  filterId: string
  /** `backdropTarget: 'container'`: the container paints the backdrop sample itself. */
  isHost: boolean
}

const stage = document.getElementById('stage')!
const entries = new Map<number, Entry>()
let nextId = 1

function buildField(primitives: readonly PrimitiveSpec[], blendK = 0): GlassFieldState {
  return {
    blendK,
    primitives: primitives.map((p, i) => ({
      id: `p${i}`,
      center: { x: p.x, y: p.y },
      size: { width: p.width, height: p.height },
      radius: p.radius,
    })),
  }
}

function readLayer(el: HTMLElement | null | undefined): LayerInfo | null {
  if (!el) return null
  const style = el.style
  const clipPath = style.clipPath || ''
  return {
    visibility: style.visibility || getComputedStyle(el).visibility,
    backdropFilter:
      style.getPropertyValue('backdrop-filter') ||
      style.getPropertyValue('-webkit-backdrop-filter') ||
      '',
    clipPath,
    subpaths: (clipPath.match(/M/g) ?? []).length,
  }
}

function entry(id: number): Entry {
  const found = entries.get(id)
  if (!found) throw new Error(`unknown surface ${id}`)
  return found
}

function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = count
    const step = () => {
      if (--left <= 0) resolve()
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

function circlesAtGap(gap: number, diameter: number): PrimitiveSpec[] {
  const offset = diameter / 2 + gap / 2
  return [
    { x: 400 - offset, y: 300, width: diameter, height: diameter, radius: diameter / 2 },
    { x: 400 + offset, y: 300, width: diameter, height: diameter, radius: diameter / 2 },
  ]
}

const harness = {
  defaults: DEFAULT_OPTICAL_MATERIALS,
  clearLens: CLEAR_LENS,

  setBackdrop(kind: 'checker' | 'flat'): void {
    document.body.dataset.backdrop = kind
  },

  supportsSvgBackdropRefraction(): boolean {
    resetCapabilityCache()
    return supportsSvgBackdropRefraction()
  },

  cssSupportsUrlBackdrop(): boolean {
    return CSS.supports('backdrop-filter', 'url(#x)')
  },

  mount(options: MountOptions = {}): number {
    const id = nextId++
    const filterId = `sessile-test-filter-${id}`
    let container: HTMLElement
    const box = options.container
    if (box) {
      container = document.createElement('div')
      container.dataset.testSurface = String(id)
      Object.assign(container.style, {
        position: 'absolute',
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        borderRadius: `${box.radius}px`,
      })
    } else {
      container = document.createElement('div')
      container.dataset.testSurface = String(id)
      Object.assign(container.style, { position: 'absolute', inset: '0' })
    }
    stage.appendChild(container)

    const overlay = options.overlay ?? 'none'
    const controller = createGlassSurfaceController({
      container,
      filterId,
      mode: options.mode ?? 'refract',
      theme: 'light',
      material: { ...DEFAULT_OPTICAL_MATERIALS.light.crisp, ...CLEAR_LENS, ...options.material },
      refraction: options.nineSlice === undefined ? undefined : { nineSlice: options.nineSlice },
      disableRefractOnReducedMotion: options.disableRefractOnReducedMotion,
      backdropTarget: box ? 'container' : 'layers',
      elements: overlay === 'none' ? { overlayCanvas: null } : undefined,
      overlayRenderer:
        overlay === 'shared' ? createGlassOverlayRenderer({ context: 'shared' }) : undefined,
    })
    entries.set(id, { controller, container, filterId, isHost: Boolean(box) })
    return id
  },

  async render(id: number, primitives: PrimitiveSpec[], options: RenderOptions = {}): Promise<void> {
    const { controller } = entry(id)
    const frame: GlassSurfaceFrame = {
      field: buildField(primitives, options.blendK),
      opacity: options.opacity ?? 1,
      dpr: 1,
    }
    controller.render(frame)
    await nextFrames(2)
  },

  async setMode(id: number, mode: SurfaceRenderMode): Promise<SurfaceRenderMode> {
    const effective = entry(id).controller.setMode(mode)
    await nextFrames(2)
    return effective
  },

  inspect(id: number): SurfaceInfo {
    const { controller, filterId } = entry(id)
    const caps = controller.getCapabilities()
    const elements = controller.getElements()
    const filterEl = document.getElementById(filterId)
    const images = filterEl ? Array.from(filterEl.querySelectorAll('feImage')) : []
    let mapImages = 0
    for (const image of images) {
      if ((image.getAttribute('href') ?? '').startsWith('data:image/png')) mapImages++
    }
    const { container, isHost } = entry(id)
    return {
      requestedMode: controller.getMode(),
      effectiveMode: controller.getEffectiveMode(),
      svgBackdropRefraction: caps.svgBackdropRefraction,
      overlay: caps.overlay,
      refract: readLayer(elements.refractBackdrop),
      veil: readLayer(elements.veil),
      host: isHost ? readLayer(container) : null,
      filter: {
        mounted: filterEl !== null,
        mapMode: !filterEl
          ? null
          : filterEl.querySelector('[result="ns-center"]')
            ? 'nine-slice'
            : 'full',
        feImages: images.length,
        mapImages,
      },
    }
  },

  /**
   * Animates two circles from `fromGap` to `toGap` with an interruptible spring inside the
   * controller's own requestAnimationFrame loop, and resolves once the loop has stopped itself.
   */
  animateGap(id: number, options: AnimateGapOptions): Promise<AnimateGapResult> {
    const { controller } = entry(id)
    const diameter = options.diameter ?? 120
    const blendK = options.blendK ?? 24
    const spring = createSpringChannel({
      params: DEFAULT_SPRINGS.standard,
      initialValue: options.fromGap,
      initialTarget: options.toGap,
    })
    let frames = 0
    let settled = false
    let gap = options.fromGap

    controller.startLoop((dtSec) => {
      const state = spring.step(dtSec)
      frames++
      gap = state.value
      if (options.interruptAfterFrames !== undefined && frames === options.interruptAfterFrames) {
        spring.setTarget(options.interruptToGap ?? options.fromGap)
      }
      const frame: GlassSurfaceFrame = { field: buildField(circlesAtGap(gap, diameter), blendK), dpr: 1 }
      if (state.settled && frames > (options.interruptAfterFrames ?? 0)) {
        settled = true
        controller.render(frame)
        return false
      }
      return frame
    })

    const timeoutMs = options.timeoutMs ?? 5000
    const started = performance.now()
    return new Promise((resolve) => {
      const poll = () => {
        const running = controller.isLoopRunning()
        if (!running || performance.now() - started > timeoutMs) {
          controller.stopLoop()
          void nextFrames(2).then(() =>
            resolve({ frames, finalGap: gap, settled, loopStopped: !running }),
          )
          return
        }
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    })
  },

  circlesAtGap,

  /** Sets an inline style on the surface's container, e.g. an opacity fade. */
  async setContainerStyle(id: number, property: string, value: string): Promise<void> {
    entry(id).container.style.setProperty(property, value)
    await nextFrames(2)
  },

  dispose(id: number): void {
    const found = entries.get(id)
    if (!found) return
    found.controller.dispose()
    found.container.remove()
    entries.delete(id)
  },

  async disposeAll(): Promise<void> {
    for (const id of Array.from(entries.keys())) harness.dispose(id)
    await nextFrames(2)
  },

  nextFrames,
}

export type Harness = typeof harness

declare global {
  interface Window {
    harness: Harness
  }
}

window.harness = harness
document.body.dataset.ready = 'true'
