/**
 * Adaptive backdrop legibility kernel.
 *
 * The host fixes the foreground (text color, polarity, target contrast); the glass yields.
 * Every quantity here is expressed in sRGB-encoded relative luminance ("encoded luminance"),
 * the domain browsers composite in, so veil-over-backdrop blending stays affine and WCAG
 * bounds convert exactly for neutrals.
 *
 * The per-pixel stage is a luminance-keyed multiplicative film evaluated by the Route B3 SVG
 * filter: `out = c * M(x)` for light text and `1 - out = (1 - c) * M(x)` for dark text. Scaling
 * all channels by one factor keeps hue and saturation (no signed chroma intermediates, no gamut
 * clipping) while absolute chroma converges exactly where luminance is compressed.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { BackdropVeilOptics } from './optics.ts'
import { clamp, lerp, smoothstep } from './physics.ts'

export type LegibilityTier = 'clear' | 'regular' | 'legible'
export type ForegroundPolarity = 'light' | 'dark'

/** Material response of one legibility tier. Gains and floors are reached at full risk. */
export interface LegibilityPolicy {
  /** WCAG 2 contrast ratio the foreground keeps against the composited glass. */
  contrast: number
  /**
   * Fraction of the safe limit where the soft knee starts bending at full luminance risk, in
   * `(0, LEGIBILITY_CALM_KNEE)`. A calm backdrop keeps a harder shoulder that spares mid-tones;
   * the ceiling itself always holds, because aggregate telemetry cannot see a small bright
   * patch (a speech balloon) that still sits under the text.
   */
  knee: number
  /** Uniform film alpha added on the veil at full risk. */
  filmMax: number
  /** Backdrop saturation multiplier at full chroma risk. */
  saturationFloor: number
  /** Extra backdrop blur in CSS px at full detail risk. */
  blurBoostPx: number
  /** Displacement-scale multiplier at full detail risk (never re-encodes the map). */
  refractionFloor: number
  /** Relative hairline and rim alpha gain at full risk. */
  edgeGain: number
  /** Relative outer-shadow alpha gain at full luminance risk. */
  shadowGain: number
  /** Risk assumed on every channel while no telemetry is available. */
  assumedRisk: number
}

export const LEGIBILITY_POLICIES = {
  clear: {
    contrast: 3,
    knee: 0.72,
    filmMax: 0.06,
    saturationFloor: 0.88,
    blurBoostPx: 1.5,
    refractionFloor: 0.85,
    edgeGain: 0.35,
    shadowGain: 0.4,
    assumedRisk: 0.3,
  },
  regular: {
    contrast: 4.5,
    knee: 0.7,
    filmMax: 0.14,
    saturationFloor: 0.72,
    blurBoostPx: 3,
    refractionFloor: 0.65,
    edgeGain: 0.6,
    shadowGain: 0.8,
    assumedRisk: 0.5,
  },
  legible: {
    contrast: 7,
    knee: 0.65,
    filmMax: 0.26,
    saturationFloor: 0.55,
    blurBoostPx: 6,
    refractionFloor: 0.4,
    edgeGain: 0.9,
    shadowGain: 1.2,
    assumedRisk: 0.8,
  },
} as const satisfies Record<LegibilityTier, LegibilityPolicy>

/**
 * Attack is fast so text never sits on an unsafe backdrop for more than a few frames; hold and
 * release bridge the calm gutters between cards so scrolling across a grid does not strobe.
 */
export const LEGIBILITY_SMOOTHING = {
  attackMs: 90,
  holdMs: 240,
  releaseMs: 700,
  // The final snap moves film alpha by at most `filmMax * epsilon` (~0.001), invisible, while
  // letting the frame loop sleep a couple of seconds earlier than a 1e-3 tail would.
  epsilon: 0.004,
} as const

/** Knee fraction used at zero luminance risk. */
export const LEGIBILITY_CALM_KNEE = 0.9

/** Samples in each per-pixel multiplier table (`feFunc* type="table"`). */
export const LEGIBILITY_TABLE_SIZE = 33

/**
 * Filter-graph contract for the per-pixel stage, keyed by polarity.
 * `k` are `feComposite operator="arithmetic"` coefficients with `in` = color, `in2` = multiplier.
 * Light text keys on true luminance (`linearRGB` matrix): sRGB luma underestimates saturated
 * colors (pure red has luma 0.21 but encoded luminance ~0.50) and would leave them unclamped.
 * Dark text keys on sRGB luma, which only ever underestimates, so the lift errs on the safe side
 * and avoids quantizing shadows in an 8-bit linear buffer.
 */
