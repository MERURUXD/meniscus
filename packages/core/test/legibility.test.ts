/**
 * @sessile/core unit tests for the adaptive backdrop legibility kernel.
 *
 * The contrast guarantee is checked against a model of the Route B3 stage as the browser runs
 * it: luminance matrix (linear or sRGB per `LEGIBILITY_STAGES`), table lookup, arithmetic
 * composite, 8-bit intermediates, then the veil composited in sRGB space.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEGIBILITY_LIMIT_MARGIN,
  LEGIBILITY_POLICIES,
  TELEMETRY_STRIDE,
  LEGIBILITY_STAGES,
  computeBackdropRisk,
  contrastRatio,
  createAsymmetricSmoother,
  createLegibilityParams,
  createTelemetryAccumulator,
  linearToSrgb,
  measureTelemetryGrid,
  relativeLuminance,
  srgbLuma,
  resolveLegibilityGoal,
  resolveLegibilityParams,
  type BackdropTelemetry,
  type LegibilityParams,
  type LegibilityTier,
} from '../src/legibility.ts'

const WHITE = [1, 1, 1]
const INK = [0.07, 0.07, 0.08]
const DARK_VEIL = [0.207, 0.207, 0.22, 0.62]
const LIGHT_VEIL = [0.99, 0.99, 0.99, 0.2]
const NO_VEIL = [1, 1, 1, 0]
const FULL_RISK = { luma: 1, chroma: 1, detail: 1 }
const NO_RISK = { luma: 0, chroma: 0, detail: 0 }

type VeilOptics = { brightness: number; contrast: number; contrastFirst: boolean }
const unit = (v: number): number => Math.min(1, Math.max(0, v))
/** CSS `brightness()` / `contrast()` in the given order, clamped after each function as browsers do. */
const cssOptics = (o: VeilOptics, x: number): number =>
  o.contrastFirst
    ? unit(o.brightness * unit(o.contrast * x + 0.5 * (1 - o.contrast)))
    : unit(o.contrast * unit(o.brightness * x) + 0.5 * (1 - o.contrast))

const q8 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255

function sampleTable(table: Float32Array, x: number): number {
  const p = x * (table.length - 1)
  const i = Math.min(table.length - 2, Math.floor(p))
  const f = p - i
  return table[i]! * (1 - f) + table[i + 1]! * f
}

function runStage(params: LegibilityParams, c: readonly number[]): number[] {
  const stage = LEGIBILITY_STAGES[params.polarity]
  const x =
    stage.luminanceSpace === 'linearRGB'
      ? q8(linearToSrgb(q8(relativeLuminance(c[0]!, c[1]!, c[2]!))))
      : q8(0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!)
  const m = q8(sampleTable(params.table, x))
  const [k1, k2, k3, k4] = stage.k
  return c.map((v) => q8(k1 * v * m + k2 * v + k3 * m + k4))
}

function perceivedLuminance(params: LegibilityParams, c: readonly number[]): number {
  const out = runStage(params, c)
  const v = params.veilRgba
  const p = out.map((ch, i) => q8((1 - v[3]!) * ch + v[3]! * v[i]!))
  return relativeLuminance(p[0]!, p[1]!, p[2]!)
}

function* colorGrid(steps: number): Generator<number[]> {
  for (let r = 0; r <= steps; r++) {
    for (let g = 0; g <= steps; g++) {
      for (let b = 0; b <= steps; b++) {
        yield [r / steps, g / steps, b / steps]
      }
    }
  }
}

function solve(
  tier: LegibilityTier,
  foreground: number[],
  veil: number[],
  risk = FULL_RISK,
): LegibilityParams {
  const goal = resolveLegibilityGoal({ foreground, tier })
  const params = createLegibilityParams()
  resolveLegibilityParams(goal, risk, veil, params)
  return params
}

test('resolveLegibilityGoal infers polarity and converts the WCAG bound to encoded luminance', () => {
  const light = resolveLegibilityGoal({ foreground: WHITE, tier: 'regular' })
  assert.equal(light.polarity, 'light')
  assert.equal(light.contrast, 4.5)
  assert.ok(Math.abs(light.perceivedLimit - linearToSrgb(1.05 / 4.5 - 0.05)) < 1e-9)

  const dark = resolveLegibilityGoal({ foreground: INK, tier: 'legible' })
  assert.equal(dark.polarity, 'dark')
  assert.equal(dark.contrast, 7)

  const forced = resolveLegibilityGoal({ foreground: WHITE, polarity: 'dark', contrast: 2 })
  assert.equal(forced.polarity, 'dark')
  assert.equal(forced.contrast, 2)
})

