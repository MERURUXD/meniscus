/**
 * Geometric-optics 1D bezel refraction profile LUT (Snell's law + anti-caustic fold clamping).
 *
 * Precomputes 256-sample `Float32Array` lookup tables for named bezel cross-sections
 * (`squircle`, `circle`, `parabolic`, `lip`) or custom height functions, allowing per-pixel
 * displacement map rasterizers to evaluate physical ray refraction via cheap linear
 * interpolation with zero runtime dependencies or per-frame GC churn.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

export type RefractionProfileName = 'squircle' | 'circle' | 'parabolic' | 'lip'

export type BezelHeightProfileName = RefractionProfileName

/** Normalized bezel height function `f(t)` in `[0, 1]` from outer edge (`t=0`) to plateau (`t=1`). */
export type BezelHeightFn = (t: number) => number

export type RefractionProfileSpec = RefractionProfileName | BezelHeightFn

export interface RefractionProfileOptions {
  /** Cross-section profile name or custom height function (defaults to `'squircle'`). */
  profile?: RefractionProfileSpec
  /** Index of refraction (`1` = air, `1.5` = glass; defaults to `1.5`). */
  ior?: number
  /** Glass plateau thickness divided by bezel width (`thickness / bezel`; defaults to `1`). */
  thicknessRatio?: number
  /** Allow steep-edge caustic folds instead of clamping to a one-to-one mapping. */
  caustics?: boolean
  /** LUT sample count across `[0, 1]` (defaults to `256`). */
  samples?: number
}

export interface RefractionProfileLut {
  /** Signed inward displacement ratio (`shift / bezel`) across `[0, 1]`. */
  displacementRatio: Float32Array
  /** Normalized displacement (`displacementRatio / maxDisplacementRatio`) in `[-1, 1]`. */
  normalizedDisplacement: Float32Array
  /** Dimensionless surface slope `d(z / bezel) / d(d / bezel)`. */
  slope: Float32Array
  /** Normalized surface height `z / bezel`. */
  height: Float32Array
  /** Peak absolute `displacementRatio` across the bezel. */
  maxDisplacementRatio: number
  samples: number
}

export interface BezelRayTraceInput {
  bezel: number
  thickness: number
  ior?: number
  profile?: BezelHeightProfileName | BezelHeightFn
}

export interface BezelRayTrace {
  /** Surface tilt incidence angle from vertical, in radians. */
  incidence: number
  /** Refracted angle from surface normal inside the glass, in radians. */
  refraction: number
  /** Ray angular deviation from vertical (`incidence - refraction`), in radians. */
  deviation: number
  /** Surface height above the page, in CSS px. */
  height: number
  /** Local surface slope `dz / dd`. */
  slope: number
  /** Inward horizontal displacement where the refracted ray lands, in CSS px. */
  shift: number
}

export const DEFAULT_REFRACTION_SAMPLES = 256
export const DEFAULT_REFRACTION_IOR = 1.5
/** Maximum inward displacement decrease per px (`-d(shift)/du < 1`) to keep mapping injective. */
export const CAUSTIC_FOLD_LIMIT = 0.85
/** Lower bound on blended SDF gradient norm in `smin` necks to avoid 180-degree saddle flips. */
export const NORMAL_FLOOR = 0.25

const MAX_LUT_CACHE_ENTRIES = 64

const squircleHeight: BezelHeightFn = (t) =>
  Math.pow(Math.max(0, 1 - Math.pow(Math.max(0, 1 - t), 4)), 0.25)

/** Built-in physical bezel cross-section height functions (`t = 0` outer rim, `t = 1` plateau). */
export const BEZEL_HEIGHT_PROFILES: Readonly<Record<BezelHeightProfileName, BezelHeightFn>> = {
  squircle: squircleHeight,
  circle: (t) => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))),
  parabolic: (t) => 1 - (1 - t) * (1 - t),
  lip: (t) => squircleHeight(t) + 0.14 * Math.pow(Math.sin(Math.PI * t), 2),
}

