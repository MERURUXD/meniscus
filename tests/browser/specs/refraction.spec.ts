/**
 * Chromium Route B3 refraction over live DOM: the SVG `backdrop-filter: url(#id)` must displace
 * the backdrop inside the bezel, leave the flat interior in place, and paint nothing outside
 * the rounded contour.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, test, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import type { MountOptions, PrimitiveSpec } from '../fixtures/harness.ts'
import { BEZEL, CENTER, FAR, OUTSIDE_CORNERS, PANE } from './geometry.ts'
import {
  meanDiff,
  meanDiffOver,
  openFixture,
  record,
  screenshot,
  stableScreenshot,
  type Image,
} from './pixels.ts'

/** Mean RGB change the bezel must show (CI measures about 34 for the default 20px bezel). */
const BEZEL_MIN = 20
/** The interior only sees the filter's 0.5px smoothing blur on the checker edges. */
const CENTER_MAX = 16
/** Outside the contour the page must be untouched (antialiasing aside). */
const LEAK_MAX = 3

test.skip(({ browserName }) => browserName !== 'chromium', 'SVG backdrop refraction is Chromium-only')

test.beforeEach(async ({ page }) => {
  await openFixture(page)
})

async function mountAndRender(
  page: Page,
  options: MountOptions,
  primitives: PrimitiveSpec[] = [PANE],
): Promise<number> {
  return page.evaluate(
    async ({ options, primitives }) => {
      const id = window.harness.mount(options)
      await window.harness.render(id, primitives)
      return id
    },
    { options, primitives },
  )
}

/** Waits for the displacement map to reach the compositor, then returns a settled frame. */
async function refractedShot(page: Page, reference: Image): Promise<Image> {
  await expect
    .poll(async () => meanDiffOver(await screenshot(page), reference, BEZEL), {
      message: 'bezel never refracted',
    })
    .toBeGreaterThan(BEZEL_MIN)
  return stableScreenshot(page)
}