test('every tier keeps its contrast over any backdrop color at any risk, neutral or tinted veil', () => {
  const neutral = [
    { fg: WHITE, veil: DARK_VEIL },
    { fg: WHITE, veil: LIGHT_VEIL },
    { fg: WHITE, veil: NO_VEIL },
    { fg: INK, veil: [0.99, 0.99, 0.99, 0.54] },
    { fg: INK, veil: [0, 0, 0, 0] },
    { fg: INK, veil: [0.207, 0.207, 0.22, 0.3] },
  ]
  const tinted = [[0, 0, 1], [1, 0, 0], [1, 0.9, 0], [0.2, 0.8, 0.6]].flatMap((rgb) =>
    [0.3, 0.6].flatMap((a) => [WHITE, INK].map((fg) => ({ fg, veil: [...rgb, a] }))),
  )
  let tintedFeasible = 0
  for (const tier of ['clear', 'regular', 'legible'] as const) {
    for (const risk of [NO_RISK, FULL_RISK]) {
      for (const { fg, veil } of [...neutral, ...tinted]) {
        const params = solve(tier, fg, veil, risk)
        if (neutral.some((n) => n.veil === veil)) {
          assert.ok(params.feasible, `neutral veil ${veil} is feasible`)
        } else if (!params.feasible) {
          continue
        } else {
          tintedFeasible += 1
        }
        const lf = relativeLuminance(fg[0]!, fg[1]!, fg[2]!)
        for (const c of colorGrid(16)) {
          const ratio = contrastRatio(perceivedLuminance(params, c), lf)
          assert.ok(
            ratio >= LEGIBILITY_POLICIES[tier].contrast,
            `${tier} risk=${risk.luma} fg=${fg} veil=${veil} backdrop=${c.map((v) => v.toFixed(2))} gave ${ratio.toFixed(3)}`,
          )
        }
      }
    }
  }
  assert.ok(tintedFeasible > 40, `most tinted cases stay feasible, got ${tintedFeasible}`)
})

test('feasibility reports when the veil alone already violates the goal', () => {
  assert.equal(solve('regular', WHITE, [1, 1, 1, 1]).feasible, false)
  assert.equal(solve('regular', WHITE, [0.1, 0.1, 0.1, 1]).feasible, true)
  assert.equal(solve('regular', WHITE, [1, 1, 1, 0.9]).feasible, false)
  assert.equal(solve('legible', INK, [1, 0, 0, 0.6]).feasible, false, 'a red veil caps dark-text contrast')
})

test('pixels already safe pass through untouched and compressed pixels keep their hue', () => {
  const params = solve('regular', WHITE, NO_VEIL)
  for (const c of [[0, 0, 0], [0.1, 0.12, 0.3], [0.25, 0.05, 0.05]]) {
    assert.deepEqual(runStage(params, c), c.map(q8), `dark backdrop ${c} must not change`)
  }

  const orange = [1, 0.5, 0]
  const out = runStage(params, orange)
  assert.ok(out[0]! < 0.9, 'bright orange is compressed')
  assert.ok(Math.abs(out[1]! / out[0]! - 0.5) < 0.02, `hue ratio kept, got ${out}`)
  assert.equal(out[2], 0)
})

test('a veil that already guarantees contrast leaves the per-pixel stage at identity', () => {
  const params = solve('clear', WHITE, DARK_VEIL)
  assert.ok(params.table.every((m) => m === 1))
  assert.equal(params.fallbackVeil.brightness, 1)
  assert.equal(params.fallbackVeil.contrast, 1)
})

test('table revision only advances when the multiplier moves by half an 8-bit step', () => {
  const goal = resolveLegibilityGoal({ foreground: WHITE, tier: 'regular' })
  const params = createLegibilityParams()
  resolveLegibilityParams(goal, { luma: 0.5, chroma: 0, detail: 0 }, NO_VEIL, params)
  const first = params.tableRevision
  assert.equal(resolveLegibilityParams(goal, { luma: 0.5, chroma: 0, detail: 0 }, NO_VEIL, params), false)
  resolveLegibilityParams(goal, { luma: 0.5001, chroma: 0, detail: 0 }, NO_VEIL, params)
  assert.equal(params.tableRevision, first)
  resolveLegibilityParams(goal, { luma: 1, chroma: 0, detail: 0 }, NO_VEIL, params)
  assert.equal(params.tableRevision, first + 1)
})

