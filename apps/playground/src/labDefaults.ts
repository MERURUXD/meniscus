import {
  DEFAULT_OPTICAL_MATERIALS,
  extractFieldContourPath,
  type GlassFieldState,
  type GlassPrimitive,
  type OpticalMaterial,
  type RefractionProfileName,
  type RimMode,
  type Size,
  type ThemeMode,
} from '@sessile/core'
import type { RefractFilterConfig, SurfaceRenderMode } from '@sessile/dom'
import type { DragMergeNodeInput, PopoverPlacement } from '@sessile/presets'

export type LabId = 'drag-merge' | 'segmented-dock' | 'popover-menu' | 'cover-wall'

export const LAB_IDS: readonly LabId[] = ['drag-merge', 'segmented-dock', 'popover-menu', 'cover-wall']

export interface GlobalGlassMaterial {
  config: OpticsLabConfig
  renderMode: SurfaceRenderMode
  material: OpticalMaterial
  fallbackMaterial: OpticalMaterial
  refraction: Partial<RefractFilterConfig>
  styleMix: number
}

export interface DockSegmentMeta {
  id: string
  label: string
  badge?: string
}

export const DOCK_SEGMENTS: readonly DockSegmentMeta[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'optics', label: 'Optics' },
  { id: 'field', label: 'SDF Field' },
  { id: 'motion', label: 'Springs' },
  { id: 'export', label: 'Spec' },
] as const

export const COVER_WALL_BLEND_K = 30

/** Viewport widths above this keep the floating HUD plates over the stage. */
const DESKTOP_MIN_WIDTH = 901

/**
 * Lays out the cover wall's pinned shelf bar and its draggable droplet. At rest the droplet sits
 * inside the blend radius, so the pair is one bridged contour until it is pulled away.
 */
export function createCoverWallNodes(stageSize: Size, inspectorWidth: number): DragMergeNodeInput[] {
  const desktop = stageSize.width >= DESKTOP_MIN_WIDTH
  const available = Math.max(300, stageSize.width - (desktop ? inspectorWidth : 0))
  const pad = desktop ? 24 : 12
  const height = desktop ? 60 : 52
  const gap = 10
  const barWidth = Math.min(520, available - pad * 2 - height - gap)
  const left = (available - (barWidth + gap + height)) * 0.5
  const cy = desktop ? 136 : 12 + height * 0.5
  return [
    {
      id: 'bar',
      center: { x: left + barWidth * 0.5, y: cy },
      size: { width: barWidth, height },
      radius: height * 0.5,
      pinned: true,
    },
    {
      id: 'drop',
      center: { x: left + barWidth + gap + height * 0.5, y: cy },
      size: { width: height, height },
      radius: height * 0.5,
    },
  ]
}

export interface DragNodeMeta {
  id: string
  label: string
  sublabel: string
}

export const INITIAL_DRAG_NODE_META: Readonly<Record<string, DragNodeMeta>> = {
  anchor: { id: 'anchor', label: 'Anchor', sublabel: 'Pinned' },
  'orb-a': { id: 'orb-a', label: 'Orb A', sublabel: 'Drag me' },
  'orb-b': { id: 'orb-b', label: 'Lens B', sublabel: 'Drag me' },
  'pill-c': { id: 'pill-c', label: 'Capsule C', sublabel: 'Drag me' },
}

