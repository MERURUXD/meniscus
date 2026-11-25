/**
 * @sessile/core unit tests for CSS optics parsing and OpticalMaterial interpolation.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_OPTICAL_MATERIALS, type OpticalMaterial } from '../src/contracts.ts'
import {
  buildCircularBevelTable,
  buildColorOpticsMatrix,
  buildContourAlphaDataUrl,
  interpolateCssGlassSurfaceToMaterial,
  interpolateOpticalMaterial,
  interpolateVeilOptics,
  parseCssBoxShadow,
  parseCssFilterOptics,
  parseCssGlassSurface,
  parseCssRgba,
  tryParseCssRgba,
  resolveOpticalMaterial,
} from '../src/optics.ts'

function approx(actual: number, expected: number, eps = 1e-4, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label ? `${label}: ` : ''}expected ${actual} ≈ ${expected} (±${eps})`,
  )
}

test('buildCircularBevelTable is antisymmetric, monotonic, and Sobel-calibrated', () => {
  const b20 = buildCircularBevelTable(20, 8.5)
  const vals = b20.tableValues.split(' ').map(Number)
  assert.equal(vals.length, 21)
  approx(vals[0], 0, 1e-4, 'bevel table start')
  approx(vals[10], 0.5, 1e-3, 'bevel table midpoint')
  approx(vals[20], 1, 1e-4, 'bevel table end')
  for (let i = 1; i < vals.length; i += 1) {
    assert.ok(vals[i] >= vals[i - 1], `bevel table must be monotonic at ${i}`)
    approx(vals[i] + vals[20 - i], 1, 1e-3, `antisymmetry at ${i}`)
  }
  assert.ok(b20.divisor > 1.0 && b20.divisor < 2.0)
  approx(b20.peakSobelEffective / b20.divisor, 0.48, 0.02)
})

test('buildColorOpticsMatrix handles identity and contrastFirst offset differences', () => {
  const identity = buildColorOpticsMatrix(1, 1, 1).trim().split(/\s+/).map(Number)
  assert.equal(identity.length, 20)
  approx(identity[0], 1, 1e-4)
  approx(identity[6], 1, 1e-4)
  approx(identity[12], 1, 1e-4)
  approx(identity[18], 1, 1e-4)
  approx(identity[4], 0, 1e-4)

  const brightnessFirst = buildColorOpticsMatrix(1.2, 1.5, 0.8, false).trim().split(/\s+/).map(Number)
  const contrastFirst = buildColorOpticsMatrix(1.2, 1.5, 0.8, true).trim().split(/\s+/).map(Number)
  // contrastFirst=false -> offset = 0.5*(1-0.8) = 0.1; contrastFirst=true -> offset = 1.5*0.1 = 0.15.
  approx(brightnessFirst[4], 0.1, 1e-4)
  approx(contrastFirst[4], 0.15, 1e-4)
  approx(brightnessFirst[0], contrastFirst[0], 1e-4)
})

test('buildContourAlphaDataUrl encodes a valid SVG Data URL', () => {
  const url = buildContourAlphaDataUrl('M0 0 L10 0 Z', 120.4, 80.2)
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'))
  const decoded = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length))
  assert.ok(decoded.includes('viewBox="0 0 120 80"') && decoded.includes('fill="white"'))
})

test('parseCssRgba supports rgb, rgba, space-slash syntax, color(srgb), and keywords', () => {
  assert.deepEqual(parseCssRgba('transparent'), [0, 0, 0, 0])
  assert.deepEqual(parseCssRgba('none'), [0, 0, 0, 0])
  assert.deepEqual(parseCssRgba('rgba(255, 255, 255, 0.5)'), [1, 1, 1, 0.5])
  assert.deepEqual(parseCssRgba('rgb(255 0 127.5 / 50%)'), [1, 0, 0.5, 0.5])
  assert.deepEqual(parseCssRgba('color(srgb 0.25 0.5 0.75 / 0.8)'), [0.25, 0.5, 0.75, 0.8])
  assert.deepEqual(parseCssRgba('color(srgb 1 0 0)'), [1, 0, 0, 1])
})

test('tryParseCssRgba converts computed oklab() and oklch() to sRGB', () => {
  const near = (actual: number[] | null, expected: number[]) => {
    assert.ok(actual, 'parsed')
    expected.forEach((v, i) => approx(actual![i]!, v, 1 / 255))
  }
  // Chromium's computed value for Tailwind `text-[#f4f4f5]/90`.
  near(tryParseCssRgba('oklab(0.967428 0.000417888 -0.00125271 / 0.9)'), [244 / 255, 244 / 255, 245 / 255, 0.9])
  near(tryParseCssRgba('oklch(0.627955 0.257683 29.2339)'), [1, 0, 0, 1])
  near(tryParseCssRgba('oklab(100% 0 0 / 50%)'), [1, 1, 1, 0.5])
  near(tryParseCssRgba('oklch(0 none none)'), [0, 0, 0, 1])
  // Out-of-gamut channels clip instead of leaving [0, 1].
  const vivid = tryParseCssRgba('oklch(0.9 0.4 145)')!
  assert.ok(vivid.every((v) => v >= 0 && v <= 1))
})

test('parseCssFilterOptics and interpolateVeilOptics preserve exact 1D affine transforms', () => {
  const a = parseCssFilterOptics('blur(12px) saturate(1.75) brightness(1.1) contrast(0.94) url("#lens")')
  approx(a.brightness, 1.1, 1e-4)
  approx(a.contrast, 0.94, 1e-4)
  assert.equal(a.contrastFirst, false)

  // brightness(2) contrast(0.5) brightness(0.5) => 0.5 * x + 0.125
  const interleaved = parseCssFilterOptics('brightness(2) contrast(0.5) brightness(0.5)')
  assert.equal(interleaved.contrastFirst, true)
  approx(interleaved.brightness, 0.75, 1e-4)
  approx(interleaved.contrast, 2 / 3, 1e-4)
  const interleavedMat = buildColorOpticsMatrix(
    1,
    interleaved.brightness,
    interleaved.contrast,
    interleaved.contrastFirst,
  )
    .trim()
    .split(/\s+/)
    .map(Number)
  approx(interleavedMat[0], 0.5, 1e-4, 'interleaved rr')
  approx(interleavedMat[4], 0.125, 1e-4, 'interleaved offset')

  // contrast(0.8) brightness(1.2) contrast(1.1) => 1.056 * x + 0.082
  const b = parseCssFilterOptics('blur(3px) contrast(0.8) brightness(1.2) contrast(1.1)')
  assert.equal(b.contrastFirst, true)
  approx(b.brightness, 1.22, 1e-4)
  approx(b.contrast, 1.056 / 1.22, 1e-4)
  const bMat = buildColorOpticsMatrix(1, b.brightness, b.contrast, b.contrastFirst)
    .trim()
    .split(/\s+/)
    .map(Number)
  approx(bMat[0], 1.056, 1e-4, 'b rr')
  approx(bMat[4], 0.082, 1e-4, 'b offset')

  // Interpolating across opposite contrastFirst endpoints yields linear (scale, offset).
  const aScale = a.brightness * a.contrast
  const aOffset = 0.5 * (1 - a.contrast)
  const bScale = 1.056
  const bOffset = 0.082
  const mid = interpolateVeilOptics(a, b, 0.5)
  const midMat = buildColorOpticsMatrix(1, mid.brightness, mid.contrast, mid.contrastFirst)
    .trim()
    .split(/\s+/)
    .map(Number)
  approx(midMat[0], (aScale + bScale) * 0.5, 1e-4, 'mid affine scale')
  approx(midMat[4], (aOffset + bOffset) * 0.5, 1e-4, 'mid affine offset')
})

test('parseCssBoxShadow parses multi-layer shadows and inset flags', () => {
  const layers = parseCssBoxShadow(
    'rgba(255, 255, 255, 0.34) 0px 1.5px 3px -0.5px inset, inset 0px -1px 2px -0.5px rgba(255, 255, 255, 0.16), rgba(0, 0, 0, 0.34) 0px 0px 0px 0.5px, 0px 24px 60px 0px rgba(0, 0, 0, 0.45)',
  )
  assert.equal(layers.length, 4)
  assert.equal(layers[0].inset, true)
  assert.equal(layers[1].inset, true)
  assert.equal(layers[2].inset, false)
  assert.equal(layers[2].spread, 0.5)
  assert.equal(layers[3].blur, 60)
  assert.equal(layers[3].offsetY, 24)
})

test('parseCssGlassSurface and interpolateCssGlassSurfaceToMaterial map standard CSS accurately', () => {
  const surface = parseCssGlassSurface({
    backdropFilter: 'blur(12px) saturate(1.75) brightness(1.1) contrast(0.94)',
    borderWidthPx: 1,
    borderColor: 'rgba(255, 255, 255, 0.32)',
    boxShadow:
      'rgba(255, 255, 255, 0.34) 0px 1.5px 3px -0.5px inset, rgba(255, 255, 255, 0.16) 0px -1px 2px -0.5px inset, rgba(0, 0, 0, 0.34) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.45) 0px 24px 60px 0px',
  })

  const mat = interpolateCssGlassSurfaceToMaterial(
    DEFAULT_OPTICAL_MATERIALS.dark.frosted,
    surface,
    surface,
    1,
  )
  assert.equal(mat.borderWidth, 1)
  assert.deepEqual(mat.borderRgba, [1, 1, 1, 0.32])
  approx(mat.hairlineWidth, 0.5, 1e-4)
  approx(mat.hairlineSideAlpha, 0.34, 1e-4)
  approx(mat.shadowBlur, 60, 1e-4)
  approx(mat.shadowOffsetY, 24, 1e-4)
  approx(mat.shadowAlpha, 0.45, 1e-4)
  assert.ok(mat.rimOpacity > 0.2 && mat.rimOpacity < 0.3)

  const thick = parseCssGlassSurface({
    backdropFilter: 'none',
    borderWidthPx: 4,
    borderColor: 'rgba(255, 255, 255, 0.5)',
    boxShadow: 'none',
  })
  const thin = parseCssGlassSurface({
    backdropFilter: 'none',
    borderWidthPx: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
    boxShadow: 'none',
  })
  assert.equal(
    interpolateCssGlassSurfaceToMaterial(DEFAULT_OPTICAL_MATERIALS.dark.crisp, thick, thin, 0).borderWidth,
    4,
  )
  assert.equal(
    interpolateCssGlassSurfaceToMaterial(DEFAULT_OPTICAL_MATERIALS.dark.crisp, thick, thin, 0.5).borderWidth,
    2.5,
  )
  assert.equal(
    interpolateCssGlassSurfaceToMaterial(DEFAULT_OPTICAL_MATERIALS.dark.crisp, thick, thin, 1).borderWidth,
    1,
  )
})

test('interpolateOpticalMaterial and resolveOpticalMaterial interpolate across presets and optional fields', () => {
  const crispLight = resolveOpticalMaterial('light', 0)
  const frostedLight = resolveOpticalMaterial('light', 1)
  const midLight = resolveOpticalMaterial('light', 0.5)

  assert.equal(crispLight.blur, DEFAULT_OPTICAL_MATERIALS.light.crisp.blur)
  assert.equal(frostedLight.blur, DEFAULT_OPTICAL_MATERIALS.light.frosted.blur)
  approx(midLight.blur, (crispLight.blur + frostedLight.blur) / 2, 1e-6)
  assert.equal(midLight.rimMode, 'soft')

  const customFrom: OpticalMaterial = {
    ...DEFAULT_OPTICAL_MATERIALS.dark.crisp,
    borderWidth: 1,
    borderRgba: [1, 1, 1, 0.2],
    rimBottomRatio: 0.4,
  }
  const customTo: OpticalMaterial = {
    ...DEFAULT_OPTICAL_MATERIALS.dark.frosted,
  }
  const midCustom = interpolateOpticalMaterial(customFrom, customTo, 0.5)
  approx(midCustom.borderWidth ?? -1, 0.5, 1e-6)
  approx(midCustom.borderRgba?.[3] ?? -1, 0.1, 1e-6)
  approx(midCustom.rimBottomRatio ?? -1, (0.4 + 0.72) / 2, 1e-6)
})