test('material response is identity at zero risk and reaches the tier floors at full risk', () => {
  const calm = solve('legible', WHITE, DARK_VEIL, NO_RISK)
  assert.equal(calm.refractionScale, 1)
  assert.equal(calm.blurBoostPx, 0)
  assert.equal(calm.saturationScale, 1)
  assert.equal(calm.hairlineScale, 1)
  assert.equal(calm.shadowScale, 1)
  assert.ok(Math.abs(calm.veilRgba[3]! - DARK_VEIL[3]!) < 1e-6, 'no film without risk')

  const busy = solve('legible', WHITE, DARK_VEIL, FULL_RISK)
  const policy = LEGIBILITY_POLICIES.legible
  assert.ok(Math.abs(busy.refractionScale - policy.refractionFloor) < 1e-6)
  assert.ok(Math.abs(busy.blurBoostPx - policy.blurBoostPx) < 1e-6)
  assert.ok(Math.abs(busy.saturationScale - policy.saturationFloor) < 1e-6)
  assert.ok(busy.veilRgba[3]! > DARK_VEIL[3]!, 'film thickens the veil')
  assert.ok(busy.veilRgba[0]! < DARK_VEIL[0]!, 'film darkens toward the safe extreme for light text')
})

test('fallback stage maps the estimated tail onto the backdrop limit without clamping inside', () => {
  const light = solve('regular', WHITE, NO_VEIL)
  assert.ok(cssOptics(light.fallbackVeil, 1) <= light.backdropLimit + 1e-6, 'white maps under the ceiling')
  assert.ok(cssOptics(light.fallbackVeil, 1) > 0.3, 'compression is bounded, not a blackout')

  const dark = solve('regular', INK, [0, 0, 0, 0])
  const veil = dark.fallbackVeil
  assert.ok(cssOptics(veil, 0) >= dark.backdropLimit - 1e-6, 'black lifts over the floor')
  assert.ok(Math.abs(cssOptics(veil, 1) - 1) < 1e-9, 'white stays white')
  assert.ok(veil.contrastFirst && veil.brightness * (0.5 + 0.5 * veil.contrast) <= 1 + 1e-9, 'no stage clamps')
})

test('the fallback stage holds the limit after host optics, including tails they clip', () => {
  const flat = (l: number): BackdropTelemetry => ({ lumaHigh: l, lumaLow: l, chroma: 0, detail: 0 })
  const brighten = (brightness: number, contrast = 1): VeilOptics => ({ brightness, contrast, contrastFirst: false })
  const cases = [
    [WHITE, 0.3, brighten(2)],
    // Host optics clip white; the correction must act on the clipped value, not the raw affine.
    [WHITE, 1, brighten(2)],
    [WHITE, 0.8, brighten(1, 1.8)],
    [INK, 0.6, brighten(0.5)],
    [INK, 0.1, brighten(1, 1.8)],
    // Contrast clips white to 1 before brightness dims it to 0.4; one folded affine says 0.6.
    [INK, 1, { brightness: 0.4, contrast: 2, contrastFirst: true }],
    [WHITE, 0, { brightness: 2.5, contrast: 0.6, contrastFirst: false }],
  ] as const
  for (const [foreground, raw, optics] of cases) {
    const goal = resolveLegibilityGoal({ foreground, tier: 'regular' })
    const light = goal.polarity === 'light'
    const params = createLegibilityParams()
    const risk = computeBackdropRisk(flat(raw), goal, NO_VEIL, { luma: 0, chroma: 0, detail: 0 }, optics)
    resolveLegibilityParams(goal, risk, NO_VEIL, params)
    const hosted = cssOptics(optics, raw)
    const shown = cssOptics(params.fallbackVeil, hosted)
    assert.ok(
      light ? shown <= params.backdropLimit + 1e-9 : shown >= params.backdropLimit - 1e-9,
      `${goal.polarity}: host optics map ${raw} to ${hosted}, corrected to ${shown}, limit ${params.backdropLimit}`,
    )
  }
})

