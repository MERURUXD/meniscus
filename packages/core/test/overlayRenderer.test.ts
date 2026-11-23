/**
 * Unit tests for the @meniscus/core WebGL2 + 2D Canvas optical edge renderer.
 * Verifies shader contracts, mount/capabilities, uniform uploads for N=0/1/3/16 and >16 truncation,
 * 2D Canvas multi-primitive fallback rendering, WebGL context lost/restored, and dispose cleanup.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
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
  contextLostFlag: boolean
}

function createMockWebGL2(options: { failCompile?: boolean } = {}): MockGlState {
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
    getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (param: number) => (param === 0x0d33 ? 8192 : 0),
    createShader: (type: number) => ({ id: nextId++, type }),
    shaderSource: (shader: object, src: string) => {
      shaderSources.set(shader, src)
    },
    compileShader: () => {},
    getShaderParameter: () => !options.failCompile,
    getShaderInfoLog: () => (options.failCompile ? 'Mock compile error' : ''),
    deleteShader: () => {},
    createProgram: () => ({ id: nextId++ }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
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

test('overlayRenderer: 2D Canvas automatic fallback renders N-primitive shadows, hairlines, borders, and rim catchlights', () => {
  const calls: Array<[string, ...unknown[]]> = []
  const fake2d = {
    setTransform: (...a: unknown[]) => calls.push(['setTransform', ...a]),
    clearRect: (...a: unknown[]) => calls.push(['clearRect', ...a]),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    rect: (...a: unknown[]) => calls.push(['rect', ...a]),
    roundRect: (...a: unknown[]) => calls.push(['roundRect', ...a]),
    clip: (...a: unknown[]) => calls.push(['clip', ...a]),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
    createLinearGradient: () => ({ addColorStop() {} }),
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  }

  // Verify WebGL2 compile failure also falls back automatically to 2D Canvas
  const failingGl = createMockWebGL2({ failCompile: true })
  const listeners = new Map<string, () => void>()
  const mockCanvas = {
    width: 10,
    height: 10,
    addEventListener: (k: string, fn: () => void) => listeners.set(k, fn),
    removeEventListener: (k: string) => listeners.delete(k),
    getContext: (kind: string) => (kind === 'webgl2' ? failingGl.gl : kind === '2d' ? fake2d : null),
  } as unknown as HTMLCanvasElement

  const renderer = createGlassOverlayRenderer()
  const caps = renderer.mount(mockCanvas)
  assert.equal(caps.webgl2, false)
  assert.ok(caps.fallbackNotice?.includes('2D Canvas'))

  const three = [createPrimitive(0), createPrimitive(1), createPrimitive(2)]
  const degenerate: GlassPrimitive = { center: { x: 0, y: 0 }, size: { width: 0.001, height: 10 }, radius: 1 }

  renderer.render(
    makeFrame([three[0], degenerate, three[1], three[2]], {
      material: {
        ...DEFAULT_OPTICAL_MATERIALS.dark.frosted,
        borderWidth: 1,
        borderRgba: [1, 1, 1, 0.3],
      },
    }),
  )

  assert.equal(mockCanvas.width, 800)
  assert.equal(mockCanvas.height, 600)
  assert.ok(calls.some((c) => c[0] === 'clip' && c[1] === 'evenodd'))
  // Shadow (clip + fill), hairline, uniform border, rim (clip + stroke) = 6 passes x 3 active primitives => 18 roundRect calls
  const roundRectCalls = calls.filter((c) => c[0] === 'roundRect')
  assert.equal(roundRectCalls.length, 18)
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 3)

  // N=0 clears without drawing roundRect
  calls.length = 0
  renderer.render(makeFrame([]))
  assert.ok(calls.some((c) => c[0] === 'clearRect'))
  assert.equal(calls.filter((c) => c[0] === 'roundRect').length, 0)

  // clear() invokes clearRect
  calls.length = 0
  renderer.clear()
  assert.ok(calls.some((c) => c[0] === 'clearRect'))

  renderer.dispose()
  assert.equal(listeners.size, 0)
})