const customProfileIds = new WeakMap<BezelHeightFn, number>()
let nextCustomProfileId = 0

/** Returns a stable cache key fragment for a named profile or custom `BezelHeightFn`. */
export function getRefractionProfileKey(profile?: RefractionProfileSpec): string {
  if (profile === undefined) return 'squircle'
  if (typeof profile !== 'function') return profile
  let id = customProfileIds.get(profile)
  if (id === undefined) {
    id = nextCustomProfileId++
    customProfileIds.set(profile, id)
  }
  return `fn${id}`
}

function clamp11(v: number): number {
  return v <= -1 ? -1 : v >= 1 ? 1 : v
}

/**
 * Computes a 1D bezel refraction LUT via geometric-optics Snell ray tracing
 * (`sin(alpha) = n * sin(thetaT)`, `shift = z * tan(alpha - thetaT)`).
 */
export function computeRefractionProfileLut(
  options?: RefractionProfileOptions,
): RefractionProfileLut {
  const rawSamples = options?.samples ?? DEFAULT_REFRACTION_SAMPLES
  const samples = Math.max(
    2,
    Math.floor(Number.isFinite(rawSamples) ? rawSamples : DEFAULT_REFRACTION_SAMPLES),
  )

  const displacementRatio = new Float32Array(samples)
  const normalizedDisplacement = new Float32Array(samples)
  const slope = new Float32Array(samples)
  const height = new Float32Array(samples)
  const step = 1 / (samples - 1)

  const profile = options?.profile ?? 'squircle'
  const fn =
    typeof profile === 'function'
      ? profile
      : (BEZEL_HEIGHT_PROFILES[profile] ?? BEZEL_HEIGHT_PROFILES.squircle)
  const rawIor = options?.ior
  const safeIor = Math.max(
    1,
    rawIor !== undefined && Number.isFinite(rawIor) ? rawIor : DEFAULT_REFRACTION_IOR,
  )
  const rawRatio = options?.thicknessRatio
  const safeRatio = Math.max(
    0,
    rawRatio !== undefined && Number.isFinite(rawRatio) ? rawRatio : 1.0,
  )
  const half = step * 0.5

  for (let i = 0; i < samples; i++) {
    const t = i * step
    const t0 = Math.max(0, t - half)
    const t1 = Math.min(1, t + half)
    const z = safeRatio * fn(t)
    const dzdd = (safeRatio * (fn(t1) - fn(t0))) / (t1 - t0)
    height[i] = z
    slope[i] = dzdd
    if (safeIor <= 1 + 1e-6 || safeRatio <= 0) {
      displacementRatio[i] = 0
      continue
    }
    const alpha = Math.atan(dzdd)
    const thetaT = Math.asin(clamp11(Math.sin(alpha) / safeIor))
    displacementRatio[i] = z * Math.tan(alpha - thetaT)
  }

  // Enforce d(u + shift(u))/du > 0 when caustics are off so steep rims compress cleanly
  // instead of folding the backdrop twice across neighboring pixels.
  if (!options?.caustics) {
    const limit = CAUSTIC_FOLD_LIMIT * step
    for (let i = samples - 2; i >= 0; i--) {
      const cap = displacementRatio[i + 1]! + limit
      if (displacementRatio[i]! > cap) {
        displacementRatio[i] = cap
      }
    }
    // Hold the first interior sample at the outline so z(0)=0 does not leave a 1px unrefracted hairline.
    if (displacementRatio[1]! > displacementRatio[0]!) {
      displacementRatio[0] = displacementRatio[1]!
    }
  }

  let maxDisplacementRatio = 0
  for (let i = 0; i < samples; i++) {
    const absVal = Math.abs(displacementRatio[i]!)
    if (absVal > maxDisplacementRatio) {
      maxDisplacementRatio = absVal
    }
  }

  const invMax = maxDisplacementRatio > 1e-6 ? 1 / maxDisplacementRatio : 0
  for (let i = 0; i < samples; i++) {
    normalizedDisplacement[i] = displacementRatio[i]! * invMax
  }

  return {
    displacementRatio,
    normalizedDisplacement,
    slope,
    height,
    maxDisplacementRatio,
    samples,
  }
}

