/**
 * The CSS fallback every engine must render: a contour-clipped `backdrop-filter` veil (frosted)
 * or an opaque fill (solid). Off Chromium a refract request must land here too.
 *
 * Firefox and WebKit screenshots carry no `backdrop-filter` output (see playwright.config.ts),
 * so there the blur is checked as the filter the engine accepted, and the veil's tint shows
 * its coverage and clip in pixels. Chromium also measures the blur itself.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, test, type Page } from '@playwright/test'
import type { MountOptions } from '../fixtures/harness.ts'
import { CENTER, FAR, FROST, OUTSIDE_CORNERS, PANE, TINT_MIN } from './geometry.ts'
import {
  blueShift,
  lumaStdDev,
  meanDiff,
  meanDiffOver,
  openFixture,
  record,
  screenshot,
  stableScreenshot,
} from './pixels.ts'

const LEAK_MAX = 3

test.beforeEach(async ({ page }) => {
  await openFixture(page)
})

async function mountAndRender(page: Page, options: MountOptions): Promise<number> {
  return page.evaluate(
    async ({ options, pane }) => {
      const id = window.harness.mount(options)
      await window.harness.render(id, [pane])
      return id
    },
    { options, pane: PANE },
  )
}

const frostedCases: { name: string; mode: 'frosted' | 'refract'; skipChromium: boolean }[] = [
  { name: 'frosted mode', mode: 'frosted', skipChromium: false },
  { name: 'a refract request off Chromium', mode: 'refract', skipChromium: true },
]

for (const { name, mode, skipChromium } of frostedCases) {
  test(`${name} frosts inside the contour and nothing outside it`, async ({ page, browserName }) => {
    test.skip(skipChromium && browserName === 'chromium', 'Chromium refracts instead')
    const reference = await stableScreenshot(page)
    const id = await mountAndRender(page, { mode, material: FROST })

    const info = await page.evaluate((id) => window.harness.inspect(id), id)
    expect(info.effectiveMode).toBe('frosted')
    expect(info.refract?.visibility).not.toBe('visible')
    expect(info.veil?.visibility).toBe('visible')
    expect(info.veil?.backdropFilter).toContain('blur(12px)')
    expect(info.veil?.clipPath).toMatch(/^path\(/)
    // The engine accepted the blur, not just the inline declaration.
    expect(
      await page.evaluate(() => {
        const veil = document.querySelector<HTMLElement>('[data-sessile-layer="veil"]')
        if (!veil) return ''
        const style = getComputedStyle(veil)
        return style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter')
      }),
    ).toContain('blur(12px)')

    await expect
      .poll(async () => blueShift(await screenshot(page), CENTER), { message: 'veil never painted' })
      .toBeGreaterThan(TINT_MIN)
    const shot = await stableScreenshot(page)
    record('veil center tint', blueShift(shot, CENTER))
    if (browserName === 'chromium') {
      const sharp = record('page center stddev', lumaStdDev(reference, CENTER))
      expect(record('veil center stddev', lumaStdDev(shot, CENTER))).toBeLessThan(sharp * 0.3)
    }
    expect(record('outside corners', meanDiffOver(shot, reference, OUTSIDE_CORNERS))).toBeLessThan(LEAK_MAX)
    expect(record('far', meanDiff(shot, reference, FAR))).toBeLessThan(0.5)
  })
}

test('solid mode paints an opaque fill inside the contour only', async ({ page }) => {
  const reference = await stableScreenshot(page)
  const id = await mountAndRender(page, { mode: 'solid', material: { tintRgba: [0.2, 0.4, 0.9, 0.6] } })

  const info = await page.evaluate((id) => window.harness.inspect(id), id)
  expect(info.effectiveMode).toBe('solid')
  expect(info.refract?.visibility).not.toBe('visible')

  const shot = await stableScreenshot(page)
  // Opaque: the checkerboard no longer shows through at all.
  expect(record('solid center stddev', lumaStdDev(shot, CENTER))).toBeLessThan(2)
  expect(record('solid center change', meanDiff(shot, reference, CENTER))).toBeGreaterThan(30)
  expect(record('outside corners', meanDiffOver(shot, reference, OUTSIDE_CORNERS))).toBeLessThan(LEAK_MAX)
})

test('disposing restores the page exactly', async ({ page }) => {
  const reference = await stableScreenshot(page)
  const id = await mountAndRender(page, { mode: 'frosted', material: FROST })
  await expect.poll(async () => meanDiff(await screenshot(page), reference, CENTER)).toBeGreaterThan(10)

  await page.evaluate((id) => window.harness.dispose(id), id)
  const after = await stableScreenshot(page)
  expect(meanDiff(after, reference, { x: 0, y: 0, width: 800, height: 600 })).toBe(0)
  expect(await page.locator('[data-sessile-layer], svg[aria-hidden="true"]').count()).toBe(0)
})
