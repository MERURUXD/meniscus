/**
 * Unit tests for @sessile/core geometric-optics 1D bezel refraction LUTs.
 * Verifies Snell's law agreement against traceBezelRay, ior=1 identity, anti-caustic fold
 * clamping, signed lip profile inversion, custom functions, and LRU caching.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BEZEL_HEIGHT_PROFILES,
  CAUSTIC_FOLD_LIMIT,
  DEFAULT_REFRACTION_SAMPLES,
  computeRefractionProfileLut,
  getRefractionProfileKey,
  resolveRefractionProfileLut,
  sampleRefractionLut,
  traceBezelRay,
} from '../src/refractProfile.ts'

test('refractProfile: Snell law LUT matches traceBezelRay across interior bezel for built-in and custom profiles', () => {
  const bezel = 20
  const thicknessRatio = 1.1
  const ior = 1.5

  for (const name of ['squircle', 'circle', 'parabolic', 'lip'] as const) {
    const lut = computeRefractionProfileLut({
      profile: name,
      ior,
      thicknessRatio,
      caustics: true,
    })
    assert.equal(lut.samples, DEFAULT_REFRACTION_SAMPLES)
    assert.ok(lut.maxDisplacementRatio > 0)

    for (const t of [0.2, 0.45, 0.7]) {
      const lutShiftPx = sampleRefractionLut(lut.displacementRatio, t) * bezel
      const ray = traceBezelRay(
        {
          bezel,
          thickness: bezel * thicknessRatio,
          ior,
          profile: name,
        },
        t * bezel,
      )
      assert.ok(
        Math.abs(lutShiftPx - ray.shift) < 0.05,
        `${name} at t=${t}: LUT shift ${lutShiftPx} should match ray ${ray.shift}`,
      )
    }
  }

  // Custom bezel height function must also compute valid Snell refraction and stable WeakMap keys.
  const customFn = (t: number) => Math.sin(t * Math.PI * 0.5)
  assert.equal(getRefractionProfileKey(customFn), getRefractionProfileKey(customFn))
  assert.notEqual(getRefractionProfileKey(customFn), getRefractionProfileKey((t) => t))

  const customLut = computeRefractionProfileLut({
    profile: customFn,
    ior: 1.6,
    thicknessRatio: 1.2,
    caustics: true,
  })
  const customRay = traceBezelRay(
    { bezel, thickness: bezel * 1.2, ior: 1.6, profile: customFn },
    0.5 * bezel,
  )
  assert.ok(Math.abs(sampleRefractionLut(customLut.displacementRatio, 0.5) * bezel - customRay.shift) < 0.05)
})

test('refractProfile: ior=1 produces zero displacement and lip profile inverts sign on inner slope', () => {
  const airLut = computeRefractionProfileLut({
    profile: 'squircle',
    ior: 1.0,
    thicknessRatio: 1.5,
  })
  assert.equal(airLut.maxDisplacementRatio, 0)
  for (let i = 0; i < airLut.samples; i++) {
    assert.equal(airLut.displacementRatio[i], 0)
    assert.equal(airLut.normalizedDisplacement[i], 0)
  }

  const lipLut = computeRefractionProfileLut({
    profile: 'lip',
    ior: 1.5,
    thicknessRatio: 1.35,
  })
  let maxPositive = 0
  let minNegative = 0
  for (let i = 0; i < lipLut.samples; i++) {
    const v = lipLut.displacementRatio[i]!
    if (v > maxPositive) maxPositive = v
    if (v < minNegative) minNegative = v
  }
  assert.ok(maxPositive > 0.1, `expected positive outer rim shift, got ${maxPositive}`)
  assert.ok(minNegative < -0.02, `expected negative inner magnification shift on lip, got ${minNegative}`)
  assert.ok(BEZEL_HEIGHT_PROFILES.lip(0.5) > BEZEL_HEIGHT_PROFILES.squircle(0.5))
})

test('refractProfile: anti-caustic fold clamping bounds outward slope while caustics=true preserves steep peaks', () => {
  const clamped = computeRefractionProfileLut({
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.5,
    caustics: false,
  })
  const raw = computeRefractionProfileLut({
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.5,
    caustics: true,
  })

  const step = 1 / (clamped.samples - 1)
  const limit = CAUSTIC_FOLD_LIMIT * step + 1e-6
  for (let i = 0; i < clamped.samples - 1; i++) {
    const diff = clamped.displacementRatio[i]! - clamped.displacementRatio[i + 1]!
    assert.ok(diff <= limit, `sample ${i} violates fold limit: diff=${diff} > ${limit}`)
  }
  // Rim boundary is held instead of dropping to 0 at z(0)=0 when caustics are off.
  assert.ok(clamped.displacementRatio[0]! >= clamped.displacementRatio[1]! - 1e-6)
  // Unclamped squircle has a steeper peak near the outer rim than the clamped curve.
  assert.ok(raw.maxDisplacementRatio > clamped.maxDisplacementRatio)
})

test('refractProfile: LRU resolver caches identical optical configs and defaults to squircle', () => {
  const defaultLut = resolveRefractionProfileLut()
  const explicitSquircle = resolveRefractionProfileLut({
    profile: 'squircle',
    ior: 1.5,
    thicknessRatio: 1.0,
    caustics: false,
  })
  assert.equal(defaultLut, explicitSquircle)
  assert.ok(defaultLut.maxDisplacementRatio > 0)

  const sqA = resolveRefractionProfileLut({ profile: 'squircle', ior: 1.5, thicknessRatio: 1.35, caustics: false })
  const sqB = resolveRefractionProfileLut({ profile: 'squircle', ior: 1.5, thicknessRatio: 1.35, caustics: false })
  const sqC = resolveRefractionProfileLut({ profile: 'squircle', ior: 1.8, thicknessRatio: 1.35, caustics: false })
  assert.equal(sqA, sqB)
  assert.notEqual(sqA, sqC)

  // Sample clamping outside [0, 1].
  assert.equal(sampleRefractionLut(sqA.displacementRatio, -0.5), sqA.displacementRatio[0])
  assert.equal(sampleRefractionLut(sqA.displacementRatio, 1.5), sqA.displacementRatio[sqA.samples - 1])
})
