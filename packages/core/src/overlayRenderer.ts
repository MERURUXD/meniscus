/**
 * WebGL2 + 2D Canvas fallback optical edge renderer for Live-DOM dynamic glass materials.
 *
 * Renders ONLY the optical boundary layer on a transparent overlay `<canvas>` (up to
 * MAX_GPU_PRIMITIVES = 16 active primitives):
 * 1. Outside-only drop shadow (`d > 0`, never bleeding into translucent glass)
 * 2. Dark outer hairline (`hairlineWidth`) with side / corner / flat alpha falloff
 * 3. Optional 1px uniform inner border + directional/soft inner rim highlight (`inset < 5px`),
 *    modulated by `styleMix` and `rimOpacity`
 *
 * Leaves the flat interior (`inset >= 5px`) strictly transparent (`alpha = 0`) so live DOM
 * `backdrop-filter` clipped by the contour shows through cleanly underneath.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { extractFieldContourPath } from './contour.ts'
import { MAX_GPU_PRIMITIVES } from './contracts.ts'
import type {
  GlassFieldState,
  GlassPrimitive,
  IGlassOverlayRenderer,
  OverlayRenderFrame,
  RendererCapabilities,
} from './contracts.ts'

export const OVERLAY_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 pos = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`

export const OVERLAY_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

#define MAX_PRIMITIVES 16

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uViewport;
uniform float uDpr;
uniform int uPrimitiveCount;
uniform vec4 uPrimitives[MAX_PRIMITIVES]; // (cx, cy, halfW, halfH) in local CSS px
uniform float uRadii[MAX_PRIMITIVES];
uniform float uBlendK;
uniform float uRimOpacity;
uniform float uStyleMix;
uniform float uOpacity;

uniform vec4 uRimParams;        // (material.rimOpacity, material.rimWidth, material.rimTail, material.rimFocus)
uniform vec4 uHairline;         // (width, sideAlpha, cornerAlpha, flatAlpha)
uniform vec3 uShadow;           // (blur, offsetY, alpha)
uniform vec4 uBorderColor;      // normalized RGBA of optional uniform inner border
uniform vec2 uBorderParams;     // (borderWidthPx, rimBottomRatio)

struct SdfSample {
  float dist;
  vec2 normal;
};

float safePow(float x, float y) {
  return (x <= 1e-6) ? 0.0 : pow(x, y);
}

float computeDirectionalRimWeight(vec2 normal, float focus, float bottomRatio) {
  if (focus < 0.05) {
    return 1.0;
  }
  float topBias = clamp(-normal.y, 0.0, 1.0);
  float botBias = clamp(normal.y, 0.0, 1.0);
  return safePow(max(topBias, botBias * clamp(bottomRatio, 0.0, 1.0)), max(focus, 0.25));
}

SdfSample sdRoundedBoxRefined(vec2 p, vec2 center, vec2 halfSize, float r) {
  vec2 safeHalf = max(halfSize, vec2(0.001));
  float rad = clamp(r, 0.0, min(safeHalf.x, safeHalf.y));
  vec2 rel = p - center;
  vec2 s = vec2(rel.x >= 0.0 ? 1.0 : -1.0, rel.y >= 0.0 ? 1.0 : -1.0);
  vec2 q = abs(rel) - safeHalf + rad;
  vec2 qPos = max(q, 0.0);

  float outside = length(qPos);
  float inside = min(max(q.x, q.y), 0.0);
  float baseDist = outside + inside - rad;

  vec2 baseNormal;
  if (q.x > 0.0 && q.y > 0.0) {
    baseNormal = (outside > 1e-5) ? (qPos / outside) * s : normalize(s);
  } else if (q.x > q.y) {
    baseNormal = vec2(s.x, 0.0);
  } else {
    baseNormal = vec2(0.0, s.y);
  }

  // Superellipse octant normal refinement within 5 CSS px of the boundary for smooth corner speculars;
  // dist stays exact baseDist for 0px alignment with the Marching Squares contour.
  float rimProximity = smoothstep(5.0, 0.0, abs(baseDist));
  vec2 normal = baseNormal;

  if (rimProximity > 0.001 && rad > 1.0 && q.x > 0.0 && q.y > 0.0) {
    const float pExp = 2.55;
    vec2 qn = qPos / rad;
    vec2 grad = vec2(
      safePow(qn.x, pExp - 1.0),
      safePow(qn.y, pExp - 1.0)
    );
    float gl = length(grad);
    if (gl > 1e-5) {
      vec2 superNormal = (grad / gl) * s;
      vec2 mixedN = mix(baseNormal, superNormal, rimProximity);
      float mnl = length(mixedN);
      normal = (mnl > 1e-5) ? (mixedN / mnl) : baseNormal;
    }
  }

  return SdfSample(baseDist, normal);
}

SdfSample evaluateGlassSdf(vec2 p) {
  if (uPrimitiveCount <= 0) {
    return SdfSample(1e6, vec2(0.0, -1.0));
  }

  SdfSample acc = sdRoundedBoxRefined(p, uPrimitives[0].xy, uPrimitives[0].zw, uRadii[0]);
  for (int i = 1; i < MAX_PRIMITIVES; i++) {
    if (i >= uPrimitiveCount) break;
    SdfSample b = sdRoundedBoxRefined(p, uPrimitives[i].xy, uPrimitives[i].zw, uRadii[i]);
    if (uBlendK <= 0.001) {
      if (b.dist < acc.dist) {
        acc = b;
      }
    } else {
      float h = clamp(0.5 + 0.5 * (b.dist - acc.dist) / uBlendK, 0.0, 1.0);
      float d = mix(b.dist, acc.dist, h) - uBlendK * h * (1.0 - h);
      vec2 n = mix(b.normal, acc.normal, h);
      float nl = length(n);
      n = (nl > 1e-5) ? (n / nl) : acc.normal;
      acc = SdfSample(d, n);
    }
  }

  return acc;
}

void main() {
  if (uOpacity <= 0.001 || uPrimitiveCount <= 0) {
    fragColor = vec4(0.0);
    return;
  }

  // Convert GL UV (bottom-left origin) to local CSS px (top-left origin).
  vec2 pCss = vec2(vUv.x * uViewport.x, (1.0 - vUv.y) * uViewport.y);
  SdfSample sdf = evaluateGlassSdf(pCss);
  float d = sdf.dist;
  vec2 normal = sdf.normal;

  float aa = 1.0 / max(uDpr, 1.0);
  float glassMask = smoothstep(0.5 * aa, -0.5 * aa, d);
  float outsideMask = 1.0 - glassMask;

  // 1. Outside-only drop shadow (d > 0)
  float shadowA = 0.0;
  if (outsideMask > 0.001 && uShadow.z > 0.001) {
    SdfSample shadowSdf = evaluateGlassSdf(pCss - vec2(0.0, uShadow.y));
    float sigma = max(uShadow.x * 0.5, 1.0);
    float shadowFalloff = 1.0 / (1.0 + exp(clamp(1.65 * shadowSdf.dist / sigma, -12.0, 12.0)));
    shadowA = outsideMask * shadowFalloff * uShadow.z * uOpacity;
  }

  // 2. Dark outer hairline: strictly outside when a uniform CSS inner border is present (d >= 0), otherwise straddling the outer edge (d >= -0.25)
  float hw = max(uHairline.x, 0.5 / max(uDpr, 1.0));
  float hairlineHalfW = hw * 0.5;
  float hasUniformBorder = step(0.001, uBorderParams.x);
  float hairlineCenter = mix(-0.25 + hairlineHalfW, hairlineHalfW, hasUniformBorder);
  float hairlineMinD = mix(-0.25 - 0.5 * aa, -0.15 * aa, hasUniformBorder);
  float hairlineBand =
    smoothstep(hairlineHalfW + 0.5 * aa, hairlineHalfW * 0.25, abs(d - hairlineCenter)) *
    smoothstep(hairlineMinD, hairlineMinD + 0.75 * aa, d);
  float hairA = 0.0;
  if (hairlineBand > 0.001) {
    float ax = abs(normal.x);
    float ay = abs(normal.y);
    float cornerW = safePow(clamp(2.0 * ax * ay, 0.0, 1.0), 1.5);
    float sideVsFlat = mix(uHairline.y, uHairline.w, ay * ay);
    float hairlineProfileAlpha = mix(sideVsFlat, uHairline.z, cornerW);
    hairA = hairlineBand * hairlineProfileAlpha * uOpacity;
  }

  // 3. Optional 1px uniform inner border + directional/soft inner rim highlight (inset < 5.0 CSS px)
  float inset = max(-d, 0.0);
  float borderMask = 0.0;
  float borderA = 0.0;
  vec3 borderRgb = vec3(0.0);
  if (glassMask > 0.001 && hasUniformBorder > 0.5 && inset < uBorderParams.x + aa) {
    borderMask = smoothstep(uBorderParams.x + 0.5 * aa, max(0.0, uBorderParams.x - 0.5 * aa), inset) * glassMask;
    borderA = clamp(borderMask * uBorderColor.a * uOpacity, 0.0, 1.0);
    borderRgb = uBorderColor.rgb * borderA;
  }

  float rimA = 0.0;
  if (glassMask > 0.001 && inset < 5.0 && uRimParams.x > 0.001) {
    float ny = abs(normal.y);
    float wDirectional = 1.0 - clamp(uStyleMix, 0.0, 1.0);
    float wSoft = clamp(uStyleMix, 0.0, 1.0) * clamp(uRimOpacity, 0.0, 1.0);

    if (hasUniformBorder > 0.5) {
      // Match CSS inset box-shadow: keep inner rim inside the padding edge so the 1px border is not double-brightened
      float padInset = max(inset - uBorderParams.x, 0.0);
      float padMask = 1.0 - borderMask;
      float dirWeight = computeDirectionalRimWeight(normal, uRimParams.w, uBorderParams.y);
      float core = smoothstep(max(uRimParams.y, 0.4) + 0.6, 0.0, padInset);
      float tail = exp(-padInset / 1.8) * uRimParams.z * smoothstep(5.0, 3.2, inset);
      rimA = clamp((core + tail) * dirWeight * uRimParams.x * padMask * glassMask * uOpacity, 0.0, 1.0);
    } else {
      if (wDirectional > 0.001) {
        float dirWeight = computeDirectionalRimWeight(normal, uRimParams.w, uBorderParams.y);
        float core = smoothstep(max(uRimParams.y, 0.4) + 0.6, 0.0, inset);
        float tail = exp(-inset / 1.8) * uRimParams.z * smoothstep(5.0, 3.2, inset);
        rimA += (core + tail) * dirWeight * uRimParams.x * wDirectional;
      }

      if (wSoft > 0.001) {
        float bandT = clamp(inset / 5.0, 0.0, 1.0);
        float steppedT = min(floor(bandT * 9.0) / 9.0, 1.0);
        float bandCurve = mix(safePow(1.0 - bandT, 2.1), safePow(1.0 - steppedT, 2.1), 0.35);
        float rimCoreBoost = 0.65 + 0.35 * smoothstep(1.2, 0.0, inset);
        float angWeight = mix(0.015, 1.0, safePow(ny, 2.1)) * (normal.y < 0.0 ? 1.0 : 0.85);
        rimA += bandCurve * rimCoreBoost * angWeight * uRimParams.x * wSoft;
      }

      // Boost specular luminance to match source-over alpha blending expectations
      rimA = clamp(rimA * 1.35 * glassMask * uOpacity, 0.0, 1.0);
    }
  }

  // Keep interior strictly transparent when shadow, hairline, border, and rim are all zero
  if (shadowA <= 0.0001 && hairA <= 0.0001 && borderA <= 0.0001 && rimA <= 0.0001) {
    fragColor = vec4(0.0);
    return;
  }

  // Premultiplied alpha composite: uniform border over inner rim over hairline and shadow
  float darkA = clamp(shadowA + hairA * (1.0 - shadowA), 0.0, 1.0);
  vec3 afterRimRgb = vec3(rimA);
  float afterRimA = rimA + darkA * (1.0 - rimA);
  vec3 outRgb = borderRgb + afterRimRgb * (1.0 - borderA);
  float outA = clamp(borderA + afterRimA * (1.0 - borderA), 0.0, 1.0);
  fragColor = vec4(outRgb, outA);
}
`

const WEBGL2_CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  premultipliedAlpha: true,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
}

type ProbeCanvasLike = {
  getContext: (contextId: 'webgl2', options?: WebGLContextAttributes) => unknown
}

function createProbeCanvas(targetCanvas: HTMLCanvasElement): ProbeCanvasLike | null {
  const ownerCanvas = (
    targetCanvas as { ownerDocument?: { createElement?: (tag: string) => HTMLCanvasElement } }
  ).ownerDocument?.createElement?.('canvas')
  if (ownerCanvas) {
    return ownerCanvas as unknown as ProbeCanvasLike
  }

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return document.createElement('canvas') as unknown as ProbeCanvasLike
  }

  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(1, 1) as unknown as ProbeCanvasLike
  }

  return null
}

function probeWebGL2OverlaySupport(
  targetCanvas: HTMLCanvasElement,
): { supported: boolean; reason?: string } {
  const probeCanvas = createProbeCanvas(targetCanvas)
  if (!probeCanvas) {
    // Restricted environments without DOM or OffscreenCanvas fall through to targetCanvas directly.
    return { supported: true }
  }

  const probeGl = probeCanvas.getContext(
    'webgl2',
    WEBGL2_CONTEXT_ATTRS,
  ) as WebGL2RenderingContext | null
  if (!probeGl || probeGl.isContextLost()) {
    return {
      supported: false,
      reason: 'WebGL2 unavailable; using 2D Canvas overlay fallback.',
    }
  }

  let probeProgram: WebGLProgram | null = null
  try {
    probeProgram = linkProgram(probeGl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER)
    return { supported: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'WebGL2 overlay shader initialization failed.'
    return {
      supported: false,
      reason: msg,
    }
  } finally {
    if (probeProgram) {
      probeGl.deleteProgram(probeProgram)
    }
    ;(probeGl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.()
  }
}

interface OverlayUniforms {
  uViewport: WebGLUniformLocation | null
  uDpr: WebGLUniformLocation | null
  uPrimitiveCount: WebGLUniformLocation | null
  uPrimitives: WebGLUniformLocation | null
  uRadii: WebGLUniformLocation | null
  uBlendK: WebGLUniformLocation | null
  uRimOpacity: WebGLUniformLocation | null
  uStyleMix: WebGLUniformLocation | null
  uOpacity: WebGLUniformLocation | null
  uRimParams: WebGLUniformLocation | null
  uHairline: WebGLUniformLocation | null
  uShadow: WebGLUniformLocation | null
  uBorderColor: WebGLUniformLocation | null
  uBorderParams: WebGLUniformLocation | null
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('Failed to allocate WebGL2 overlay shader')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error'
    gl.deleteShader(shader)
    throw new Error(`WebGL2 overlay shader compile error: ${log}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    throw new Error('Failed to allocate WebGL2 overlay program')
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'Unknown program link error'
    gl.deleteProgram(program)
    throw new Error(`WebGL2 overlay program link error: ${log}`)
  }
  return program
}

function traceRoundedShape(ctx: CanvasRenderingContext2D, shape: GlassPrimitive): void {
  const x = shape.center.x - shape.size.width * 0.5
  const y = shape.center.y - shape.size.height * 0.5
  const w = Math.max(0, shape.size.width)
  const h = Math.max(0, shape.size.height)
  const r = Math.max(0, Math.min(shape.radius, w * 0.5, h * 0.5))
  ctx.roundRect(x, y, w, h, r)
}

function traceActivePrimitives(
  ctx: CanvasRenderingContext2D,
  primitives: readonly GlassPrimitive[],
): number {
  let activeCount = 0
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i]
    if (p.size.width > 0.01 && p.size.height > 0.01) {
      traceRoundedShape(ctx, p)
      activeCount++
    }
  }
  return activeCount
}

/**
 * Traces an SVG path string emitted by `extractFieldContourPath` (`M`, `L`, `A`, `Z`)
 * directly onto a 2D Canvas context without relying on `Path2D`.
 */
