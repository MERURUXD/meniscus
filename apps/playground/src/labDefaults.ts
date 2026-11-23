import {
  DEFAULT_OPTICAL_MATERIALS,
  type GlassPrimitive,
  type OpticalMaterial,
  type RimMode,
  type Size,
  type ThemeMode,
} from '@meniscus/core'
import type { SurfaceRenderMode } from '@meniscus/dom'
import type { DragMergeNodeInput, PopoverPlacement } from '@meniscus/presets'

export type LabId = 'drag-merge' | 'segmented-dock' | 'optics' | 'popover-menu'

export const LAB_IDS: readonly LabId[] = ['drag-merge', 'segmented-dock', 'optics', 'popover-menu']

export interface DockSegmentMeta {
  id: string
  label: string
  badge?: string
}

export const DOCK_SEGMENTS: readonly DockSegmentMeta[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'optics', label: 'Optics', badge: 'B3' },
  { id: 'field', label: 'SDF Field' },
  { id: 'motion', label: 'Springs' },
  { id: 'export', label: 'Spec' },
] as const

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
  const cy = compact ? h * 0.58 : h * 0.5

  if (compact) {
    const mobileCy = Math.max(296, h * 0.62)
    return [
      {
        id: 'anchor',
        center: { x: cx, y: mobileCy - 60 },
        size: { width: 136, height: 48 },
        radius: 24,
        pinned: true,
      },
      {
        id: 'orb-a',
        center: { x: Math.max(52, cx - 72), y: mobileCy + 18 },
        size: { width: 72, height: 72 },
        radius: 36,
      },
      {
        id: 'orb-b',
        center: { x: Math.min(w - 52, cx + 72), y: mobileCy + 18 },
        size: { width: 78, height: 64 },
        radius: 22,
      },
      {
        id: 'pill-c',
        center: { x: cx, y: Math.min(h - 38, mobileCy + 96) },
        size: { width: 112, height: 48 },
        radius: 24,
      },
    ]
  }

  return [
    {
      id: 'anchor',
      center: { x: cx, y: cy - 34 },
      size: { width: 152, height: 56 },
      radius: 28,
      pinned: true,
    },
    {
      id: 'orb-a',
      center: { x: Math.max(62, cx - 104), y: cy + 52 },
      size: { width: 82, height: 82 },
      radius: 41,
    },
    {
      id: 'orb-b',
      center: { x: Math.min(w - 62, cx + 106), y: cy + 44 },
      size: { width: 92, height: 74 },
      radius: 24,
    },
    {
      id: 'pill-c',
      center: { x: cx, y: Math.min(h - 56, cy + 122) },
      size: { width: 124, height: 52 },
      radius: 26,
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
  light: [0.97, 0.98, 1, 0.22],
  dark: [0.05, 0.15, 0.28, 0.3],
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

export interface OpticsLabConfig {
  blendK: number
  blurPx: number
  bevelPx: number
  refractionStrength: number
  dispersionPx: number
  saturation: number
  tintAlpha: number
  rimMode: RimMode
  rimOpacity: number
  gapPx: number
  renderView: OpticsViewMode
  showWireframe: boolean
  oscillateGap: boolean
}

export const DEFAULT_OPTICS_LAB_CONFIG: OpticsLabConfig = {
  blendK: 30,
  blurPx: 0.8,
  bevelPx: 22,
  refractionStrength: 1.35,
  dispersionPx: 1.4,
  saturation: 1.5,
  tintAlpha: 0.22,
  rimMode: 'directional',
  rimOpacity: 0.42,
  gapPx: 10,
  renderView: 'refract',
  showWireframe: false,
  oscillateGap: false,
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
  const centerY = compact ? h * 0.62 : h * 0.52

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