test('fallback correction holds per pixel on colored backdrops under arbitrary host optics', () => {
  // One pixel per telemetry, so its tails are exact; CSS clips per channel at every stage and the
  // text sits on the encoded luminance of the result.
  const encoded = (rgb: readonly number[]): number =>
    linearToSrgb(relativeLuminance(rgb[0]!, rgb[1]!, rgb[2]!))
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let n = 0; n < 4000; n++) {
    const rgb = [rand(), rand(), rand()].map((v) => (n % 3 === 0 ? Math.round(v) : v))
    const optics: VeilOptics = { brightness: rand() * 2.5, contrast: rand() * 2.5, contrastFirst: rand() < 0.5 }
    const L = encoded(rgb)
    const t: BackdropTelemetry = {
      lumaHigh: L,
      lumaLow: srgbLuma(rgb[0]!, rgb[1]!, rgb[2]!),
      channelHigh: Math.max(...rgb),
      channelLow: Math.min(...rgb),
      chroma: 0,
      detail: 0,
    }
    for (const foreground of [WHITE, INK]) {
      const goal = resolveLegibilityGoal({ foreground, tier: n % 2 ? 'regular' : 'legible' })
      const params = createLegibilityParams()
      const risk = computeBackdropRisk(t, goal, NO_VEIL, { luma: 0, chroma: 0, detail: 0 }, optics)
      resolveLegibilityParams(goal, risk, NO_VEIL, params)
      const shown = encoded(rgb.map((v) => cssOptics(params.fallbackVeil, cssOptics(optics, v))))
      const ok =
        goal.polarity === 'light'
          ? shown <= params.backdropLimit + LEGIBILITY_LIMIT_MARGIN
          : shown >= params.backdropLimit - LEGIBILITY_LIMIT_MARGIN
      assert.ok(ok, `${goal.polarity}: ${rgb} ${JSON.stringify(optics)} shows ${shown}, limit ${params.backdropLimit}`)
    }
  }
})

test('pure blue under host brightness and contrast still triggers the dark-text correction', () => {
  const goal = resolveLegibilityGoal({ foreground: INK, tier: 'regular' })
  const blue = [0, 0, 1]
  const t: BackdropTelemetry = {
    lumaHigh: linearToSrgb(relativeLuminance(0, 0, 1)),
    lumaLow: srgbLuma(0, 0, 1),
    channelHigh: 1,
    channelLow: 0,
    chroma: 1,
    detail: 0,
  }
  const optics: VeilOptics = { brightness: 2, contrast: 2, contrastFirst: false }
  const params = createLegibilityParams()
  const risk = computeBackdropRisk(t, goal, NO_VEIL, { luma: 0, chroma: 0, detail: 0 }, optics)
  resolveLegibilityParams(goal, risk, NO_VEIL, params)
  // Per-channel clipping leaves pure blue unchanged; the lift then runs per channel too.
  const shown = linearToSrgb(
    relativeLuminance(...(blue.map((v) => cssOptics(params.fallbackVeil, cssOptics(optics, v))) as [number, number, number])),
  )
  assert.ok(shown >= params.backdropLimit - 1e-9, `blue corrected to ${shown}, limit ${params.backdropLimit}`)
})

test('backdrop risk is zero under the knee, saturates at white and tracks chroma and detail', () => {
  const goal = resolveLegibilityGoal({ foreground: WHITE, tier: 'regular' })
  const risk = { luma: 0, chroma: 0, detail: 0 }
  const calm: BackdropTelemetry = { lumaHigh: 0.2, lumaLow: 0.05, chroma: 0.05, detail: 0.01 }
  computeBackdropRisk(calm, goal, NO_VEIL, risk)
  assert.deepEqual(risk, { luma: 0, chroma: 0, detail: 0 })

  computeBackdropRisk({ lumaHigh: 1, lumaLow: 0, chroma: 0.8, detail: 0.5 }, goal, NO_VEIL, risk)
  assert.deepEqual(risk, { luma: 1, chroma: 1, detail: 1 })

  computeBackdropRisk({ lumaHigh: 0.6, lumaLow: 0, chroma: 0, detail: 0 }, goal, NO_VEIL, risk)
  const mid = risk.luma
  computeBackdropRisk({ lumaHigh: 0.601, lumaLow: 0, chroma: 0, detail: 0 }, goal, NO_VEIL, risk)
  assert.ok(mid > 0 && mid < 1 && Math.abs(risk.luma - mid) < 0.01, 'luma risk is continuous')
})