export function traceSvgPath2d(ctx: CanvasRenderingContext2D, pathD: string): void {
  const len = pathD.length
  let i = 0
  let curX = 0
  let curY = 0
  let startX = 0
  let startY = 0
  let cmd = ''

  function skipSeparators(): void {
    while (i < len) {
      const c = pathD.charCodeAt(i)
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44) {
        i++
      } else {
        break
      }
    }
  }

  function isCommandChar(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  }

  function nextNumber(): number {
    skipSeparators()
    const start = i
    if (i < len && (pathD.charCodeAt(i) === 45 || pathD.charCodeAt(i) === 43)) {
      i++
    }
    while (i < len) {
      const c = pathD.charCodeAt(i)
      if ((c >= 48 && c <= 57) || c === 46) {
        i++
      } else if ((c === 101 || c === 69) && i > start) {
        i++
        if (i < len && (pathD.charCodeAt(i) === 45 || pathD.charCodeAt(i) === 43)) {
          i++
        }
      } else {
        break
      }
    }
    return i > start ? Number(pathD.slice(start, i)) : Number.NaN
  }

  while (i < len) {
    skipSeparators()
    if (i >= len) break

    const c = pathD.charCodeAt(i)
    if (isCommandChar(c)) {
      cmd = pathD[i]
      i++
    } else if (!cmd) {
      break
    }

    if (cmd === 'Z' || cmd === 'z') {
      ctx.closePath()
      curX = startX
      curY = startY
      cmd = ''
      continue
    }

    if (cmd === 'M' || cmd === 'm') {
      const x = nextNumber()
      const y = nextNumber()
      if (!Number.isFinite(x) || !Number.isFinite(y)) break
      const absX = cmd === 'm' ? curX + x : x
      const absY = cmd === 'm' ? curY + y : y
      ctx.moveTo(absX, absY)
      curX = absX
      curY = absY
      startX = absX
      startY = absY
      cmd = cmd === 'm' ? 'l' : 'L'
      continue
    }

    if (cmd === 'L' || cmd === 'l') {
      const x = nextNumber()
      const y = nextNumber()
      if (!Number.isFinite(x) || !Number.isFinite(y)) break
      const absX = cmd === 'l' ? curX + x : x
      const absY = cmd === 'l' ? curY + y : y
      ctx.lineTo(absX, absY)
      curX = absX
      curY = absY
      continue
    }

    if (cmd === 'A' || cmd === 'a') {
      const rx = nextNumber()
      const ry = nextNumber()
      nextNumber() // x-axis rotation
      nextNumber() // large-arc flag
      const sweep = nextNumber()
      const x = nextNumber()
      const y = nextNumber()
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(x) || !Number.isFinite(y)) {
        break
      }
      const absX = cmd === 'a' ? curX + x : x
      const absY = cmd === 'a' ? curY + y : y
      const r = Math.max(rx, ry)
      const dx = absX - curX
      const dy = absY - curY
      const d = Math.hypot(dx, dy)
      if (d > 1e-6 && r > 0) {
        const safeR = Math.max(r, d * 0.5)
        const nx = dx / d
        const ny = dy / d
        const midX = (curX + absX) * 0.5
        const midY = (curY + absY) * 0.5
        const h = Math.sqrt(Math.max(0, safeR * safeR - d * d * 0.25))
        const sweepClockwise = sweep !== 0
        const sign = sweepClockwise ? 1 : -1
        const cx = midX - sign * ny * h
        const cy = midY + sign * nx * h
        const startAngle = Math.atan2(curY - cy, curX - cx)
        const endAngle = Math.atan2(absY - cy, absX - cx)
        ctx.arc(cx, cy, safeR, startAngle, endAngle, !sweepClockwise)
      } else {
        ctx.lineTo(absX, absY)
      }
      curX = absX
      curY = absY
      continue
    }

    break
  }
}