export const LEGIBILITY_STAGES = {
  light: { luminanceSpace: 'linearRGB', k: [1, 0, 0, 0] },
  dark: { luminanceSpace: 'sRGB', k: [1, 0, -1, 1] },
} as const satisfies Record<
  ForegroundPolarity,
  { luminanceSpace: 'linearRGB' | 'sRGB'; k: readonly [number, number, number, number] }
>

/**
 * Encoded-luminance headroom kept below the exact limit. Covers the residual error of
 * scaling in sRGB space (the transfer curve is not a pure power law), veil blending of colored
 * pixels, and 8-bit filter intermediates; sized by the reference-model sweep in the unit tests.
 */
export const LEGIBILITY_LIMIT_MARGIN = 0.008

export interface LegibilityTarget {
  /** Foreground text color as normalized sRGB `[r, g, b]` (a trailing alpha is ignored). */
  foreground: readonly number[]
  /** Tier preset (defaults to `'regular'`). */
  tier?: LegibilityTier
  /** Overrides the tier's WCAG contrast ratio. */
  contrast?: number
  /** Overrides the polarity inferred from the foreground luminance. */
  polarity?: ForegroundPolarity
}

export interface LegibilityGoal {
  readonly polarity: ForegroundPolarity
  readonly contrast: number
  readonly policy: LegibilityPolicy
  /** Encoded-luminance bound the composited glass must stay beyond (ceiling for light text, floor for dark). */
  readonly perceivedLimit: number
}

/**
 * Backdrop statistics under a glass region, in encoded luminance and sRGB channel units.
 * Hosts may inject these directly or let a probe aggregate them.
 */
export interface BackdropTelemetry {
  /** Bright-tail encoded luminance (about the 95th percentile). */
  lumaHigh: number
  /** Dark-tail encoded luminance (about the 5th percentile). */
  lumaLow: number
  /** Mean chroma (`max - min` of the sRGB channels). */
  chroma: number
  /** Mean absolute luminance gradient per pixel, scaled to roughly `[0, 1]` (dense text reads high). */
  detail: number
}

export interface LegibilityRisk {
  luma: number
  chroma: number
  detail: number
}

/** Telemetry floats per grid cell, ordered as `lumaHigh, lumaLow, chroma, detail`. */
export const TELEMETRY_STRIDE = 4

export interface BackdropTelemetryGrid {
  cols: number
  rows: number
  /** `cols * rows * TELEMETRY_STRIDE` floats, row-major. */
  data: Float32Array
}

/** Preallocated solver output; `resolveLegibilityParams` rewrites it in place. */
export interface LegibilityParams {
  polarity: ForegroundPolarity
  /** Per-pixel multiplier `M` sampled uniformly over the luminance index `[0, 1]`. */
  readonly table: Float32Array
  /** Increments whenever `table` changes beyond 8-bit precision, so consumers rewrite filter nodes only then. */
  tableRevision: number
  /** Veil tint with the uniform film composited over it, normalized RGBA. */
  readonly veilRgba: Float32Array
  blurBoostPx: number
  refractionScale: number
  saturationScale: number
  hairlineScale: number
  shadowScale: number
  /** Affine `out = scale * x + offset` on the encoded backdrop for paths without per-pixel filters. */
  fallbackScale: number
  fallbackOffset: number
  /** Encoded-luminance limit the backdrop is compressed toward after the film. */
  backdropLimit: number
  /** `false` when the veil tint alone already violates the goal. */
  feasible: boolean
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
}

/** WCAG 2 relative luminance of a normalized sRGB color. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2 contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return (hi + 0.05) / (lo + 0.05)
}

/** Resolves the host declaration into a polarity and an encoded-luminance limit. */
export function resolveLegibilityGoal(target: LegibilityTarget): LegibilityGoal {
  const policy = LEGIBILITY_POLICIES[target.tier ?? 'regular']
  const contrast =
    target.contrast !== undefined && Number.isFinite(target.contrast)
      ? Math.max(1, target.contrast)
      : policy.contrast
  const fg = target.foreground
  const lf = relativeLuminance(fg[0] ?? 0, fg[1] ?? 0, fg[2] ?? 0)
  const ceiling = (lf + 0.05) / contrast - 0.05
  const floor = contrast * (lf + 0.05) - 0.05
  const polarity = target.polarity ?? (ceiling >= 1 - floor ? 'light' : 'dark')
  const limit = polarity === 'light' ? ceiling : floor
  return {
    polarity,
    contrast,
    policy,
    perceivedLimit: linearToSrgb(clamp(limit, 0, 1)),
  }
}