for (const nineSlice of [true, false]) {
  const label = nineSlice ? 'nine-slice tiles' : 'full displacement map'

  test(`refracts the bezel, keeps the interior and does not leak (${label})`, async ({ page }) => {
    const reference = await stableScreenshot(page)
    const id = await mountAndRender(page, { mode: 'refract', nineSlice })

    const info = await page.evaluate((id) => window.harness.inspect(id), id)
    expect(info.effectiveMode).toBe('refract')
    expect(info.refract?.visibility).toBe('visible')
    expect(info.refract?.backdropFilter).toMatch(/^url\(/)
    expect(info.refract?.backdropFilter).toContain(`sessile-test-filter-${id}`)
    expect(info.filter.mapMode).toBe(nineSlice ? 'nine-slice' : 'full')
    expect(info.filter.feImages).toBe(nineSlice ? 8 : 1)
    expect(info.filter.mapImages).toBe(info.filter.feImages)

    const shot = await refractedShot(page, reference)
    await test.info().attach(`refracted-${label}`, { body: PNG.sync.write(shot), contentType: 'image/png' })
    expect(record('bezel', meanDiffOver(shot, reference, BEZEL))).toBeGreaterThan(BEZEL_MIN)
    expect(record('center', meanDiff(shot, reference, CENTER))).toBeLessThan(CENTER_MAX)
    expect(record('outside corners', meanDiffOver(shot, reference, OUTSIDE_CORNERS))).toBeLessThan(
      LEAK_MAX,
    )
    expect(record('far', meanDiff(shot, reference, FAR))).toBeLessThan(0.5)
  })
}

test('nine-slice tiles and the full map produce the same lens', async ({ page }) => {
  const reference = await stableScreenshot(page)

  const tiled = await mountAndRender(page, { mode: 'refract', nineSlice: true })
  const tiledShot = await refractedShot(page, reference)
  await page.evaluate((id) => window.harness.dispose(id), tiled)
  await expect.poll(async () => meanDiffOver(await screenshot(page), reference, BEZEL)).toBeLessThan(1)

  await mountAndRender(page, { mode: 'refract', nineSlice: false })
  const fullShot = await refractedShot(page, reference)

  const lens = record('bezel vs page', meanDiffOver(tiledShot, reference, BEZEL))
  const between = record('nine-slice vs full map', meanDiffOver(tiledShot, fullShot, BEZEL))
  // The full map is encoded at half resolution, so edges differ slightly; a different lens
  // (wrong orientation, missing tile, misplaced seam) differs by about as much as the lens itself.
  expect(between).toBeLessThan(lens * 0.35)
})

test('switching frosted -> refract keeps the veil clipped to the contour', async ({ page }) => {
  const reference = await stableScreenshot(page)
  const id = await mountAndRender(page, {
    mode: 'frosted',
    material: { blur: 6, tintRgba: [0.2, 0.4, 0.9, 0.6] },
  })

  const frosted = await stableScreenshot(page)
  expect(record('frosted center', meanDiff(frosted, reference, CENTER))).toBeGreaterThan(BEZEL_MIN)
  expect(record('frosted outside corners', meanDiffOver(frosted, reference, OUTSIDE_CORNERS))).toBeLessThan(
    LEAK_MAX,
  )

  expect(await page.evaluate((id) => window.harness.setMode(id, 'refract'), id)).toBe('refract')
  // The tinted veil stays on top of the refraction; a lost clip-path would fill the corners.
  await expect
    .poll(async () => (await page.evaluate((id) => window.harness.inspect(id), id)).refract?.visibility)
    .toBe('visible')
  const refracted = await stableScreenshot(page)
  expect(record('refract outside corners', meanDiffOver(refracted, reference, OUTSIDE_CORNERS))).toBeLessThan(
    LEAK_MAX,
  )
  expect(record('refract center', meanDiff(refracted, reference, CENTER))).toBeGreaterThan(BEZEL_MIN)
})

test.describe('backdropTarget: container', () => {
  const box = { x: 240, y: 200, width: 320, height: 200, radius: 48 }
  // Field coordinates are in the container's own padding box.
  const local: PrimitiveSpec = { x: 160, y: 100, width: 320, height: 200, radius: 48 }

  test('refracts on the element itself, clipped by its border radius', async ({ page }) => {
    const reference = await stableScreenshot(page)
    const id = await mountAndRender(page, { mode: 'refract', container: box }, [local])

    const info = await page.evaluate((id) => window.harness.inspect(id), id)
    expect(info.refract).toBeNull()
    expect(info.veil).toBeNull()
    expect(info.host?.backdropFilter).toContain(`sessile-test-filter-${id}`)

    const shot = await refractedShot(page, reference)
    expect(record('center', meanDiff(shot, reference, CENTER))).toBeLessThan(CENTER_MAX)
    expect(record('outside corners', meanDiffOver(shot, reference, OUTSIDE_CORNERS))).toBeLessThan(LEAK_MAX)
  })

  test('keeps sampling the page while the element fades', async ({ page }) => {
    const reference = await stableScreenshot(page)
    const id = await mountAndRender(page, { mode: 'refract', container: box }, [local])
    const opaque = await refractedShot(page, reference)
    const full = record('bezel at opacity 1', meanDiffOver(opaque, reference, BEZEL))

    await page.evaluate((id) => window.harness.setContainerStyle(id, 'opacity', '0.6'), id)
    const faded = await stableScreenshot(page)
    // At 60% the refracted image is blended 60/40 with the page underneath, so the change scales
    // down but stays clearly there; a layer that lost its backdrop would show nothing or black.
    const fadedDiff = record('bezel at opacity 0.6', meanDiffOver(faded, reference, BEZEL))
    expect(fadedDiff).toBeGreaterThan(full * 0.3)
    expect(fadedDiff).toBeLessThan(full * 0.9)
    expect(record('center at opacity 0.6', meanDiff(faded, reference, CENTER))).toBeLessThan(CENTER_MAX)
  })
})
