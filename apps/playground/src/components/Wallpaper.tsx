import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import type { ThemeMode } from '@meniscus/core'
import {
  WALLPAPER_FOLD_COUNT as FOLD_COUNT,
  WALLPAPER_PALETTES,
  hexToRgb,
} from './backdropSettings.ts'

const VERTEX_SHADER = `#version 300 es
void main() {
  // Single oversized triangle covering clip space; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/*
 * Layered folds: each front fold fills below a slow sum-of-sines ridge. The ridge is a crisp,
 * anti-aliased edge (fwidth) rather than a soft gradient because glass refraction is only
 * visible where the backdrop has edges; sheen, a hairline highlight and a cast shadow give the
 * folds depth without blurring those edges.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColors[${FOLD_COUNT}];
out vec4 outColor;

float ridge(int k, float x, float t) {
  float fk = float(k);
  float base = 1.0 - fk * 0.125;
  return base
    + 0.062 * sin(x * 1.55 + t * 0.23 + fk * 1.9)
    + 0.030 * sin(x * 3.30 - t * 0.31 + fk * 0.7)
    + 0.012 * sin(x * 7.10 + t * 0.47 + fk * 2.6);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  // Tilt the folds so their edges cross glass rims at varied angles, not just horizontally.
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float c = cos(-0.32), s = sin(-0.32);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + vec2(0.0, 0.5);

  vec3 col = uColors[0] * (0.94 + 0.08 * uv.y);
  for (int k = 1; k < ${FOLD_COUNT}; k++) {
    float d = p.y - ridge(k, p.x, uTime);
    float aa = fwidth(d) * 0.75;
    col *= 1.0 - 0.3 * exp(-max(d, 0.0) / 0.05) * step(0.0, d);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float depth = clamp(-d / 0.32, 0.0, 1.0);
    vec3 fold = mix(uColors[k] * 1.12 + 0.03, uColors[k] * 0.8, depth);
    // Pleats parallel to the ridge: faint, fine texture that shows displacement inside the
    // glass where a fold would otherwise be a flat fill. Width tracks fwidth to avoid moire.
    float phase = -d * 190.0;
    float pw = fwidth(phase);
    float pleat = smoothstep(1.0 - pw * 0.35 - 0.06, 1.0, cos(phase));
    fold *= 1.0 - 0.14 * pleat * (1.0 - 0.6 * depth);
    fold += 0.16 * exp(-abs(d) / 0.0045);
    col = mix(col, fold, inside);
  }
  outColor = vec4(min(col, 1.0), 1.0);
}`

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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vs || !fs) return null
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }
  return program
}

/** Hard-stop CSS approximation shown until the first frame, and kept if WebGL2 is unavailable. */
function fallbackStyle(theme: ThemeMode): CSSProperties {
  const colors = WALLPAPER_PALETTES[theme]
  const step = 100 / colors.length
  const stops = colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ')
  return { background: `linear-gradient(170deg, ${stops})` }
}

export interface WallpaperProps {
  theme: ThemeMode
  reducedMotion: boolean
}

/**
 * Procedural folded-glass wallpaper rendered with WebGL2 beneath the glass. It is a sibling of
 * the glass layers, never their ancestor, so it cannot become their Backdrop Root.
 */
export function Wallpaper({ theme, reducedMotion }: WallpaperProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
    if (!gl) return

    // Packed once per theme; the frame loop only updates time and resolution.
    const colors = new Float32Array(FOLD_COUNT * 3)
    WALLPAPER_PALETTES[theme].forEach((hex, i) => colors.set(hexToRgb(hex), i * 3))

    interface GpuResources {
      program: WebGLProgram
      vao: WebGLVertexArrayObject
      uRes: WebGLUniformLocation | null
      uTime: WebGLUniformLocation | null
      uColors: WebGLUniformLocation | null
    }

    // GPU objects die with the context, so this runs at mount and again after a restore.
    const createResources = (): GpuResources | null => {
      const program = createProgram(gl)
      if (!program) return null
      return {
        program,
        vao: gl.createVertexArray(),
        uRes: gl.getUniformLocation(program, 'uRes'),
        uTime: gl.getUniformLocation(program, 'uTime'),
        uColors: gl.getUniformLocation(program, 'uColors'),
      }
    }

    let gpu = createResources()
    if (!gpu) return

    let raf = 0
    const start = performance.now()

    const draw = (nowMs: number) => {
      if (!gpu) return
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(gpu.program)
      gl.bindVertexArray(gpu.vao)
      gl.uniform2f(gpu.uRes, canvas.width, canvas.height)
      // Reduced motion freezes a fixed, pleasant phase instead of wherever time happens to be.
      gl.uniform1f(gpu.uTime, reducedMotion ? 12 : 12 + (nowMs - start) / 1000)
      gl.uniform3fv(gpu.uColors, colors)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const resize = () => {
      // Below device resolution is fine: anti-aliased edges survive the upscale, and the
      // backdrop filter re-samples this canvas every frame, so fewer pixels is cheaper twice.
      const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.75
      const w = Math.max(1, Math.round(canvas.clientWidth * scale))
      const h = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      draw(performance.now())
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const tick = (now: number) => {
      draw(now)
      raf = requestAnimationFrame(tick)
    }
    const startLoop = () => {
      if (!reducedMotion) raf = requestAnimationFrame(tick)
    }
    startLoop()

    const onLost = (e: Event) => {
      // preventDefault signals that we will rebuild, which lets the browser restore the context.
      e.preventDefault()
      gpu = null
      cancelAnimationFrame(raf)
    }
    const onRestored = () => {
      gpu = createResources()
      if (!gpu) return
      draw(performance.now())
      startLoop()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (gpu) {
        gl.deleteVertexArray(gpu.vao)
        gl.deleteProgram(gpu.program)
      }
    }
  }, [theme, reducedMotion])

  return (
    <canvas ref={canvasRef} className="wallpaper" style={fallbackStyle(theme)} aria-hidden="true" />
  )
}
