import { createContext } from 'react'
import type { ThemeMode } from '@meniscus/core'

export type BackdropKind = 'wallpaper' | 'chart'

export interface BackdropSettings {
  kind: BackdropKind
  theme: ThemeMode
  reducedMotion: boolean
}

/** Shared by every stage so split panes and lab switches agree on what sits under the glass. */
export const BackdropContext = createContext<BackdropSettings>({
  kind: 'wallpaper',
  theme: 'light',
  reducedMotion: false,
})

export const WALLPAPER_FOLD_COUNT = 8

/**
 * Fold colors from back to front. Prussian-blue folds lit by a sodium-amber front fold, so the
 * wallpaper stays in the bench palette. Neighbouring folds differ enough in luminance that
 * their edges read clearly when the glass bends them.
 */
export const WALLPAPER_PALETTES: Readonly<Record<ThemeMode, readonly string[]>> = {
  light: ['#e8eef7', '#cddcf0', '#a6c2ea', '#7aa3e0', '#4a7fd0', '#2753a8', '#f3c24f', '#e8892e'],
  dark: ['#0b2140', '#14306a', '#1f4fa8', '#2f74dc', '#5aa0f0', '#a8d3fa', '#f5bd3d', '#e07b2a'],
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}