/**
 * Converts the perceived limit into a limit on the backdrop under a veil of `veilRgba`,
 * expressed in "risk space" `u` (`u = x` for light text, `u = 1 - x` for dark) so both
 * polarities share one ceiling curve. Returns `>= 1` when no compression is needed and `<= 0`
 * when the veil alone violates the goal.
 */
function backdropCeiling(goal: LegibilityGoal, veilRgba: ArrayLike<number>): number {
  const a = clamp(veilRgba[3] ?? 0, 0, 1)
  const r = clamp(veilRgba[0] ?? 0, 0, 1)
  const g = clamp(veilRgba[1] ?? 0, 0, 1)
  const b = clamp(veilRgba[2] ?? 0, 0, 1)
  // Bound the veil by its extreme channel: blending happens per channel, so a saturated tint
  // over a complementary backdrop composites far darker (or brighter) than its luminance implies.
  const light = goal.polarity === 'light'
  const veil = light ? Math.max(r, g, b) : Math.min(r, g, b)
  const p = light
    ? goal.perceivedLimit - LEGIBILITY_LIMIT_MARGIN
    : goal.perceivedLimit + LEGIBILITY_LIMIT_MARGIN
  if (a >= 0.999) {
    const ok = light ? veil <= p : veil >= p
    return ok ? 1 : -1
  }
  const limit = (p - a * veil) / (1 - a)
  return light ? limit : 1 - limit
}

const IDENTITY_VEIL_OPTICS: BackdropVeilOptics = { brightness: 1, contrast: 1, contrastFirst: false }

function veilAffineScale(optics: BackdropVeilOptics): number {
  return Math.max(0, optics.brightness * optics.contrast)
}

function veilAffineOffset(optics: BackdropVeilOptics): number {
  return optics.contrastFirst
    ? 0.5 * optics.brightness * (1 - optics.contrast)
    : 0.5 * (1 - optics.contrast)
}

/**
 * Maps backdrop telemetry to `[0, 1]` risk per channel for the given goal and base veil.
 * Telemetry describes the raw page, but the glass shows it after the host's `optics`, and the
 * fallback correction is composed after those optics too. The affine is monotonic, so it maps
 * the luminance percentiles exactly and scales chroma and gradients by its slope.
 */
export function computeBackdropRisk(
  telemetry: BackdropTelemetry,
  goal: LegibilityGoal,
  veilRgba: ArrayLike<number>,
  out: LegibilityRisk,
  optics: BackdropVeilOptics = IDENTITY_VEIL_OPTICS,
): LegibilityRisk {
  const s = veilAffineScale(optics)
  const o = veilAffineOffset(optics)
  const ceiling = backdropCeiling(goal, veilRgba)
  const tail =
    goal.polarity === 'light'
      ? clamp(s * telemetry.lumaHigh + o, 0, 1)
      : 1 - clamp(s * telemetry.lumaLow + o, 0, 1)
  if (ceiling >= 1) {
    out.luma = 0
  } else {
    const knee = Math.max(0, ceiling) * goal.policy.knee
    out.luma = clamp((tail - knee) / Math.max(1e-6, 1 - knee), 0, 1)
  }
  out.chroma = smoothstep(0.12, 0.45, s * telemetry.chroma)
  out.detail = smoothstep(0.04, 0.22, s * telemetry.detail)
  return out
}

export function createLegibilityParams(): LegibilityParams {
  const table = new Float32Array(LEGIBILITY_TABLE_SIZE)
  table.fill(1)
  return {
    polarity: 'light',
    table,
    tableRevision: 0,
    veilRgba: new Float32Array(4),
    blurBoostPx: 0,
    refractionScale: 1,
    saturationScale: 1,
    hairlineScale: 1,
    shadowScale: 1,
    fallbackScale: 1,
    fallbackOffset: 0,
    backdropLimit: 1,
    feasible: true,
  }
}

/**
 * Soft-knee ceiling in risk space: identity below `knee`, then a rational shoulder whose slope is
 * continuous at the knee and which lands exactly on `ceiling` at `u = 1`, so the guarantee holds
 * for the brightest possible pixel without flattening mid-tones.
 */
