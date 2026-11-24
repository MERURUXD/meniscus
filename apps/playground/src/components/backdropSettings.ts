import { createContext } from 'react'
import type { ThemeMode } from '@sessile/core'
import { WALLPAPER_SCENES, type WallpaperScene } from './wallpaperScenes.ts'

/** A live wallpaper scene, or the selectable DOM test chart. */
export type BackdropKind = WallpaperScene | 'chart'

export const BACKDROP_KINDS: readonly BackdropKind[] = [...WALLPAPER_SCENES, 'chart']

export interface BackdropSettings {
  kind: BackdropKind
  theme: ThemeMode
  reducedMotion: boolean
}

/** Shared by every stage so split panes and lab switches agree on what sits under the glass. */
export const BackdropContext = createContext<BackdropSettings>({
  kind: 'folds',
  theme: 'light',
  reducedMotion: false,
})