function traceActiveFieldPath(
  ctx: CanvasRenderingContext2D,
  field: GlassFieldState,
  activeCount: number,
  blendedContourPath: string,
): void {
  if (activeCount >= 2 && field.blendK > 0.001 && blendedContourPath.length > 0) {
    traceSvgPath2d(ctx, blendedContourPath)
    return
  }
  traceActivePrimitives(ctx, field.primitives)
}

function renderFallback2d(ctx: CanvasRenderingContext2D, frame: OverlayRenderFrame): void {
  const dpr = Math.max(1, frame.dpr)
  const vpW = Math.max(1, frame.viewport.width)
  const vpH = Math.max(1, frame.viewport.height)
  const { field, material, opacity } = frame

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, vpW, vpH)
  if (opacity <= 0.001 || field.primitives.length === 0) return

  let activeCount = 0
  for (let i = 0; i < field.primitives.length; i++) {
    const p = field.primitives[i]
    if (p.size.width > 0.01 && p.size.height > 0.01) {
      activeCount++
    }
  }
  if (activeCount === 0) return

  const blendedContourPath =
    activeCount >= 2 && field.blendK > 0.001 ? extractFieldContourPath(field) : ''

  // 1. Outside-only drop shadow: translate the opaque caster offscreen while offsetting shadowOffsetX
  // back into the viewport so only translucent shadow pixels enter the canvas (no opaque AA fringe),
  // then destination-out erase the union interior to keep glass strictly transparent.
  if (material.shadowAlpha > 0.001) {
    let minX = 0
    for (let i = 0; i < field.primitives.length; i++) {
      const p = field.primitives[i]
      if (p.size.width > 0.01 && p.size.height > 0.01) {
        const left = p.center.x - p.size.width * 0.5
        if (left < minX) minX = left
      }
    }
    const offscreenX = Math.ceil(vpW - minX + material.shadowBlur * 3 + 64)

    ctx.save()
    ctx.translate(offscreenX, 0)
    ctx.shadowColor = `rgba(0, 0, 0, ${(material.shadowAlpha * opacity).toFixed(4)})`
    ctx.shadowBlur = material.shadowBlur
    ctx.shadowOffsetX = -offscreenX * dpr
    ctx.shadowOffsetY = material.shadowOffsetY
    ctx.fillStyle = 'rgba(0, 0, 0, 1)'
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.fill()

    ctx.translate(-offscreenX, 0)
    ctx.shadowColor = 'rgba(0, 0, 0, 0)'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.fill()
    ctx.restore()
  }

  // 2. Dark outer hairline
  const hairlineAlpha = ((material.hairlineSideAlpha + material.hairlineCornerAlpha) * 0.5) * opacity
  if (hairlineAlpha > 0.001 && material.hairlineWidth > 0) {
    ctx.save()
    ctx.lineWidth = material.hairlineWidth
    ctx.strokeStyle = `rgba(0, 0, 0, ${Math.min(1, hairlineAlpha).toFixed(4)})`
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.stroke()
    ctx.restore()
  }

  // 3. Optional uniform inner border
  const borderWidth = material.borderWidth ?? 0
  if (borderWidth > 0.001 && material.borderRgba && material.borderRgba[3] * opacity > 0.001) {
    const [r, g, b, a] = material.borderRgba
    ctx.save()
    ctx.lineWidth = borderWidth
    ctx.strokeStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.min(1, a * opacity).toFixed(4)})`
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.stroke()
    ctx.restore()
  }

  // 4. Top gradient rim catchlight
  const styleMix = field.styleMix ?? 0
  const fieldRimOpacity = field.rimOpacity ?? 1
  const effectiveRim =
    borderWidth > 0.001
      ? material.rimOpacity * opacity
      : material.rimOpacity * (1 - styleMix + styleMix * fieldRimOpacity) * opacity
  if (effectiveRim > 0.001) {
    ctx.save()
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.clip()

    const topGrad = ctx.createLinearGradient(0, 0, 0, vpH)
    topGrad.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, effectiveRim).toFixed(4)})`)
    topGrad.addColorStop(1, `rgba(255, 255, 255, ${(effectiveRim * 0.65).toFixed(4)})`)
    ctx.lineWidth = Math.max(1.2, Math.min(2.5, material.rimWidth))
    ctx.strokeStyle = topGrad
    ctx.beginPath()
    traceActiveFieldPath(ctx, field, activeCount, blendedContourPath)
    ctx.stroke()
    ctx.restore()
  }
}