export function createInitialDragMergeNodes(stageSize: Size): DragMergeNodeInput[] {
  const w = Math.max(300, stageSize.width)
  const h = Math.max(320, stageSize.height)
  const compact = w < 460
  const cx = w * 0.5
  const cy = h * 0.5

  if (compact) {
    return [
      {
        id: 'anchor',
        center: { x: cx, y: Math.max(40, cy - 84) },
        size: { width: 136, height: 48 },
        radius: 24,
        pinned: true,
      },
      {
        id: 'orb-a',
        center: { x: Math.max(52, cx - 76), y: cy },
        size: { width: 72, height: 72 },
        radius: 36,
      },
      {
        id: 'orb-b',
        center: { x: Math.min(w - 52, cx + 76), y: cy },
        size: { width: 78, height: 64 },
        radius: 22,
      },
      {
        id: 'pill-c',
        center: { x: cx, y: Math.min(h - 36, cy + 84) },
        size: { width: 112, height: 48 },
        radius: 24,
      },
    ]
  }

  return [
    {
      id: 'anchor',
      center: { x: cx, y: cy - 72 },
      size: { width: 164, height: 58 },
      radius: 29,
      pinned: true,
    },
    {
      id: 'orb-a',
      center: { x: Math.max(66, cx - 120), y: cy + 16 },
      size: { width: 90, height: 90 },
      radius: 45,
    },
    {
      id: 'orb-b',
      center: { x: Math.min(w - 66, cx + 120), y: cy + 12 },
      size: { width: 102, height: 82 },
      radius: 26,
    },
    {
      id: 'pill-c',
      center: { x: cx, y: Math.min(h - 52, cy + 102) },
      size: { width: 136, height: 54 },
      radius: 27,
    },
  ]
}

export function createExtraDropletInput(index: number, stageSize: Size): DragMergeNodeInput {
  const w = Math.max(300, stageSize.width)
  const h = Math.max(320, stageSize.height)
  const angle = ((index * 137.5) * Math.PI) / 180
  const rx = Math.min(130, w * 0.28) * Math.cos(angle)
  const ry = Math.min(95, h * 0.24) * Math.sin(angle)
  const isCapsule = index % 2 === 1
  const width = isCapsule ? 104 : 74
  const height = isCapsule ? 52 : 74

  return {
    id: `drop-${index}`,
    center: {
      x: Math.max(width * 0.5 + 16, Math.min(w - width * 0.5 - 16, w * 0.5 + rx)),
      y: Math.max(height * 0.5 + 16, Math.min(h - height * 0.5 - 16, h * 0.5 + ry)),
    },
    size: { width, height },
    radius: Math.min(width, height) * 0.5,
  }
}

/**
 * Showcase glass for the test chart. Core defaults carry a heavy milky tint tuned for UI
 * chrome over busy content; here the point is to see the backdrop bend, so on the refract
 * tier the tint and blur drop and a little dispersion is added. Only the playground uses this.
 */
const SHOWCASE_TINT: Record<ThemeMode, OpticalMaterial['tintRgba']> = {
  light: [0.98, 0.99, 1, 0.2],
  dark: [0.1, 0.13, 0.18, 0.28],
}

/**
 * Without displacement, low blur would leave the fallback tier as clear glass. Frosted keeps a
 * real blur and a denser tint so Safari and Firefox still read as frosted, per the
 * progressive-enhancement contract.
 */
export const SHOWCASE_FROSTED_BLUR_PX = 10
const SHOWCASE_FROSTED_TINT_ALPHA: Record<ThemeMode, number> = { light: 0.34, dark: 0.4 }

export type ShowcaseTier = 'refract' | 'frosted'

export function buildShowcaseMaterial(theme: ThemeMode, tier: ShowcaseTier = 'refract'): OpticalMaterial {
  const [r, g, b, a] = SHOWCASE_TINT[theme]
  const frosted = tier === 'frosted'
  return {
    ...DEFAULT_OPTICAL_MATERIALS[theme].crisp,
    blur: frosted ? SHOWCASE_FROSTED_BLUR_PX : 0.8,
    dispersion: frosted ? 0 : 1.2,
    saturation: theme === 'light' ? 1.5 : 1.7,
    tintRgba: [r, g, b, frosted ? SHOWCASE_FROSTED_TINT_ALPHA[theme] : a],
    rimOpacity: 0.42,
  }
}

/** Precomputed per render mode and theme so per-frame renders reuse one object instead of allocating. */
export const SHOWCASE_MATERIALS: Readonly<
  Record<SurfaceRenderMode, Readonly<Record<ThemeMode, OpticalMaterial>>>