function softCeiling(u: number, knee: number, ceiling: number): number {
  if (u <= knee) return u
  const s = (1 - knee) / (ceiling - knee)
  const t = (u - knee) / (1 - knee)
  return knee + (ceiling - knee) * ((s * t) / (1 + (s - 1) * t))
}

function multiplierAt(u: number, knee: number, ceiling: number): number {
  if (ceiling >= 1 || u <= knee) return 1
  return ceiling > 0 ? softCeiling(u, knee, ceiling) / u : 0
}

/**
 * Solves the material response for the smoothed `risk` and writes it into `out`.
 * Allocation-free; returns `true` when any output changed.
 */
export function resolveLegibilityParams(
  goal: LegibilityGoal,
  risk: LegibilityRisk,
  baseVeilRgba: ArrayLike<number>,
  out: LegibilityParams,
): boolean {
  const policy = goal.policy
  const light = goal.polarity === 'light'
  let changed = out.polarity !== goal.polarity
  out.polarity = goal.polarity

  // The film reuses the host tint's hue pushed toward the safe extreme; mixing toward a neutral
  // mid-gray is what makes compressed glass read as dirty.
  const filmAlpha = policy.filmMax * Math.max(risk.luma, 0.6 * risk.detail)
  const baseA = clamp(baseVeilRgba[3] ?? 0, 0, 1)
  const alpha = filmAlpha + baseA * (1 - filmAlpha)
  const veil = out.veilRgba
  for (let i = 0; i < 3; i++) {
    const tint = clamp(baseVeilRgba[i] ?? 0, 0, 1)
    const film = light ? tint * 0.15 : 1 - (1 - tint) * 0.15
    const v = alpha > 0 ? (filmAlpha * film + baseA * (1 - filmAlpha) * tint) / alpha : tint
    changed ||= Math.abs(veil[i]! - v) > 1e-4
    veil[i] = v
  }
  changed ||= Math.abs(veil[3]! - alpha) > 1e-4
  veil[3] = alpha

  const rawCeiling = backdropCeiling(goal, veil)
  out.feasible = rawCeiling > 0
  const ceiling = clamp(rawCeiling, 0, 1)
  out.backdropLimit = light ? ceiling : 1 - ceiling
  const knee = ceiling * lerp(LEGIBILITY_CALM_KNEE, policy.knee, risk.luma)

  // The table is only republished when some entry moves by half an 8-bit step, so a slowly
  // releasing smoother does not rewrite filter attributes every frame.
  const table = out.table
  const last = table.length - 1
  let tableChanged = false
  for (let i = 0; i <= last && !tableChanged; i++) {
    const u = light ? i / last : 1 - i / last
    tableChanged = Math.abs(table[i]! - multiplierAt(u, knee, ceiling)) > 0.5 / 255
  }
  if (tableChanged) {
    for (let i = 0; i <= last; i++) {
      table[i] = multiplierAt(light ? i / last : 1 - i / last, knee, ceiling)
    }
    out.tableRevision += 1
    changed = true
  }

  // Paths without a per-pixel filter can only scale the whole backdrop. The tail estimate
  // inverts `computeBackdropRisk`, so the affine follows the same smoothed signal.
  const baseCeiling = backdropCeiling(goal, baseVeilRgba)
  const baseKnee = clamp(baseCeiling, 0, 1) * policy.knee
  const tail = baseKnee + risk.luma * (1 - baseKnee)
  const scale = ceiling >= 1 || tail <= ceiling ? 1 : ceiling / tail
  const offset = light ? 0 : 1 - scale

  changed = assign(out, 'fallbackScale', scale) || changed
  changed = assign(out, 'fallbackOffset', offset) || changed
  changed = assign(out, 'blurBoostPx', policy.blurBoostPx * risk.detail) || changed
  changed = assign(out, 'refractionScale', lerp(1, policy.refractionFloor, risk.detail)) || changed
  changed = assign(out, 'saturationScale', lerp(1, policy.saturationFloor, risk.chroma)) || changed
  changed =
    assign(out, 'hairlineScale', 1 + policy.edgeGain * Math.max(risk.luma, risk.detail)) || changed
  changed = assign(out, 'shadowScale', 1 + policy.shadowGain * risk.luma) || changed
  return changed
}

