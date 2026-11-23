/**
 * Unit tests for pure standard CSS optical surface extraction, theme resolution,
 * and OpticalMaterial mapping without private custom properties.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_OPTICAL_MATERIALS } from '@meniscus/core'
import {
  buildBackdropFilterCss,
  buildMaterialFromCssSurface,
  formatOpaqueSolidCss,
  formatRgbaCss,
  parseCssBackdropBlur,
  parseCssBackdropSaturate,
  readElementGlassSurface,
  resolveElementTheme,
} from '../src/cssSurface.ts'
import { MockDocument, createMockMediaQueryList, type MockElement } from './mockDom.ts'

test('resolveElementTheme follows scoped data-theme, colorScheme, prefers-color-scheme, and fallback', () => {
  const doc = new MockDocument()
  const parent = doc.createElement('div')
  const child = doc.createElement('div')
  ;(parent as unknown as MockElement).appendChild(child as unknown as MockElement)
  doc.body.appendChild(parent as unknown as MockElement)

  parent.setAttribute('data-theme', 'light')
  assert.equal(resolveElementTheme(child), 'light')

  parent.setAttribute('data-theme', 'dark')
  assert.equal(resolveElementTheme(child), 'dark')

  parent.removeAttribute('data-theme')
  const lightSchemeStyle = { colorScheme: 'light' } as CSSStyleDeclaration
  assert.equal(
    resolveElementTheme(child, { getComputedStyle: () => lightSchemeStyle }),
    'light',
  )

  const neutralScheme = { colorScheme: 'light dark' } as CSSStyleDeclaration
  const lightMql = createMockMediaQueryList(true)
  assert.equal(
    resolveElementTheme(child, {
      getComputedStyle: () => neutralScheme,
      matchMedia: () => lightMql.mediaQueryList,
      fallbackTheme: 'dark',
    }),
    'light',
  )

  assert.equal(
    resolveElementTheme(child, {
      getComputedStyle: () => neutralScheme,
      matchMedia: null,
      fallbackTheme: 'light',
    }),
    'light',
  )
})

test('parseCssBackdropBlur and parseCssBackdropSaturate parse standard CSS filter strings', () => {
  assert.equal(parseCssBackdropBlur('none'), null)
  assert.equal(parseCssBackdropBlur('blur(0)'), 0)
  assert.equal(parseCssBackdropBlur('blur(14.5px) saturate(1.8)'), 14.5)
  assert.equal(parseCssBackdropBlur('blur(2rem)'), null)

  assert.equal(parseCssBackdropSaturate('none'), null)
  assert.equal(parseCssBackdropSaturate('blur(10px)'), null)
  assert.equal(parseCssBackdropSaturate('saturate(1.75)'), 1.75)
  assert.equal(parseCssBackdropSaturate('saturate(180%) saturate(0.5)'), 0.9)
})

test('readElementGlassSurface extracts standard CSS optics and restores morph attributes on error', () => {
  const doc = new MockDocument()
  const el = doc.createElement('div')
  el.setAttribute('data-theme', 'light')
  el.setAttribute('data-meniscus-morphing', 'true')
  el.style.transition = 'transform 200ms ease'

  let sawMorphAttributeWhileReading = true
  let sawTransitionWhileReading = ''
  const customVarQueries: string[] = []

  const measured = readElementGlassSurface(el, {
    getComputedStyle: (target) => {
      sawMorphAttributeWhileReading = target.hasAttribute('data-meniscus-morphing')
      sawTransitionWhileReading = (target as HTMLElement).style.transition
      return {
        backdropFilter: 'blur(16px) saturate(1.9) brightness(1.08) contrast(0.95)',
        borderTopWidth: '1px',
        borderTopColor: 'rgba(255, 255, 255, 0.45)',
        backgroundColor: 'rgba(250, 250, 252, 0.6)',
        borderTopLeftRadius: '18px',
        colorScheme: 'light',
        boxShadow:
          '0px 10px 24px 0px rgba(0, 0, 0, 0.14), inset 0px 1px 2px 0px rgba(255, 255, 255, 0.4)',
        getPropertyValue: (prop: string) => {
          customVarQueries.push(prop)
          return ''
        },
      } as unknown as CSSStyleDeclaration
    },
  })

  // Attribute and transition must be temporarily removed during measurement and restored afterwards.
  assert.equal(sawMorphAttributeWhileReading, false)
  assert.equal(sawTransitionWhileReading, 'none')
  assert.equal(el.getAttribute('data-meniscus-morphing'), 'true')
  assert.equal(el.style.transition, 'transform 200ms ease')

  // Must never query private host CSS custom properties.
  assert.equal(
    customVarQueries.some((prop) => prop.startsWith('--')),
    false,
  )

  assert.equal(measured.theme, 'light')
  assert.equal(measured.blurPx, 16)
  assert.equal(measured.saturation, 1.9)
  assert.equal(measured.borderRadiusPx, 18)
  assert.ok(Math.abs(measured.surface.borderWidth - 1) < 1e-6)
  assert.ok(Math.abs(measured.surface.shadowBlur - 24) < 1e-6)
  assert.ok(Math.abs(measured.surface.shadowOffsetY - 10) < 1e-6)
  assert.ok(Math.abs(measured.backgroundRgba[3] - 0.6) < 1e-6)
  assert.ok(Math.abs(measured.surface.veil.brightness - 1.08) < 1e-4)
  assert.ok(Math.abs(measured.surface.veil.contrast - 0.95) < 1e-4)

  // Attribute and transition must also restore cleanly if getComputedStyle throws.
  assert.throws(() =>
    readElementGlassSurface(el, {
      getComputedStyle: () => {
        throw new Error('simulated style read failure')
      },
    }),
  )
  assert.equal(el.getAttribute('data-meniscus-morphing'), 'true')
  assert.equal(el.style.transition, 'transform 200ms ease')
})

test('buildMaterialFromCssSurface preserves signed OpticalMaterial.contrast and honors overrides', () => {
  const doc = new MockDocument()
  const el = doc.createElement('div')
  const measured = readElementGlassSurface(el, {
    fallbackTheme: 'dark',
    matchMedia: null,
    getComputedStyle: () =>
      ({
        backdropFilter: 'blur(14px) saturate(2.1) brightness(1.0) contrast(1.0)',
        borderTopWidth: '1.5px',
        borderTopColor: 'rgba(255, 255, 255, 0.2)',
        backgroundColor: 'rgba(40, 42, 48, 0.72)',
        borderTopLeftRadius: '14px',
        colorScheme: 'dark',
        boxShadow: '0px 8px 30px 0px rgba(0, 0, 0, 0.25)',
        getPropertyValue: () => '',
      }) as unknown as CSSStyleDeclaration,
  })

  const material = buildMaterialFromCssSurface(measured, {
    theme: 'dark',
    preset: 'frosted',
    overrides: { bevel: 18, dispersion: 4 },
  })

  assert.equal(material.blur, 14)
  assert.equal(material.saturation, 2.1)
  assert.equal(material.borderWidth, 1.5)
  assert.equal(material.bevel, 18)
  assert.equal(material.dispersion, 4)
  // OpticalMaterial.contrast must remain on the signed preset delta scale rather than 1.0.
  assert.equal(material.contrast, DEFAULT_OPTICAL_MATERIALS.dark.frosted.contrast)
  assert.ok(Math.abs(material.tintRgba[3] - 0.72) < 1e-6)
})

test('CSS color and backdrop-filter formatters preserve contrastFirst order and omit identity terms', () => {
  assert.equal(formatRgbaCss([1, 0.5, 0, 0.25]), 'rgba(255, 128, 0, 0.25)')
  assert.equal(formatOpaqueSolidCss([1, 0.5, 0, 0.25], 'light'), 'rgb(255, 128, 0)')
  assert.equal(formatOpaqueSolidCss([0, 0, 0, 0], 'light'), 'rgb(250, 250, 252)')
  assert.equal(formatOpaqueSolidCss([0, 0, 0, 0], 'dark'), 'rgb(32, 32, 36)')

  assert.equal(buildBackdropFilterCss({ blurPx: 0, saturation: 1 }), 'none')
  assert.equal(
    buildBackdropFilterCss({
      blurPx: 12,
      saturation: 1.75,
      veil: { brightness: 1.15, contrast: 0.9, contrastFirst: false },
    }),
    'blur(12.00px) saturate(1.75) brightness(1.15) contrast(0.9)',
  )
  assert.equal(
    buildBackdropFilterCss({
      blurPx: 8,
      saturation: 1,
      veil: { brightness: 1.2, contrast: 0.8, contrastFirst: true },
    }),
    'blur(8.00px) contrast(0.8) brightness(1.2)',
  )
})