> = {
  refract: { light: buildShowcaseMaterial('light'), dark: buildShowcaseMaterial('dark') },
  frosted: {
    light: buildShowcaseMaterial('light', 'frosted'),
    dark: buildShowcaseMaterial('dark', 'frosted'),
  },
  solid: { light: buildShowcaseMaterial('light'), dark: buildShowcaseMaterial('dark') },
}

export type OpticsViewMode = 'refract' | 'frosted' | 'solid' | 'split'
export type OpticsPresetId = 'crown' | 'prism' | 'meniscus' | 'frost'

export interface OpticsLabConfig {
  blendK: number
  blurPx: number
  bevelPx: number
  refractionProfile: RefractionProfileName
  ior: number
  caustics: boolean
  refractionStrength: number
  dispersionPx: number
  saturation: number
  tintAlpha: number
  rimMode: RimMode
  rimOpacity: number
  lightAngle: number
  gapPx: number
  renderView: OpticsViewMode
  showWireframe: boolean
  oscillateGap: boolean
}

export const DEFAULT_OPTICS_LAB_CONFIG: OpticsLabConfig = {
  blendK: 30,
  blurPx: 0.8,
  bevelPx: 22,
  refractionProfile: 'squircle',
  ior: 1.5,
  caustics: false,
  refractionStrength: 1.35,
  dispersionPx: 1.4,
  saturation: 1.5,
  tintAlpha: 0.22,
  rimMode: 'directional',
  rimOpacity: 0.42,
  lightAngle: -45,
  gapPx: 10,
  renderView: 'refract',
  showWireframe: false,
  oscillateGap: false,
}

export const OPTICS_PRESETS: Readonly<Record<OpticsPresetId, Partial<OpticsLabConfig>>> = {
  crown: {
    blendK: DEFAULT_OPTICS_LAB_CONFIG.blendK,
    blurPx: DEFAULT_OPTICS_LAB_CONFIG.blurPx,
    bevelPx: DEFAULT_OPTICS_LAB_CONFIG.bevelPx,
    refractionProfile: DEFAULT_OPTICS_LAB_CONFIG.refractionProfile,
    ior: DEFAULT_OPTICS_LAB_CONFIG.ior,
    caustics: DEFAULT_OPTICS_LAB_CONFIG.caustics,
    refractionStrength: DEFAULT_OPTICS_LAB_CONFIG.refractionStrength,
    dispersionPx: DEFAULT_OPTICS_LAB_CONFIG.dispersionPx,
    saturation: DEFAULT_OPTICS_LAB_CONFIG.saturation,
    tintAlpha: DEFAULT_OPTICS_LAB_CONFIG.tintAlpha,
    rimMode: DEFAULT_OPTICS_LAB_CONFIG.rimMode,
    rimOpacity: DEFAULT_OPTICS_LAB_CONFIG.rimOpacity,
  },
  prism: {
    bevelPx: 28,
    refractionProfile: 'circle',
    ior: 2.05,
    caustics: true,
    refractionStrength: 1.85,
    dispersionPx: 3.4,
    blurPx: 0.5,
    saturation: 2.1,
    tintAlpha: 0.14,
    rimMode: 'directional',
    rimOpacity: 0.48,
  },
  meniscus: {
    blendK: 42,
    bevelPx: 26,
    refractionProfile: 'lip',
    ior: 1.65,
    caustics: false,
    refractionStrength: 1.55,
    dispersionPx: 1.6,
    blurPx: 1.0,
    saturation: 1.65,
    tintAlpha: 0.22,
    rimMode: 'physical',
    rimOpacity: 0.58,
    lightAngle: -45,
  },
  frost: {
    bevelPx: 18,
    refractionProfile: 'squircle',
    ior: 1.35,
    caustics: false,
    refractionStrength: 0.85,
    dispersionPx: 0.4,
    blurPx: 11.5,
    saturation: 1.4,
    tintAlpha: 0.36,
    rimMode: 'soft',
    rimOpacity: 0.44,
  },
}