const lutCache = new Map<string, RefractionProfileLut>()

/**
 * Resolves a cached 1D refraction LUT using quantized optical keys so steady-state
 * 60/120fps frames reuse `Float32Array` tables with zero allocations.
 */
export function resolveRefractionProfileLut(
  options?: RefractionProfileOptions,
): RefractionProfileLut {
  const profileKey = getRefractionProfileKey(options?.profile)
  const samples = Math.max(
    2,
    Math.floor(
      options?.samples !== undefined && Number.isFinite(options.samples)
        ? options.samples
        : DEFAULT_REFRACTION_SAMPLES,
    ),
  )

  const rawIor = options?.ior
  const safeIor = Math.max(
    1,
    rawIor !== undefined && Number.isFinite(rawIor) ? rawIor : DEFAULT_REFRACTION_IOR,
  )
  const rawRatio = options?.thicknessRatio
  const safeRatio = Math.max(
    0,
    rawRatio !== undefined && Number.isFinite(rawRatio) ? rawRatio : 1.0,
  )
  const causticsBit = options?.caustics ? 1 : 0
  const cacheKey = `${profileKey}|${Math.round(safeIor * 1000)}|${Math.round(safeRatio * 1000)}|${causticsBit}|${samples}`

  const hit = lutCache.get(cacheKey)
  if (hit !== undefined) {
    lutCache.delete(cacheKey)
    lutCache.set(cacheKey, hit)
    return hit
  }

  const lut = computeRefractionProfileLut(options)
  lutCache.set(cacheKey, lut)
  if (lutCache.size > MAX_LUT_CACHE_ENTRIES) {
    const oldest = lutCache.keys().next().value
    if (oldest !== undefined) {
      lutCache.delete(oldest)
    }
  }
  return lut
}

/** Linearly interpolates a 1D refraction LUT at normalized bezel coordinate `t` in `[0, 1]`. */
export function sampleRefractionLut(table: Float32Array, t: number): number {
  const n = table.length
  if (n === 0) return 0
  if (t <= 0) return table[0]!
  if (t >= 1) return table[n - 1]!
  const x = t * (n - 1)
  const i = Math.floor(x)
  const frac = x - i
  const a = table[i]!
  const b = table[Math.min(n - 1, i + 1)]!
  return a + (b - a) * frac
}

/** Traces a vertical view ray through the bezel at `d` px inward from the outline. */
export function traceBezelRay(input: BezelRayTraceInput, d: number): BezelRayTrace {
  const bezel = Math.max(1e-6, input.bezel)
  const thickness = Math.max(0, input.thickness)
  const ior = Math.max(1, input.ior ?? DEFAULT_REFRACTION_IOR)
  const fn =
    typeof input.profile === 'function'
      ? input.profile
      : (BEZEL_HEIGHT_PROFILES[input.profile ?? 'squircle'] ?? BEZEL_HEIGHT_PROFILES.squircle)
  const t = Math.min(1, Math.max(0, d / bezel))
  const h = 1e-4
  const t0 = Math.max(0, t - h)
  const t1 = Math.min(1, t + h)
  const height = thickness * fn(t)
  const slope = (thickness * (fn(t1) - fn(t0))) / (t1 - t0) / bezel
  const incidence = Math.atan(slope)
  const refraction = ior <= 1 + 1e-6 ? incidence : Math.asin(clamp11(Math.sin(incidence) / ior))
  const deviation = incidence - refraction
  return {
    incidence,
    refraction,
    deviation,
    height,
    slope,
    shift: ior <= 1 + 1e-6 || thickness <= 0 ? 0 : height * Math.tan(deviation),
  }
}
