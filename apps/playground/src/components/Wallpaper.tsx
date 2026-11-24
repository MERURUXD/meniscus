import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ThemeMode } from '@sessile/core'
import { createWallpaperRenderer, type WallpaperRenderer } from './wallpaperRenderer.ts'
import { wallpaperFallbackCss, type WallpaperScene } from './wallpaperScenes.ts'

export interface WallpaperProps {
  scene: WallpaperScene
  theme: ThemeMode
  reducedMotion: boolean
}

/**
 * Live procedural wallpaper beneath the glass. It is a sibling of the glass layers, never their
 * ancestor, so it cannot become their Backdrop Root. One renderer lives for the canvas's
 * lifetime so scene and theme changes reuse the context and can crossfade.
 */
export function Wallpaper({ scene, theme, reducedMotion }: WallpaperProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [renderer, setRenderer] = useState<WallpaperRenderer | null>(null)
  // Read at creation so the first frame already matches; later changes go through setters.
  const initialRef = useRef({ scene, theme, reducedMotion })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const next = createWallpaperRenderer(canvas)
    if (!next) return
    const initial = initialRef.current
    next.setScene(initial.scene)
    next.setDark(initial.theme === 'dark', true)
    next.setPlaying(!initial.reducedMotion)
    setRenderer(next)
    return () => {
      next.dispose()
      setRenderer(null)
    }
  }, [])

  useEffect(() => {
    renderer?.setScene(scene)
  }, [renderer, scene])

  useEffect(() => {
    // Reduced motion also skips the crossfade.
    renderer?.setDark(theme === 'dark', reducedMotion)
  }, [renderer, theme, reducedMotion])

  useEffect(() => {
    renderer?.setPlaying(!reducedMotion)
  }, [renderer, reducedMotion])

  return (
    <canvas
      ref={canvasRef}
      className="wallpaper"
      style={{ background: wallpaperFallbackCss(theme) }}
      aria-hidden="true"
    />
  )
}
