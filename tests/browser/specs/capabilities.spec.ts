/**
 * Capability detection and render-mode resolution against the real engines, not a mocked
 * user agent: the progressive-enhancement contract starts here.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, test } from '@playwright/test'
import { PANE } from './geometry.ts'
import { openFixture } from './pixels.ts'

test.beforeEach(async ({ page }) => {
  await openFixture(page)
})

test('SVG backdrop refraction is detected on Chromium only', async ({ page, browserName }) => {
  const detected = await page.evaluate(() => window.harness.supportsSvgBackdropRefraction())
  expect(detected).toBe(browserName === 'chromium')
  if (browserName === 'chromium') {
    expect(await page.evaluate(() => window.harness.cssSupportsUrlBackdrop())).toBe(true)
  }
})

test('a refract request resolves to refract on Chromium and frosted elsewhere', async ({
  page,
  browserName,
}) => {
  const info = await page.evaluate(async (pane) => {
    const id = window.harness.mount({ mode: 'refract', material: { blur: 12 } })
    await window.harness.render(id, [pane])
    return window.harness.inspect(id)
  }, PANE)

  expect(info.requestedMode).toBe('refract')
  if (browserName === 'chromium') {
    expect(info.effectiveMode).toBe('refract')
    expect(info.refract?.visibility).toBe('visible')
    expect(info.refract?.backdropFilter).toMatch(/^url\(/)
    expect(info.refract?.backdropFilter).toContain('sessile-test-filter-')
  } else {
    expect(info.effectiveMode).toBe('frosted')
    expect(info.refract?.visibility).not.toBe('visible')
    expect(info.filter.mounted).toBe(false)
    expect(info.veil?.backdropFilter).toContain('blur(12px)')
  }
})

test('reduced motion drops refraction and a live media change restores it', async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const id = await page.evaluate(async (pane) => {
    const id = window.harness.mount({ mode: 'refract', disableRefractOnReducedMotion: true })
    await window.harness.render(id, [pane])
    return id
  }, PANE)
  const inspect = () => page.evaluate((id) => window.harness.inspect(id), id)

  expect((await inspect()).effectiveMode).toBe('frosted')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const expected = browserName === 'chromium' ? 'refract' : 'frosted'
  await expect.poll(async () => (await inspect()).effectiveMode).toBe(expected)
  if (browserName === 'chromium') {
    await expect.poll(async () => (await inspect()).refract?.visibility).toBe('visible')
  }
})