export function buildOpticsLabMaterial(
  theme: ThemeMode,
  config: OpticsLabConfig,
  tier: ShowcaseTier = 'refract',
): OpticalMaterial {
  const base =
    config.rimMode === 'soft'
      ? DEFAULT_OPTICAL_MATERIALS[theme].frosted
      : buildShowcaseMaterial(theme, tier)
  const [r, g, b] = SHOWCASE_TINT[theme]
  const frosted = tier === 'frosted'

  return {
    ...base,
    tintRgba: [r, g, b, frosted ? Math.max(config.tintAlpha, SHOWCASE_FROSTED_TINT_ALPHA[theme]) : config.tintAlpha],
    bevel: config.bevelPx,
    refraction: config.refractionStrength * 50,
    blur: frosted ? Math.max(config.blurPx, SHOWCASE_FROSTED_BLUR_PX) : config.blurPx,
    dispersion: config.dispersionPx,
    saturation: config.saturation,
    rimMode: config.rimMode,
    rimOpacity: config.rimOpacity,
    bevelProfile: config.refractionProfile,
    lightAngle: config.lightAngle,
    lightElevation: 22,
    rimShade: theme === 'light' ? 0.34 : 0.24,
  }
}

export function buildOpticsLabPrimitives(
  stageSize: Size,
  gapPx: number,
): GlassPrimitive[] {
  const w = Math.max(240, stageSize.width)
  const h = Math.max(240, stageSize.height)
  const compact = w < 440

  const mainW = compact ? 136 : 184
  const mainH = compact ? 76 : 94
  const orbW = compact ? 76 : 96
  const orbH = compact ? 76 : 96

  const halfSpan = (mainW + orbW) * 0.5 + gapPx
  const centerX = w * 0.5
  const centerY = h * 0.5

  return [
    {
      id: 'optics-primary',
      center: { x: centerX - halfSpan * 0.5 + (orbW - mainW) * 0.25, y: centerY },
      size: { width: mainW, height: mainH },
      radius: 32,
    },
    {
      id: 'optics-satellite',
      center: { x: centerX + halfSpan * 0.5 + (orbW - mainW) * 0.25, y: centerY },
      size: { width: orbW, height: orbH },
      radius: orbH * 0.5,
    },
  ]
}

export interface PopoverMenuActionItem {
  id: string
  label: string
  shortcut: string
}

export const POPOVER_MENU_ITEMS: readonly PopoverMenuActionItem[] = [
  { id: 'refract-preset', label: 'Duplicate', shortcut: 'D' },
  { id: 'smin-fuse', label: 'Rename', shortcut: 'R' },
  { id: 'interrupt', label: 'Move to', shortcut: 'M' },
  { id: 'edge-flip', label: 'Delete', shortcut: 'Del' },
] as const

export const POPOVER_ANCHOR_PLACEMENTS: readonly PopoverPlacement[] = [
  'overAnchorEnd',
  'overAnchorStart',
  'belowPoint',
  'abovePoint',
] as const

export function updateWireframeDom(
  field: GlassFieldState,
  pathEl: SVGPathElement | null,
  rectEls: Array<SVGRectElement | null>,
): void {
  if (pathEl) {
    pathEl.setAttribute('d', extractFieldContourPath(field, { x: 0, y: 0 }) ?? '')
  }
  for (let i = 0; i < field.primitives.length; i++) {
    const p = field.primitives[i]!
    const rectEl = rectEls[i]
    if (!rectEl) continue
    rectEl.setAttribute('x', String(p.center.x - p.size.width * 0.5))
    rectEl.setAttribute('y', String(p.center.y - p.size.height * 0.5))
    rectEl.setAttribute('width', String(p.size.width))
    rectEl.setAttribute('height', String(p.size.height))
    rectEl.setAttribute('rx', String(p.radius))
  }
}