type ScalarParam =
  | 'fallbackScale'
  | 'fallbackOffset'
  | 'blurBoostPx'
  | 'refractionScale'
  | 'saturationScale'
  | 'hairlineScale'
  | 'shadowScale'

function assign(out: LegibilityParams, key: ScalarParam, value: number): boolean {
  if (Math.abs(out[key] - value) <= 1e-4) return false
  out[key] = value
  return true
}

/**
 * Area-weighted telemetry accumulator. Tails use a quadratic mean so a small bright patch still
 * outweighs its area share, while the slope at small coverage stays bounded: a plain max (or a
 * high power mean) would jump the moment a sliver of a white card enters the glass rect, which
 * shows up as a material seam when primitives merge or scroll across card edges.
 */
export interface BackdropTelemetryAccumulator {
  readonly weight: number
  reset(): void
  add(telemetry: BackdropTelemetry, weight: number): void
  /** Adds one `TELEMETRY_STRIDE` record from a grid or flat buffer without allocating. */
  addRecord(data: ArrayLike<number>, offset: number, weight: number): void
  /** Writes the aggregate into `out`; returns `false` (leaving `out` untouched) when nothing was added. */
  resolve(out: BackdropTelemetry): boolean
}

export function createTelemetryAccumulator(): BackdropTelemetryAccumulator {
  let weight = 0
  let high = 0
  let low = 0
  let chroma = 0
  let detail = 0
  const push = (h: number, l: number, c: number, d: number, w: number): void => {
    if (!(w > 0)) return
    const hh = clamp(h, 0, 1)
    const ll = 1 - clamp(l, 0, 1)
    weight += w
    high += w * hh * hh
    low += w * ll * ll
    chroma += w * clamp(c, 0, 1)
    detail += w * clamp(d, 0, 1)
  }
  return {
    get weight() {
      return weight
    },
    reset() {
      weight = high = low = chroma = detail = 0
    },
    add(t, w) {
      push(t.lumaHigh, t.lumaLow, t.chroma, t.detail, w)
    },
    addRecord(data, offset, w) {
      push(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!, w)
    },
    resolve(out) {
      if (!(weight > 0)) return false
      out.lumaHigh = Math.sqrt(high / weight)
      out.lumaLow = 1 - Math.sqrt(low / weight)
      out.chroma = chroma / weight
      out.detail = detail / weight
      return true
    },
  }
}

const HISTOGRAM_BINS = 64

/**
 * Measures a `cols x rows` telemetry grid from straight (non-premultiplied) RGBA bytes.
 * Runs once per source image, never per frame; callers obtain pixels through normal
 * same-origin or CORS-approved channels only.
 */
export function measureTelemetryGrid(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  cols: number,
  rows: number,
): BackdropTelemetryGrid {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const gc = Math.max(1, Math.floor(cols))
  const gr = Math.max(1, Math.floor(rows))
  const data = new Float32Array(gc * gr * TELEMETRY_STRIDE)
  const lum = new Float32Array(w * h)
  const chromaPx = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = (rgba[i * 4] ?? 0) / 255
    const g = (rgba[i * 4 + 1] ?? 0) / 255
    const b = (rgba[i * 4 + 2] ?? 0) / 255
    lum[i] = linearToSrgb(relativeLuminance(r, g, b))
    chromaPx[i] = Math.max(r, g, b) - Math.min(r, g, b)
  }

  const hist = new Uint32Array(HISTOGRAM_BINS)
  for (let cy = 0; cy < gr; cy++) {
    const y0 = Math.floor((cy * h) / gr)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / gr))
    for (let cx = 0; cx < gc; cx++) {
      const x0 = Math.floor((cx * w) / gc)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / gc))
      hist.fill(0)
      let count = 0
      let chroma = 0
      let gradient = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x
          const l = lum[i]!
          hist[Math.min(HISTOGRAM_BINS - 1, Math.floor(l * HISTOGRAM_BINS))]! += 1
          chroma += chromaPx[i]!
          // Gradients stay inside the cell so a card edge on a cell border is not counted as detail.
          const right = x + 1 < x1 ? lum[i + 1]! : l
          const down = y + 1 < y1 ? lum[i + w]! : l
          gradient += Math.abs(right - l) + Math.abs(down - l)
          count += 1
        }
      }
      const o = (cy * gc + cx) * TELEMETRY_STRIDE
      data[o] = percentileFromHistogram(hist, count, 0.95)
      data[o + 1] = percentileFromHistogram(hist, count, 0.05)
      data[o + 2] = chroma / count
      data[o + 3] = Math.min(1, (gradient / count) * 4)
    }
  }
  return { cols: gc, rows: gr, data }
}

