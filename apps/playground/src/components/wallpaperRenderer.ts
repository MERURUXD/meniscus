import {
  WALLPAPER_FRAGMENT_SHADERS,
  WALLPAPER_VERTEX_SHADER,
  type WallpaperScene,
} from './wallpaperScenes.ts'

/**
 * The scenes move slowly, so 30 fps is plenty, and every frame drawn here makes the SVG backdrop
 * filter on top re-sample; halving the rate halves that cost.
 */
const FRAME_MS = 1000 / 30
/** Crossfade length for a theme change, matching the panel's own transition feel. */
const THEME_FADE_S = 0.6
/** Phase shown when motion is reduced: a fixed, composed frame instead of wherever time was. */
const STILL_TIME_S = 14
/**
 * Shared clock for every canvas, so switching labs (which remounts the stage) continues the
 * scene instead of restarting it, and split panes stay in step.
 */
const EPOCH_MS = typeof performance !== 'undefined' ? performance.now() : 0

interface SceneProgram {
  program: WebGLProgram
  uRes: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uDark: WebGLUniformLocation | null
}

export interface WallpaperRenderer {
  setScene(scene: WallpaperScene): void
  setDark(dark: boolean, instant?: boolean): void
  setPlaying(playing: boolean): void
  dispose(): void
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** Returns null without WebGL2; the canvas then keeps its CSS fallback background. */
export function createWallpaperRenderer(canvas: HTMLCanvasElement): WallpaperRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!gl) return null

  // GPU objects die with the context; both caches are rebuilt lazily after a restore.
  let programs = new Map<WallpaperScene, SceneProgram | null>()
  let vao: WebGLVertexArrayObject | null = gl.createVertexArray()
  let lost = false

  let scene: WallpaperScene = 'folds'
  let dark = 0
  let darkTarget = 0
  let playing = true
  let raf = 0
  let lastMs = 0
  let drawnMs = -Infinity

  const getProgram = (name: WallpaperScene): SceneProgram | null => {
    if (programs.has(name)) return programs.get(name) ?? null
    const vs = compile(gl, gl.VERTEX_SHADER, WALLPAPER_VERTEX_SHADER)
    const fs = compile(gl, gl.FRAGMENT_SHADER, WALLPAPER_FRAGMENT_SHADERS[name])
    let entry: SceneProgram | null = null
    if (vs && fs) {
      const program = gl.createProgram()
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        entry = {
          program,
          uRes: gl.getUniformLocation(program, 'uRes'),
          uTime: gl.getUniformLocation(program, 'uTime'),
          uDark: gl.getUniformLocation(program, 'uDark'),
        }
      } else {
        console.error(gl.getProgramInfoLog(program))
        gl.deleteProgram(program)
      }
    }
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    // Cache failures too, so a broken shader is reported once rather than every frame.
    programs.set(name, entry)
    return entry
  }

  const draw = (nowMs: number) => {
    if (lost) return
    // Below device resolution is fine: anti-aliased edges survive the upscale, and the backdrop
    // filter re-samples this canvas every frame, so fewer pixels is cheaper twice.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.75
    const w = Math.max(1, Math.round(canvas.clientWidth * scale))
    const h = Math.max(1, Math.round(canvas.clientHeight * scale))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const entry = getProgram(scene)
    if (!entry) return
    gl.viewport(0, 0, w, h)
    gl.useProgram(entry.program)
    gl.bindVertexArray(vao)
    gl.uniform2f(entry.uRes, w, h)
    gl.uniform1f(entry.uTime, playing ? (nowMs - EPOCH_MS) / 1000 : STILL_TIME_S)
    // Smoothstep the fade so the crossfade eases in and out.
    gl.uniform1f(entry.uDark, dark * dark * (3 - 2 * dark))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const loop = (nowMs: number) => {
    raf = 0
    const dt = lastMs ? Math.min(0.1, (nowMs - lastMs) / 1000) : 0
    lastMs = nowMs
    if (dark !== darkTarget) {
      const stepAmount = dt / THEME_FADE_S
      dark =
        darkTarget > dark
          ? Math.min(darkTarget, dark + stepAmount)
          : Math.max(darkTarget, dark - stepAmount)
    }
    const fading = dark !== darkTarget
    // A few ms of slack keeps 60 Hz displays on every other frame instead of drifting.
    if (!playing || fading || nowMs - drawnMs >= FRAME_MS - 4) {
      drawnMs = nowMs
      draw(nowMs)
    }
    if (!lost && (playing || fading)) {
      raf = requestAnimationFrame(loop)
    } else {
      lastMs = 0
    }
  }

  const kick = () => {
    if (!raf && !lost) raf = requestAnimationFrame(loop)
  }

  const onLost = (e: Event) => {
    // preventDefault tells the browser we will rebuild, which allows the context to be restored.
    e.preventDefault()
    lost = true
    cancelAnimationFrame(raf)
    raf = 0
  }
  const onRestored = () => {
    lost = false
    programs = new Map()
    vao = gl.createVertexArray()
    drawnMs = -Infinity
    kick()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  const observer = new ResizeObserver(() => {
    drawnMs = -Infinity
    kick()
  })
  observer.observe(canvas)

  return {
    setScene(next) {
      if (next === scene) return
      scene = next
      drawnMs = -Infinity
      kick()
    },
    setDark(on, instant = false) {
      darkTarget = on ? 1 : 0
      if (instant) dark = darkTarget
      drawnMs = -Infinity
      kick()
    },
    setPlaying(on) {
      playing = on
      drawnMs = -Infinity
      kick()
    },
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (!lost) {
        for (const entry of programs.values()) {
          if (entry) gl.deleteProgram(entry.program)
        }
        gl.deleteVertexArray(vao)
      }
    },
  }
}
