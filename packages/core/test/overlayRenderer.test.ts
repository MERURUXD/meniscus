/**
 * Unit tests for the @sessile/core WebGL2 + 2D Canvas optical edge renderer.
 * Verifies shader contracts, mount/capabilities, uniform uploads for N=0/1/3/16 and >16 truncation,
 * 2D Canvas multi-primitive fallback rendering, WebGL context lost/restored, and dispose cleanup.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { extractFieldContourPath, formatRoundedRectPath } from '../src/contour.ts'
import {
  DEFAULT_OPTICAL_MATERIALS,
  MAX_GPU_PRIMITIVES,
  type GlassPrimitive,
  type OverlayRenderFrame,
} from '../src/contracts.ts'
import {
  OVERLAY_FRAGMENT_SHADER,
  OVERLAY_VERTEX_SHADER,
  createGlassOverlayRenderer,
  traceSvgPath2d,
} from '../src/overlayRenderer.ts'

function createPrimitive(index: number): GlassPrimitive {
  return {
    id: `p-${index}`,
    center: { x: 40 + index * 20, y: 60 + index * 10 },
    size: { width: 32 + index, height: 24 + index },
    radius: 6 + (index % 5),
  }
}

function makeFrame(
  primitives: readonly GlassPrimitive[],
  overrides: Partial<OverlayRenderFrame> = {},
): OverlayRenderFrame {
  return {
    viewport: { width: 400, height: 300 },
    dpr: 2,
    theme: 'dark',
    field: {
      primitives,
      blendK: 24,
      rimOpacity: 0.85,
      styleMix: 0.6,
    },
    material: DEFAULT_OPTICAL_MATERIALS.dark.frosted,
    opacity: 1,
    ...overrides,
  }
}

interface MockGlState {
  gl: Record<string, unknown>
  uniformCalls: {
    i1: Array<{ loc: string; v: number }>
    f1: Array<{ loc: string; v: number }>
    f2: Array<{ loc: string; x: number; y: number }>
    f3: Array<{ loc: string; x: number; y: number; z: number }>
    f4: Array<{ loc: string; x: number; y: number; z: number; w: number }>
    v4f: Array<{ loc: string; data: number[] }>
    v1f: Array<{ loc: string; data: number[] }>
  }
  drawCalls: number
  clearCalls: number
  deletedVaos: number
  deletedPrograms: number
  deletedShaders: number
  loseContextCalls: number
  contextLostFlag: boolean
}

function createMockWebGL2(options: { failCompile?: boolean; failLink?: boolean } = {}): MockGlState {
  const uniformCalls: MockGlState['uniformCalls'] = {
    i1: [],
    f1: [],
    f2: [],
    f3: [],
    f4: [],
    v4f: [],
    v1f: [],
  }
  const state: MockGlState = {
    gl: {},
    uniformCalls,
    drawCalls: 0,
    clearCalls: 0,
    deletedVaos: 0,
    deletedPrograms: 0,
    deletedShaders: 0,
    loseContextCalls: 0,
    contextLostFlag: false,
  }

  let nextId = 1
  const shaderSources = new Map<object, string>()
  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    MAX_TEXTURE_SIZE: 0x0d33,
    FRAMEBUFFER: 0x8d40,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    TRIANGLES: 0x0004,
    isContextLost: () => state.contextLostFlag,
    getExtension: (name: string) => {
      if (name === 'EXT_color_buffer_float') return {}
      if (name === 'WEBGL_lose_context') {
        return {
          loseContext: () => {
            state.loseContextCalls++
          },
        }
      }
      return null
    },
    getParameter: (param: number) => (param === 0x0d33 ? 8192 : 0),
    createShader: (type: number) => ({ id: nextId++, type }),
    shaderSource: (shader: object, src: string) => {
      shaderSources.set(shader, src)
    },
    compileShader: () => {},
    getShaderParameter: () => !options.failCompile,
    getShaderInfoLog: () => (options.failCompile ? 'Mock compile error' : ''),
    deleteShader: () => {
      state.deletedShaders++
    },
    createProgram: () => ({ id: nextId++ }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => !options.failLink,
    getProgramInfoLog: () => (options.failLink ? 'Mock link error' : ''),
    deleteProgram: () => {
      state.deletedPrograms++
    },
    createVertexArray: () => ({ id: nextId++ }),
    deleteVertexArray: () => {
      state.deletedVaos++
    },
    getUniformLocation: (_program: object, name: string) => ({ name }),
    bindFramebuffer: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {
      state.clearCalls++
    },
    useProgram: () => {},
    bindVertexArray: () => {},
    disable: () => {},
    uniform1i: (loc: { name: string } | null, v: number) => {
      if (loc) uniformCalls.i1.push({ loc: loc.name, v })
    },
    uniform1f: (loc: { name: string } | null, v: number) => {
      if (loc) uniformCalls.f1.push({ loc: loc.name, v })
    },
    uniform2f: (loc: { name: string } | null, x: number, y: number) => {
      if (loc) uniformCalls.f2.push({ loc: loc.name, x, y })
    },
    uniform3f: (loc: { name: string } | null, x: number, y: number, z: number) => {
      if (loc) uniformCalls.f3.push({ loc: loc.name, x, y, z })
    },
    uniform4f: (loc: { name: string } | null, x: number, y: number, z: number, w: number) => {
      if (loc) uniformCalls.f4.push({ loc: loc.name, x, y, z, w })
    },
    uniform4fv: (loc: { name: string } | null, arr: Float32Array) => {
      if (loc) uniformCalls.v4f.push({ loc: loc.name, data: Array.from(arr) })
    },
    uniform1fv: (loc: { name: string } | null, arr: Float32Array) => {
      if (loc) uniformCalls.v1f.push({ loc: loc.name, data: Array.from(arr) })
    },
    drawArrays: () => {
      state.drawCalls++
    },
  }
  state.gl = gl
  return state
}

function resetUniformCalls(calls: MockGlState['uniformCalls']): void {
  calls.i1.length = 0
  calls.f1.length = 0
  calls.f2.length = 0
  calls.f3.length = 0
  calls.f4.length = 0
  calls.v4f.length = 0
  calls.v1f.length = 0
}

test('overlayRenderer: GLSL ES 3.00 N-primitive shader contracts and ANGLE safety guards', () => {
  assert.ok(OVERLAY_VERTEX_SHADER.includes('#version 300 es'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('#version 300 es'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('#define MAX_PRIMITIVES 16'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('uniform int uPrimitiveCount;'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('uniform vec4 uPrimitives[MAX_PRIMITIVES];'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('uniform float uRadii[MAX_PRIMITIVES];'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('SdfSample evaluateGlassSdf(vec2 p)'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('uOpacity <= 0.001 || uPrimitiveCount <= 0'))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('safePow('))
  const powCalls = OVERLAY_FRAGMENT_SHADER.match(/\bpow\s*\(/g) ?? []
  assert.equal(powCalls.length, 1, 'pow() may only appear inside safePow()')
  assert.equal(/\?\s*SdfSample\b/.test(OVERLAY_FRAGMENT_SHADER), false, 'no struct ternaries')
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('outsideMask') && OVERLAY_FRAGMENT_SHADER.includes('inset < 5.0'))
})

test('overlayRenderer: WebGL2 mount, N=0/1/3/16 and >16 truncation uniform uploads, context lost/restored, and dispose', () => {
  const mock = createMockWebGL2()
  const listeners = new Map<string, (ev: { preventDefault: () => void }) => void>()
  const mockCanvas = {
    width: 0,
    height: 0,
    addEventListener: (k: string, fn: (ev: { preventDefault: () => void }) => void) => listeners.set(k, fn),
    removeEventListener: (k: string) => listeners.delete(k),
    getContext: (kind: string) => (kind === 'webgl2' ? mock.gl : null),
  } as unknown as HTMLCanvasElement

  const renderer = createGlassOverlayRenderer()
  const caps = renderer.mount(mockCanvas)
  assert.equal(caps.webgl2, true)
  assert.equal(caps.floatFbo, true)
  assert.equal(caps.maxTextureSize, 8192)
  assert.equal(caps.fallbackNotice, undefined)

  // N=0 (empty and degenerate-only primitives) should clear canvas without calling drawArrays
  renderer.render(makeFrame([]))
  assert.equal(mock.clearCalls, 1)
  assert.equal(mock.drawCalls, 0)

  renderer.render(
    makeFrame([{ center: { x: 10, y: 10 }, size: { width: 0.005, height: 20 }, radius: 4 }]),
  )
  assert.equal(mock.clearCalls, 2)
  assert.equal(mock.drawCalls, 0)

  // N=1 upload with default rimOpacity/styleMix
  resetUniformCalls(mock.uniformCalls)
  const p1 = createPrimitive(0)
  renderer.render(
    makeFrame([p1], {
      field: { primitives: [p1], blendK: 16 },
    }),
  )
  assert.equal(mockCanvas.width, 800)
  assert.equal(mockCanvas.height, 600)
  assert.equal(mock.drawCalls, 1)
  assert.deepEqual(mock.uniformCalls.i1, [{ loc: 'uPrimitiveCount', v: 1 }])
  assert.equal(mock.uniformCalls.v4f[0]?.loc, 'uPrimitives')
  assert.equal(mock.uniformCalls.v4f[0]?.data.length, MAX_GPU_PRIMITIVES * 4)
  assert.deepEqual(mock.uniformCalls.v4f[0]?.data.slice(0, 4), [
    p1.center.x,
    p1.center.y,
    p1.size.width * 0.5,
    p1.size.height * 0.5,
  ])
  assert.equal(mock.uniformCalls.v1f[0]?.loc, 'uRadii')
  assert.equal(mock.uniformCalls.v1f[0]?.data.length, MAX_GPU_PRIMITIVES)
  assert.equal(mock.uniformCalls.v1f[0]?.data[0], p1.radius)
  const rimOpUniform = mock.uniformCalls.f1.find((c) => c.loc === 'uRimOpacity')
  const styleMixUniform = mock.uniformCalls.f1.find((c) => c.loc === 'uStyleMix')
  assert.equal(rimOpUniform?.v, 1)
  assert.equal(styleMixUniform?.v, 0)

  // N=3 (3 active + 1 degenerate primitive should upload count 3)
  resetUniformCalls(mock.uniformCalls)
  const three = [createPrimitive(1), createPrimitive(2), createPrimitive(3)]
  const degenerate: GlassPrimitive = { center: { x: 0, y: 0 }, size: { width: 0, height: 10 }, radius: 2 }
  renderer.render(makeFrame([three[0], degenerate, three[1], three[2]]))
  assert.equal(mock.drawCalls, 2)
  assert.deepEqual(mock.uniformCalls.i1, [{ loc: 'uPrimitiveCount', v: 3 }])
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(mock.uniformCalls.v4f[0]?.data.slice(i * 4, i * 4 + 4), [
      three[i].center.x,
      three[i].center.y,
      three[i].size.width * 0.5,
      three[i].size.height * 0.5,
    ])
    assert.equal(mock.uniformCalls.v1f[0]?.data[i], three[i].radius)
  }

  // N=16 full capacity
  resetUniformCalls(mock.uniformCalls)
  const sixteen = Array.from({ length: 16 }, (_, i) => createPrimitive(i))
  renderer.render(makeFrame(sixteen))
  assert.deepEqual(mock.uniformCalls.i1, [{ loc: 'uPrimitiveCount', v: 16 }])
  assert.equal(mock.uniformCalls.v1f[0]?.data[15], sixteen[15].radius)

  // N=20 exceeds limit and truncates to MAX_GPU_PRIMITIVES (16)
  resetUniformCalls(mock.uniformCalls)
  const twenty = Array.from({ length: 20 }, (_, i) => createPrimitive(i))
  renderer.render(makeFrame(twenty))
  assert.deepEqual(mock.uniformCalls.i1, [{ loc: 'uPrimitiveCount', v: MAX_GPU_PRIMITIVES }])
  assert.deepEqual(mock.uniformCalls.v4f[0]?.data.slice(15 * 4, 16 * 4), [
    twenty[15].center.x,
    twenty[15].center.y,
    twenty[15].size.width * 0.5,
    twenty[15].size.height * 0.5,
  ])

  // opacity <= 0.001 clears without drawing
  const prevDraws = mock.drawCalls
  renderer.render(makeFrame(three, { opacity: 0 }))
  assert.equal(mock.drawCalls, prevDraws)

  // webglcontextlost and webglcontextrestored lifecycle
  let prevented = false
  listeners.get('webglcontextlost')?.({
    preventDefault: () => {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  assert.ok(renderer.capabilities.fallbackNotice?.includes('lost'))
  renderer.render(makeFrame(three))
  assert.equal(mock.drawCalls, prevDraws, 'must not draw while context is lost')

  listeners.get('webglcontextrestored')?.({ preventDefault: () => {} })
  assert.equal(renderer.capabilities.webgl2, true)
  assert.equal(renderer.capabilities.fallbackNotice, undefined)
  renderer.render(makeFrame(three))
  assert.equal(mock.drawCalls, prevDraws + 1, 'draws again after context restored')

  renderer.dispose()
  assert.equal(mock.deletedVaos, 2)
  assert.equal(mock.deletedPrograms, 2)
  assert.equal(listeners.size, 0, 'dispose must remove context listeners')
})

interface Mock2dState {
  ctx: Record<string, unknown>
  calls: Array<[string, ...unknown[]]>
  fillSnapshots: Array<{
    globalCompositeOperation: string
    shadowColor: string
    shadowBlur: number
    shadowOffsetX: number
    shadowOffsetY: number
  }>
}

function createMock2d(): Mock2dState {
  const calls: Array<[string, ...unknown[]]> = []
  const fillSnapshots: Mock2dState['fillSnapshots'] = []
  const stack: Array<{
    globalCompositeOperation: string
    shadowColor: string
    shadowBlur: number
    shadowOffsetX: number
    shadowOffsetY: number
    fillStyle: string
    strokeStyle: string
    lineWidth: number
  }> = []

  const ctx: Record<string, unknown> = {
    globalCompositeOperation: 'source-over',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    setTransform: (...a: unknown[]) => calls.push(['setTransform', ...a]),
    clearRect: (...a: unknown[]) => calls.push(['clearRect', ...a]),
    save: () => {
      stack.push({
        globalCompositeOperation: String(ctx.globalCompositeOperation),
        shadowColor: String(ctx.shadowColor),
        shadowBlur: Number(ctx.shadowBlur),
        shadowOffsetX: Number(ctx.shadowOffsetX),
        shadowOffsetY: Number(ctx.shadowOffsetY),
        fillStyle: String(ctx.fillStyle),
        strokeStyle: String(ctx.strokeStyle),
        lineWidth: Number(ctx.lineWidth),
      })
      calls.push(['save'])
    },
    restore: () => {
      const prev = stack.pop()
      if (prev) {
        ctx.globalCompositeOperation = prev.globalCompositeOperation
        ctx.shadowColor = prev.shadowColor
        ctx.shadowBlur = prev.shadowBlur
        ctx.shadowOffsetX = prev.shadowOffsetX
        ctx.shadowOffsetY = prev.shadowOffsetY
        ctx.fillStyle = prev.fillStyle
        ctx.strokeStyle = prev.strokeStyle
        ctx.lineWidth = prev.lineWidth
      }
      calls.push(['restore'])
    },
    beginPath: () => calls.push(['beginPath']),
    translate: (...a: unknown[]) => calls.push(['translate', ...a]),
    rect: (...a: unknown[]) => calls.push(['rect', ...a]),
    roundRect: (...a: unknown[]) => calls.push(['roundRect', ...a]),
    moveTo: (...a: unknown[]) => calls.push(['moveTo', ...a]),
    lineTo: (...a: unknown[]) => calls.push(['lineTo', ...a]),
    arc: (...a: unknown[]) => calls.push(['arc', ...a]),
    closePath: () => calls.push(['closePath']),
    clip: (...a: unknown[]) => calls.push(['clip', ...a]),
    fill: (...a: unknown[]) => {
      fillSnapshots.push({
        globalCompositeOperation: String(ctx.globalCompositeOperation),
        shadowColor: String(ctx.shadowColor),
        shadowBlur: Number(ctx.shadowBlur),
        shadowOffsetX: Number(ctx.shadowOffsetX),
        shadowOffsetY: Number(ctx.shadowOffsetY),
      })
      calls.push(['fill', ...a])
    },
    stroke: () => calls.push(['stroke']),
    createLinearGradient: () => ({ addColorStop() {} }),
  }

  return { ctx, calls, fillSnapshots }
}

test('overlayRenderer: 2D Canvas automatic fallback renders N-primitive shadows, hairlines, borders, and rim catchlights', () => {
  const mock2d = createMock2d()

  // Verify WebGL2 compile failure also falls back automatically to 2D Canvas
  const failingGl = createMockWebGL2({ failCompile: true })
  const listeners = new Map<string, () => void>()
  const mockCanvas = {
    width: 10,
    height: 10,
    addEventListener: (k: string, fn: () => void) => listeners.set(k, fn),
    removeEventListener: (k: string) => listeners.delete(k),
    getContext: (kind: string) => (kind === 'webgl2' ? failingGl.gl : kind === '2d' ? mock2d.ctx : null),
  } as unknown as HTMLCanvasElement

  const renderer = createGlassOverlayRenderer()
  const caps = renderer.mount(mockCanvas)
  assert.equal(caps.webgl2, false)
  assert.ok(caps.fallbackNotice?.includes('2D Canvas'))

  const three = [createPrimitive(0), createPrimitive(1), createPrimitive(2)]
  const degenerate: GlassPrimitive = { center: { x: 0, y: 0 }, size: { width: 0.001, height: 10 }, radius: 1 }

  renderer.render(
    makeFrame([three[0], degenerate, three[1], three[2]], {
      field: {
        primitives: [three[0], degenerate, three[1], three[2]],
        blendK: 0,
        rimOpacity: 0.85,
        styleMix: 0.6,
      },
      material: {
        ...DEFAULT_OPTICAL_MATERIALS.dark.frosted,
        borderWidth: 1,
        borderRgba: [1, 1, 1, 0.3],
      },
    }),
  )

  assert.equal(mockCanvas.width, 800)
  assert.equal(mockCanvas.height, 600)
  assert.equal(mock2d.calls.some((c) => c[0] === 'clip' && c[1] === 'evenodd'), false)
  assert.equal(mock2d.fillSnapshots.length, 2)
  assert.equal(mock2d.fillSnapshots[0]?.globalCompositeOperation, 'source-over')
  assert.equal(mock2d.fillSnapshots[1]?.globalCompositeOperation, 'destination-out')
  // Shadow (fill + destination-out erase), hairline, uniform border, rim (clip + stroke) = 6 passes x 3 active primitives => 18 roundRect calls
  const roundRectCalls = mock2d.calls.filter((c) => c[0] === 'roundRect')
  assert.equal(roundRectCalls.length, 18)
  assert.equal(mock2d.calls.filter((c) => c[0] === 'stroke').length, 3)

  // N=0 clears without drawing roundRect
  mock2d.calls.length = 0
  renderer.render(makeFrame([]))
  assert.ok(mock2d.calls.some((c) => c[0] === 'clearRect'))
  assert.equal(mock2d.calls.filter((c) => c[0] === 'roundRect').length, 0)

  // clear() invokes clearRect
  mock2d.calls.length = 0
  renderer.clear()
  assert.ok(mock2d.calls.some((c) => c[0] === 'clearRect'))

  renderer.dispose()
  assert.equal(listeners.size, 0)
})

test('overlayRenderer: 2D fallback erases overlapping primitive shadow interiors with destination-out instead of clip(evenodd)', () => {
  const mock2d = createMock2d()
  const mockCanvas = {
    width: 10,
    height: 10,
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: (kind: string) => (kind === '2d' ? mock2d.ctx : null),
  } as unknown as HTMLCanvasElement

  const renderer = createGlassOverlayRenderer()
  renderer.mount(mockCanvas)

  const overlapping: GlassPrimitive[] = [
    { id: 'a', center: { x: 80, y: 80 }, size: { width: 60, height: 60 }, radius: 12 },
    { id: 'b', center: { x: 100, y: 80 }, size: { width: 60, height: 60 }, radius: 12 },
  ]

  renderer.render(
    makeFrame(overlapping, {
      field: { primitives: overlapping, blendK: 0 },
      material: {
        ...DEFAULT_OPTICAL_MATERIALS.dark.frosted,
        shadowAlpha: 0.35,
        shadowBlur: 18,
        shadowOffsetY: 6,
      },
    }),
  )

  assert.equal(
    mock2d.calls.some((c) => c[0] === 'clip' && c[1] === 'evenodd'),
    false,
    'must never use clip(evenodd) for overlapping primitive shadows',
  )
  assert.equal(mock2d.fillSnapshots.length, 2)
  assert.equal(mock2d.fillSnapshots[0]?.globalCompositeOperation, 'source-over')
  assert.ok(mock2d.fillSnapshots[0]!.shadowBlur > 0)
  assert.ok(mock2d.fillSnapshots[0]!.shadowOffsetX < 0, 'shadow caster must be translated offscreen to prevent AA fringe')
  const translateCalls = mock2d.calls.filter((c) => c[0] === 'translate')
  assert.equal(translateCalls.length, 2)
  assert.equal(translateCalls[0]?.[1], -(translateCalls[1]?.[1] as number))
  assert.equal(mock2d.fillSnapshots[1]?.globalCompositeOperation, 'destination-out')
  assert.equal(mock2d.fillSnapshots[1]?.shadowColor, 'rgba(0, 0, 0, 0)')
  assert.equal(mock2d.fillSnapshots[1]?.shadowBlur, 0)
  assert.equal(mock2d.fillSnapshots[1]?.shadowOffsetX, 0)
  assert.equal(mock2d.fillSnapshots[1]?.shadowOffsetY, 0)
  assert.equal(mock2d.ctx.globalCompositeOperation, 'source-over', 'restore() must reset composite mode')

  renderer.dispose()
})

test('overlayRenderer: 2D fallback traces smooth blended liquid-bridge contour via extractFieldContourPath when blendK > 0.001', () => {
  const mock2d = createMock2d()
  const mockCanvas = {
    width: 10,
    height: 10,
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: (kind: string) => (kind === '2d' ? mock2d.ctx : null),
  } as unknown as HTMLCanvasElement

  const renderer = createGlassOverlayRenderer()
  renderer.mount(mockCanvas)

  const nearbyField = {
    primitives: [
      { id: 'left', center: { x: 50, y: 60 }, size: { width: 20, height: 20 }, radius: 6 },
      { id: 'right', center: { x: 74, y: 60 }, size: { width: 20, height: 20 }, radius: 6 },
    ],
    blendK: 16,
  }
  const expectedContour = extractFieldContourPath(nearbyField)
  assert.ok(expectedContour.startsWith('M') && expectedContour.includes('L') && expectedContour.endsWith('Z'))

  renderer.render(
    makeFrame(nearbyField.primitives, {
      field: nearbyField,
      material: {
        ...DEFAULT_OPTICAL_MATERIALS.dark.frosted,
        borderWidth: 1,
        borderRgba: [1, 1, 1, 0.25],
      },
    }),
  )

  assert.equal(
    mock2d.calls.filter((c) => c[0] === 'roundRect').length,
    0,
    'blended 2D fallback must trace smooth liquid contour instead of separate roundRects',
  )
  const moveTos = mock2d.calls.filter((c) => c[0] === 'moveTo')
  const lineTos = mock2d.calls.filter((c) => c[0] === 'lineTo')
  const closePaths = mock2d.calls.filter((c) => c[0] === 'closePath')
  // 6 passes (shadow fill, shadow destination-out erase, hairline, border, rim clip, rim stroke)
  assert.equal(moveTos.length, 6)
  assert.ok(lineTos.length >= 60, `expected Marching Squares contour lineTo segments, got ${lineTos.length}`)
  assert.equal(closePaths.length, 6)

  renderer.dispose()
})

test('overlayRenderer: traceSvgPath2d accurately decodes M, L, clockwise arc A, and Z commands', () => {
  const mock2d = createMock2d()
  const roundedPath = formatRoundedRectPath({
    center: { x: 50, y: 40 },
    size: { width: 40, height: 20 },
    radius: 5,
  })

  traceSvgPath2d(mock2d.ctx as unknown as CanvasRenderingContext2D, roundedPath)

  const arcCalls = mock2d.calls.filter((c) => c[0] === 'arc')
  assert.equal(arcCalls.length, 4, 'rounded rect emits 4 corner arcs')
  // Top-right corner center is (65, 35) with radius 5, clockwise (anticlockwise=false)
  assert.deepEqual(arcCalls[0], ['arc', 65, 35, 5, -Math.PI / 2, 0, false])
  assert.equal(mock2d.calls.filter((c) => c[0] === 'closePath').length, 1)
})

function createSpecLockedCanvas(options: {
  targetGl?: Record<string, unknown> | null
  target2d: Record<string, unknown> | null
  probeGl: Record<string, unknown> | null
}): {
  canvas: HTMLCanvasElement
  getWebgl2Calls: () => number
  get2dCalls: () => number
} {
  let lockedMode: 'webgl2' | '2d' | null = null
  let webgl2Calls = 0
  let twoDCalls = 0

  const probeCanvas = {
    getContext: (kind: string) => (kind === 'webgl2' ? options.probeGl : null),
  }

  const canvas = {
    width: 10,
    height: 10,
    ownerDocument: {
      createElement: (tag: string) => (tag === 'canvas' ? probeCanvas : null),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: (kind: string) => {
      if (kind === 'webgl2') {
        webgl2Calls++
        if (lockedMode !== null && lockedMode !== 'webgl2') return null
        if (options.targetGl) {
          lockedMode = 'webgl2'
          return options.targetGl
        }
        return null
      }
      if (kind === '2d') {
        twoDCalls++
        if (lockedMode !== null && lockedMode !== '2d') return null
        if (options.target2d) {
          lockedMode = '2d'
          return options.target2d
        }
        return null
      }
      return null
    },
  } as unknown as HTMLCanvasElement

  return {
    canvas,
    getWebgl2Calls: () => webgl2Calls,
    get2dCalls: () => twoDCalls,
  }
}

test('overlayRenderer: offscreen probe prevents WebGL2 context lock on targetCanvas and falls back to 2D Canvas', () => {
  const compileFailProbe = createMockWebGL2({ failCompile: true })
  const targetGl = createMockWebGL2()
  const mock2d = createMock2d()
  const locked = createSpecLockedCanvas({
    targetGl: targetGl.gl,
    target2d: mock2d.ctx,
    probeGl: compileFailProbe.gl,
  })

  const renderer = createGlassOverlayRenderer()
  const caps = renderer.mount(locked.canvas)

  assert.equal(locked.getWebgl2Calls(), 0, 'must probe offscreen before calling getContext("webgl2") on targetCanvas')
  assert.equal(locked.get2dCalls(), 1)
  assert.equal(caps.webgl2, false)
  assert.ok(caps.fallbackNotice?.includes('2D Canvas'))
  assert.ok(compileFailProbe.deletedShaders >= 1)
  assert.equal(compileFailProbe.loseContextCalls, 1)

  renderer.render(makeFrame([createPrimitive(0)]))
  assert.ok(mock2d.calls.filter((c) => c[0] === 'roundRect').length > 0)
  assert.ok(mock2d.calls.filter((c) => c[0] === 'stroke').length > 0)
  renderer.dispose()

  // Also verify probe program deletion + loseContext cleanup on link failure and healthy probe
  const linkFailProbe = createMockWebGL2({ failLink: true })
  const linkMock2d = createMock2d()
  const linkLocked = createSpecLockedCanvas({
    targetGl: targetGl.gl,
    target2d: linkMock2d.ctx,
    probeGl: linkFailProbe.gl,
  })

  const linkRenderer = createGlassOverlayRenderer()
  const linkCaps = linkRenderer.mount(linkLocked.canvas)
  assert.equal(linkLocked.getWebgl2Calls(), 0)
  assert.equal(linkCaps.webgl2, false)
  assert.ok(linkCaps.fallbackNotice?.includes('2D Canvas'))
  assert.equal(linkFailProbe.deletedPrograms, 1)
  assert.equal(linkFailProbe.loseContextCalls, 1)
  linkRenderer.render(makeFrame([createPrimitive(1)]))
  assert.ok(linkMock2d.calls.filter((c) => c[0] === 'roundRect').length > 0)
  assert.ok(linkMock2d.calls.filter((c) => c[0] === 'stroke').length > 0)
  linkRenderer.dispose()

  const healthyProbe = createMockWebGL2()
  const healthyTargetGl = createMockWebGL2()
  const healthyLocked = createSpecLockedCanvas({
    targetGl: healthyTargetGl.gl,
    target2d: createMock2d().ctx,
    probeGl: healthyProbe.gl,
  })
  const healthyRenderer = createGlassOverlayRenderer()
  const healthyCaps = healthyRenderer.mount(healthyLocked.canvas)
  assert.equal(healthyLocked.getWebgl2Calls(), 1)
  assert.equal(healthyCaps.webgl2, true)
  assert.equal(healthyProbe.deletedPrograms, 1)
  assert.equal(healthyProbe.loseContextCalls, 1)
  healthyRenderer.dispose()
})

test('overlayRenderer: fragment shader applies isotropic computeDirectionalRimWeight for both bordered and borderless modes', () => {
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('float computeDirectionalRimWeight('))
  assert.ok(OVERLAY_FRAGMENT_SHADER.includes('if (focus < 0.05)'))

  const borderedIdx = OVERLAY_FRAGMENT_SHADER.indexOf('if (hasUniformBorder > 0.5)')
  const elseIdx = OVERLAY_FRAGMENT_SHADER.indexOf('} else {', borderedIdx)
  const directionalIdx = OVERLAY_FRAGMENT_SHADER.indexOf('if (wDirectional > 0.001)', elseIdx)
  const softIdx = OVERLAY_FRAGMENT_SHADER.indexOf('if (wSoft > 0.001)', directionalIdx)

  assert.ok(borderedIdx !== -1 && elseIdx > borderedIdx)
  assert.ok(directionalIdx > elseIdx && softIdx > directionalIdx)

  const borderedBranch = OVERLAY_FRAGMENT_SHADER.slice(borderedIdx, elseIdx)
  const borderlessDirectionalBranch = OVERLAY_FRAGMENT_SHADER.slice(directionalIdx, softIdx)

  assert.ok(
    borderedBranch.includes('computeDirectionalRimWeight(normal, uRimParams.w, uBorderParams.y)'),
    'bordered branch must use computeDirectionalRimWeight',
  )
  assert.ok(
    borderlessDirectionalBranch.includes('computeDirectionalRimWeight(normal, uRimParams.w, uBorderParams.y)'),
    'borderless directional branch must use computeDirectionalRimWeight so rimFocus=0 preserves vertical side highlights',
  )
})