test('telemetry accumulator stays continuous as a bright region slides into the rect', () => {
  const acc = createTelemetryAccumulator()
  const out: BackdropTelemetry = { lumaHigh: 0, lumaLow: 0, chroma: 0, detail: 0 }
  assert.equal(acc.resolve(out), false)

  const dark: BackdropTelemetry = { lumaHigh: 0.15, lumaLow: 0.02, chroma: 0.1, detail: 0.05 }
  const bright: BackdropTelemetry = { lumaHigh: 1, lumaLow: 0.6, chroma: 0.9, detail: 0.4 }
  let prev = 0.15
  for (let share = 0; share <= 1.0001; share += 0.01) {
    acc.reset()
    acc.add(dark, 1 - share)
    acc.add(bright, share)
    assert.ok(acc.resolve(out))
    assert.ok(out.lumaHigh >= prev - 1e-9, 'monotone in coverage')
    assert.ok(out.lumaHigh - prev < 0.05, `no jump at share ${share.toFixed(2)}`)
    prev = out.lumaHigh
  }
  acc.reset()
  acc.add(dark, 0.9)
  acc.add(bright, 0.1)
  acc.resolve(out)
  assert.ok(out.lumaHigh > 0.9 * 0.15 + 0.1 * 1 + 0.08, 'a 10% bright patch outweighs its area share')
})

test('measureTelemetryGrid separates bright, dark, saturated and text-dense cells', () => {
  const w = 32
  const h = 16
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (x < 8) {
        rgba.set([255, 255, 255, 255], i)
      } else if (x < 16) {
        rgba.set([0, 0, 0, 255], i)
      } else if (x < 24) {
        rgba.set([255, 0, 0, 255], i)
      } else {
        const ink = x % 2 === 0 ? 255 : 0
        rgba.set([ink, ink, ink, 255], i)
      }
    }
  }
  const grid = measureTelemetryGrid(rgba, w, h, 4, 1)
  const cell = (c: number) => {
    const [lumaHigh, lumaLow, channelHigh, channelLow, chroma, detail] = grid.data.subarray(
      c * TELEMETRY_STRIDE,
      (c + 1) * TELEMETRY_STRIDE,
    )
    return { lumaHigh: lumaHigh!, lumaLow: lumaLow!, channelHigh: channelHigh!, channelLow: channelLow!, chroma: chroma!, detail: detail! }
  }
  assert.ok(cell(0).lumaHigh > 0.98 && cell(0).detail < 0.01, 'white cell')
  assert.ok(cell(1).lumaHigh < 0.02 && cell(1).chroma < 0.01, 'black cell')
  const red = cell(2)
  assert.ok(Math.abs(red.lumaHigh - linearToSrgb(0.2126)) < 0.02 && red.chroma > 0.99, 'red cell')
  assert.ok(red.channelHigh === 1 && red.channelLow === 0, 'red spans the full channel range')
  assert.ok(cell(3).detail > 0.9 && cell(3).lumaHigh > 0.98 && cell(3).lumaLow < 0.02, 'striped cell')
  for (let c = 0; c < 4; c++) {
    const t = cell(c)
    assert.ok(t.channelHigh >= t.lumaHigh && t.channelLow <= t.lumaLow, 'channel extremes enclose luminance')
  }
})

test('asymmetric smoother attacks fast, holds across gaps, releases slowly, independent of dt', () => {
  const opts = { attackMs: 90, holdMs: 240, releaseMs: 700 }
  const s = createAsymmetricSmoother(1, opts)
  s.step([1], 270)
  assert.ok(s.values[0]! > 0.94, 'reaches ~95% within three attack constants')

  s.reset(1)
  s.step([0], 200)
  assert.equal(s.values[0], 1, 'a short gap inside the hold window changes nothing')
  s.step([1], 16)
  s.step([0], 200)
  assert.equal(s.values[0], 1, 'hold restarts whenever the target rises again')
  s.step([0], 40 + 700)
  assert.ok(s.values[0]! > 0.3 && s.values[0]! < 0.45, `one release constant after hold, got ${s.values[0]}`)

  const coarse = createAsymmetricSmoother(1, opts)
  const fine = createAsymmetricSmoother(1, opts)
  coarse.step([1], 120)
  for (let i = 0; i < 12; i++) fine.step([1], 10)
  assert.ok(Math.abs(coarse.values[0]! - fine.values[0]!) < 1e-5, 'attack is dt-independent')
  coarse.reset(1)
  fine.reset(1)
  coarse.step([0], 600)
  for (let i = 0; i < 60; i++) fine.step([0], 10)
  assert.ok(Math.abs(coarse.values[0]! - fine.values[0]!) < 1e-5, 'hold + release is dt-independent')

  const settle = createAsymmetricSmoother(2, opts)
  assert.equal(settle.step([0, 0], 16), true)
  assert.equal(settle.step([1, 0], 16), false)
  let settled = false
  for (let i = 0; i < 200 && !settled; i++) settled = settle.step([1, 0], 16)
  assert.ok(settled)
  assert.deepEqual(Array.from(settle.values), [1, 0], 'settled channels snap to target')
})
