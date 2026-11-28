/**
 * Multi-primitive morphing: two glass circles stay separate when apart, fuse through an `smin`
 * bridge when they meet, and the spring-driven transition runs (and can be interrupted) inside
 * the controller's real requestAnimationFrame loop. The bridge is measured through the veil's
 * tint in every engine, and through the blur as well on Chromium (see fallback.spec.ts).
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, test, type Page } from '@playwright/test'
import { FROST, GAP, TINT_MIN } from './geometry.ts'
import {
  blueShift,
  lumaStdDev,
  meanDiff,
  meanDiffOver,
  openFixture,
  record,
  screenshot,
  stableScreenshot,
  type Image,
} from './pixels.ts'

const APART = 160
/** Overlapping by 24px: well past contact, so the bridge is wide and stable. */
const MERGED = -24
const BLEND_K = 24

test.beforeEach(async ({ page }) => {
  await openFixture(page)
})

async function mountFrosted(page: Page): Promise<number> {
  return page.evaluate((material) => window.harness.mount({ mode: 'frosted', material }), FROST)
}

async function renderGap(page: Page, id: number, gap: number): Promise<void> {
  await page.evaluate(
    async ({ id, gap, blendK }) =>
      window.harness.render(id, window.harness.circlesAtGap(gap, 120), { blendK }),
    { id, gap, blendK: BLEND_K },
  )
}

async function veilSubpaths(page: Page, id: number): Promise<number | undefined> {
  return (await page.evaluate((id) => window.harness.inspect(id), id)).veil?.subpaths
}

function expectGapUntouched(shot: Image, reference: Image): void {
  expect(record('gap change', meanDiff(shot, reference, GAP))).toBeLessThan(3)
}

function expectGapBridged(shot: Image, reference: Image, browserName: string): void {
  expect(record('gap tint', blueShift(shot, GAP))).toBeGreaterThan(TINT_MIN)
  if (browserName === 'chromium') {
    expect(record('gap stddev', lumaStdDev(shot, GAP))).toBeLessThan(lumaStdDev(reference, GAP) * 0.3)
  }
}

test('separate circles leave the gap alone and fuse into one blob when they meet', async ({
  page,
  browserName,
}) => {
  const reference = await stableScreenshot(page)
  record('page gap stddev', lumaStdDev(reference, GAP))
  const id = await mountFrosted(page)

  await renderGap(page, id, APART)
  expect(await veilSubpaths(page, id)).toBe(2)
  expectGapUntouched(await stableScreenshot(page), reference)

  await renderGap(page, id, MERGED)
  expect(await veilSubpaths(page, id)).toBe(1)
  await expect.poll(async () => blueShift(await screenshot(page), GAP)).toBeGreaterThan(TINT_MIN)
  expectGapBridged(await stableScreenshot(page), reference, browserName)

  await renderGap(page, id, APART)
  expect(await veilSubpaths(page, id)).toBe(2)
  expectGapUntouched(await stableScreenshot(page), reference)
})

test('a spring-driven merge runs in the frame loop until it settles', async ({ page, browserName }) => {
  const reference = await stableScreenshot(page)
  const id = await mountFrosted(page)

  const result = await page.evaluate(
    (args) => window.harness.animateGap(args.id, { fromGap: args.from, toGap: args.to, blendK: args.k }),
    { id, from: APART, to: MERGED, k: BLEND_K },
  )
  record('frames', result.frames)
  expect(result.loopStopped).toBe(true)
  expect(result.settled).toBe(true)
  expect(result.frames).toBeGreaterThanOrEqual(10)
  expect(Math.abs(result.finalGap - MERGED)).toBeLessThan(1)
  expect(await veilSubpaths(page, id)).toBe(1)
  expectGapBridged(await stableScreenshot(page), reference, browserName)
})

test('interrupting the merge mid-flight springs back apart', async ({ page }) => {
  const reference = await stableScreenshot(page)
  const id = await mountFrosted(page)

  const result = await page.evaluate(
    (args) =>
      window.harness.animateGap(args.id, {
        fromGap: args.from,
        toGap: args.to,
        blendK: args.k,
        interruptAfterFrames: 4,
        interruptToGap: args.from,
      }),
    { id, from: APART, to: MERGED, k: BLEND_K },
  )
  expect(result.loopStopped).toBe(true)
  expect(result.settled).toBe(true)
  expect(Math.abs(result.finalGap - APART)).toBeLessThan(1)
  expect(await veilSubpaths(page, id)).toBe(2)
  expectGapUntouched(await stableScreenshot(page), reference)
})

test('fused circles refract through one full displacement map on Chromium', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'SVG backdrop refraction is Chromium-only')
  const reference = await stableScreenshot(page)
  const id = await page.evaluate(() => window.harness.mount({ mode: 'refract' }))
  await renderGap(page, id, MERGED)

  const info = await page.evaluate((id) => window.harness.inspect(id), id)
  expect(info.effectiveMode).toBe('refract')
  // Nine-slice only applies to a single primitive; N >= 2 falls back to the full map.
  expect(info.filter.mapMode).toBe('full')
  expect(info.filter.feImages).toBe(1)

  // Just inside the outer edges of the left and right circles (centers 48px from x = 400).
  const outerBezels = [
    { x: 295, y: 290, width: 10, height: 20 },
    { x: 495, y: 290, width: 10, height: 20 },
  ]
  await expect
    .poll(async () => meanDiffOver(await screenshot(page), reference, outerBezels))
    .toBeGreaterThan(30)
  record('outer bezels', meanDiffOver(await stableScreenshot(page), reference, outerBezels))
})
