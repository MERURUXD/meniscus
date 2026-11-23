/**
 * @meniscus/core unit tests for CSS optics parsing and OpticalMaterial interpolation.
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

test('parseCssFilterOptics and interpolateVeilOptics preserve filter order and products', () => {
  const a = parseCssFilterOptics('blur(12px) saturate(1.75) brightness(1.1) contrast(0.94) url("#lens")')
  approx(a.brightness, 1.1, 1e-4)
  approx(a.contrast, 0.94, 1e-4)
  assert.equal(a.contrastFirst, false)

  const b = parseCssFilterOptics('blur(3px) contrast(0.8) brightness(1.2) contrast(1.1)')
  approx(b.brightness, 1.2, 1e-4)
  approx(b.contrast, 0.88, 1e-4)
  assert.equal(b.contrastFirst, true)

  const mid = interpolateVeilOptics(a, b, 0.5)
  approx(mid.brightness, 1.15, 1e-4)
  approx(mid.contrast, 0.91, 1e-4)
  assert.equal(mid.contrastFirst, true)
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