function percentileFromHistogram(hist: Uint32Array, count: number, q: number): number {
  const target = q * count
  let acc = 0
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!
    if (acc >= target) return (i + 0.5) / hist.length
  }
  return 1
}

export interface AsymmetricSmootherOptions {
  attackMs: number
  /** Time a falling target must persist before release starts (defaults to `0`). */
  holdMs?: number
  releaseMs: number
  /** Distance under which a channel snaps to its target and counts as settled (defaults to `1e-3`). */
  epsilon?: number
}

/**
 * Frame-rate independent attack/hold/release smoother over a fixed channel count.
 * Rising targets follow `attackMs`; falling targets wait `holdMs`, then follow `releaseMs`.
 */
export interface AsymmetricSmoother {
  readonly values: Float32Array
  /** Advances by `dtMs` toward `target`; returns `true` once every channel has settled. */
  step(target: ArrayLike<number>, dtMs: number): boolean
  reset(values: ArrayLike<number> | number): void
}

export function createAsymmetricSmoother(
  channels: number,
  options: AsymmetricSmootherOptions,
): AsymmetricSmoother {
  const values = new Float32Array(channels)
  const holdLeft = new Float32Array(channels)
  const holdMs = Math.max(0, options.holdMs ?? 0)
  const attackMs = Math.max(1e-3, options.attackMs)
  const releaseMs = Math.max(1e-3, options.releaseMs)
  const epsilon = Math.max(0, options.epsilon ?? 1e-3)
  holdLeft.fill(holdMs)

  return {
    values,
    step(target, dtMs) {
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0
      let settled = true
      for (let i = 0; i < channels; i++) {
        const goal = target[i] ?? 0
        let v = values[i]!
        if (goal >= v - epsilon) {
          holdLeft[i] = holdMs
          if (goal > v) v += (goal - v) * (1 - Math.exp(-dt / attackMs))
        } else {
          const releaseDt = Math.max(0, dt - holdLeft[i]!)
          holdLeft[i] = Math.max(0, holdLeft[i]! - dt)
          v += (goal - v) * (1 - Math.exp(-releaseDt / releaseMs))
        }
        if (Math.abs(goal - v) <= epsilon) {
          v = goal
        } else {
          settled = false
        }
        values[i] = v
      }
      return settled
    },
    reset(next) {
      for (let i = 0; i < channels; i++) {
        values[i] = typeof next === 'number' ? next : (next[i] ?? 0)
      }
      holdLeft.fill(holdMs)
    },
  }
}

const VEIL_FACTOR_EPS = 1e-4

/**
 * Composes the fallback affine (`scale * x + offset`) after the base `brightness`/`contrast`
 * veil optics, re-expressed as one brightness/contrast pair so the CSS `backdrop-filter` path
 * keeps a single token of each. CSS rejects negative coefficients, and each order can express
 * only part of the affine plane (contrast-first needs `s + 2o > 0`, brightness-first needs
 * `o < 0.5`), so the base's order is kept when representable and the other is used otherwise.
 */
export function composeVeilAffine(
  base: BackdropVeilOptics,
  scale: number,
  offset: number,
): BackdropVeilOptics {
  const s = Math.max(0, scale * veilAffineScale(base))
  const o = scale * veilAffineOffset(base) + offset
  // contrast-first: x -> b * (c * x + 0.5 * (1 - c)), so b = s + 2o and c = s / b.
  const contrastFirstB = s + 2 * o
  // brightness-first: x -> c * (b * x) + 0.5 * (1 - c), so c = 1 - 2o and b = s / c.
  const brightnessFirstC = 1 - 2 * o
  const canContrastFirst = contrastFirstB > VEIL_FACTOR_EPS
  const canBrightnessFirst = brightnessFirstC > VEIL_FACTOR_EPS
  if (canBrightnessFirst && (!base.contrastFirst || !canContrastFirst)) {
    return { brightness: s / brightnessFirstC, contrast: brightnessFirstC, contrastFirst: false }
  }
  // With s >= 0 at least one order is representable; the clamp only guards non-finite input.
  const brightness = Math.max(VEIL_FACTOR_EPS, contrastFirstB)
  return { brightness, contrast: s / brightness, contrastFirst: true }
}