/** Creates an optical edge overlay renderer supporting up to MAX_GPU_PRIMITIVES (16) with WebGL2 and automatic 2D Canvas fallback. */
export function createGlassOverlayRenderer(): IGlassOverlayRenderer {
  let capabilities: RendererCapabilities = {
    webgl2: false,
    floatFbo: false,
    maxTextureSize: 0,
    fallbackNotice: 'Overlay renderer not yet mounted.',
  }

  let canvas: HTMLCanvasElement | null = null
  let gl: WebGL2RenderingContext | null = null
  let fallback2d: CanvasRenderingContext2D | null = null
  let contextLost = false

  let vao: WebGLVertexArrayObject | null = null
  let program: WebGLProgram | null = null
  let uniforms: OverlayUniforms | null = null

  // Pre-allocated upload buffers inside closure for zero per-frame GC allocation.
  const primitiveVecData = new Float32Array(MAX_GPU_PRIMITIVES * 4)
  const primitiveRadiiData = new Float32Array(MAX_GPU_PRIMITIVES)

  function destroyGlResources(): void {
    if (!gl) return
    if (vao) {
      gl.deleteVertexArray(vao)
      vao = null
    }
    if (program) {
      gl.deleteProgram(program)
      program = null
    }
    uniforms = null
  }

  function initGlResources(): boolean {
    if (!gl) return false
    destroyGlResources()
    try {
      vao = gl.createVertexArray()
      program = linkProgram(gl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER)
      uniforms = {
        uViewport: gl.getUniformLocation(program, 'uViewport'),
        uDpr: gl.getUniformLocation(program, 'uDpr'),
        uPrimitiveCount: gl.getUniformLocation(program, 'uPrimitiveCount'),
        uPrimitives: gl.getUniformLocation(program, 'uPrimitives'),
        uRadii: gl.getUniformLocation(program, 'uRadii'),
        uBlendK: gl.getUniformLocation(program, 'uBlendK'),
        uRimOpacity: gl.getUniformLocation(program, 'uRimOpacity'),
        uStyleMix: gl.getUniformLocation(program, 'uStyleMix'),
        uOpacity: gl.getUniformLocation(program, 'uOpacity'),
        uRimParams: gl.getUniformLocation(program, 'uRimParams'),
        uHairline: gl.getUniformLocation(program, 'uHairline'),
        uShadow: gl.getUniformLocation(program, 'uShadow'),
        uBorderColor: gl.getUniformLocation(program, 'uBorderColor'),
        uBorderParams: gl.getUniformLocation(program, 'uBorderParams'),
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'WebGL2 overlay shader initialization failed.'
      capabilities = {
        ...capabilities,
        webgl2: false,
        fallbackNotice: msg,
      }
      destroyGlResources()
      return false
    }
  }

  const handleContextLost = (event: Event) => {
    event.preventDefault()
    contextLost = true
    capabilities = {
      ...capabilities,
      fallbackNotice: 'WebGL2 overlay context lost.',
    }
  }

  const handleContextRestored = () => {
    contextLost = false
    if (gl && initGlResources()) {
      capabilities = {
        ...capabilities,
        webgl2: true,
        fallbackNotice: undefined,
      }
    }
  }

  return {
    get capabilities(): RendererCapabilities {
      return capabilities
    },

    mount(targetCanvas: HTMLCanvasElement): RendererCapabilities {
      if (canvas && canvas !== targetCanvas) {
        canvas.removeEventListener('webglcontextlost', handleContextLost)
        canvas.removeEventListener('webglcontextrestored', handleContextRestored)
        destroyGlResources()
      }

      canvas = targetCanvas
      fallback2d = null
      gl = null
      contextLost = false

      canvas.addEventListener('webglcontextlost', handleContextLost)
      canvas.addEventListener('webglcontextrestored', handleContextRestored)

      // Probe shader compilation on an offscreen canvas first so a failing WebGL2 context
      // never locks targetCanvas out of acquiring a 2D fallback context per the HTML Canvas spec.
      const probe = probeWebGL2OverlaySupport(targetCanvas)
      const glCtx = probe.supported
        ? canvas.getContext('webgl2', WEBGL2_CONTEXT_ATTRS)
        : null

      if (glCtx) {
        gl = glCtx
        contextLost = glCtx.isContextLost()
        const floatFbo = Boolean(glCtx.getExtension('EXT_color_buffer_float'))
        const maxTextureSize = Number(glCtx.getParameter(glCtx.MAX_TEXTURE_SIZE)) || 4096
        capabilities = {
          webgl2: !contextLost,
          floatFbo,
          maxTextureSize,
        }
        if (!contextLost && initGlResources()) {
          return capabilities
        }
        gl = null
      }

      // Automatically fall back to 2D Canvas when WebGL2 is unavailable or initialization fails
      fallback2d = canvas.getContext('2d')
      const fallbackReason =
        probe.reason ??
        (glCtx && capabilities.fallbackNotice ? capabilities.fallbackNotice : undefined)
      const fallback2dNotice =
        fallbackReason && !fallbackReason.includes('2D Canvas')
          ? `${fallbackReason} Using 2D Canvas overlay fallback.`
          : (fallbackReason ?? 'WebGL2 unavailable; using 2D Canvas overlay fallback.')
      capabilities = {
        webgl2: false,
        floatFbo: false,
        maxTextureSize: 0,
        fallbackNotice: fallback2d
          ? fallback2dNotice
          : 'Neither WebGL2 nor 2D Canvas context is available.',
      }
      return capabilities
    },

    render(frame: OverlayRenderFrame): void {
      if (!canvas) return

      const dpr = Math.max(1, frame.dpr)
      const targetW = Math.max(1, Math.round(frame.viewport.width * dpr))
      const targetH = Math.max(1, Math.round(frame.viewport.height * dpr))
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      if (gl && !contextLost && capabilities.webgl2 && program && uniforms && vao) {
        if (frame.opacity <= 0.001) {
          this.clear()
          return
        }

        const { field, material } = frame
        const primitives = field.primitives
        let activeCount = 0
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives[i]
          if (p.size.width > 0.01 && p.size.height > 0.01) {
            const vecOffset = activeCount * 4
            primitiveVecData[vecOffset] = p.center.x
            primitiveVecData[vecOffset + 1] = p.center.y
            primitiveVecData[vecOffset + 2] = p.size.width * 0.5
            primitiveVecData[vecOffset + 3] = p.size.height * 0.5
            primitiveRadiiData[activeCount] = p.radius
            activeCount++
            if (activeCount >= MAX_GPU_PRIMITIVES) break
          }
        }

        if (activeCount === 0) {
          this.clear()
          return
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        gl.useProgram(program)
        gl.bindVertexArray(vao)
        gl.disable(gl.BLEND)
        gl.disable(gl.DEPTH_TEST)

        gl.uniform2f(uniforms.uViewport, Math.max(1, frame.viewport.width), Math.max(1, frame.viewport.height))
        gl.uniform1f(uniforms.uDpr, dpr)
        gl.uniform1i(uniforms.uPrimitiveCount, activeCount)
        gl.uniform4fv(uniforms.uPrimitives, primitiveVecData)
        gl.uniform1fv(uniforms.uRadii, primitiveRadiiData)
        gl.uniform1f(uniforms.uBlendK, field.blendK)
        gl.uniform1f(uniforms.uRimOpacity, field.rimOpacity ?? 1)
        gl.uniform1f(uniforms.uStyleMix, field.styleMix ?? 0)
        gl.uniform1f(uniforms.uOpacity, frame.opacity)

        gl.uniform4f(uniforms.uRimParams, material.rimOpacity, material.rimWidth, material.rimTail, material.rimFocus)
        gl.uniform4f(
          uniforms.uHairline,
          material.hairlineWidth,
          material.hairlineSideAlpha,
          material.hairlineCornerAlpha,
          material.hairlineFlatAlpha,
        )
        gl.uniform3f(uniforms.uShadow, material.shadowBlur, material.shadowOffsetY, material.shadowAlpha)
        const borderRgba = material.borderRgba ?? [1, 1, 1, 0]
        gl.uniform4f(uniforms.uBorderColor, borderRgba[0], borderRgba[1], borderRgba[2], borderRgba[3])
        gl.uniform2f(uniforms.uBorderParams, material.borderWidth ?? 0, material.rimBottomRatio ?? 0.72)

        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.bindVertexArray(null)
        return
      }

      if (fallback2d) {
        renderFallback2d(fallback2d, frame)
      }
    },

    clear(): void {
      if (gl && !contextLost) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        return
      }
      if (fallback2d && canvas) {
        fallback2d.setTransform(1, 0, 0, 1, 0, 0)
        fallback2d.clearRect(0, 0, canvas.width, canvas.height)
      }
    },

    dispose(): void {
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', handleContextLost)
        canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      }
      destroyGlResources()
      canvas = null
      gl = null
      fallback2d = null
      contextLost = false
    },
  }
}
