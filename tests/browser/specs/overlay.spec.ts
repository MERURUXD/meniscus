/**
 * The perimeter overlay (rim highlights, hairline and outer shadow) drawn by WebGL2, or by 2D
 * Canvas where WebGL2 is missing, including the page-wide shared WebGL2 context.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, test } from '@playwright/test'
import type { PrimitiveSpec } from '../fixtures/harness.ts'
import { CENTER, FAR, PANE } from './geometry.ts'
import { maxDiff, meanDiff, openFixture, record, screenshot, stableScreenshot } from './pixels.ts'

/** A hairline or rim pixel on the flat backdrop changes by far more than this. */
const EDGE_MIN = 30

test.beforeEach(async ({ page }) => {
  await openFixture(page, 'flat')
})

test('the dedicated overlay draws the edge and leaves the interior alone', async ({ page, browserName }) => {
  const reference = await stableScreenshot(page)
  const id = await page.evaluate(async (pane) => {
    const id = window.harness.mount({ mode: 'frosted', overlay: 'dedicated' })
    await window.harness.render(id, [pane])
    return id
  }, PANE)

  const { overlay } = await page.evaluate((id) => window.harness.inspect(id), id)
  console.log(`  ${browserName} overlay: ${JSON.stringify(overlay)}`)
  if (browserName === 'chromium') {
    // Headless Chromium renders WebGL2 in software (SwiftShader); losing it means the GPU path
    // silently stopped being exercised.
    expect(overlay.webgl2).toBe(true)
  }

  const topEdge = { x: 300, y: 196, width: 200, height: 8 }
  await expect
    .poll(async () => maxDiff(await screenshot(page), reference, topEdge), { message: 'no edge drawn' })
    .toBeGreaterThan(EDGE_MIN)
  const shot = await stableScreenshot(page)
  record('edge max change', maxDiff(shot, reference, topEdge))
  expect(record('interior change', meanDiff(shot, reference, CENTER))).toBeLessThan(1)
  expect(record('far', meanDiff(shot, reference, FAR))).toBeLessThan(0.5)
})

test('one shared WebGL2 context draws more overlays than a page may hold contexts', async ({
  page,
  browserName,
}) => {
  const reference = await stableScreenshot(page)
  // 24 surfaces: past Chromium's cap of 16 live WebGL contexts, which dedicated overlays would hit.
  const pills: PrimitiveSpec[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      pills.push({ x: 100 + col * 120, y: 120 + row * 120, width: 80, height: 50, radius: 25 })
    }
  }

  const overlays = await page.evaluate(async (pills) => {
    const ids = pills.map(() => window.harness.mount({ mode: 'frosted', overlay: 'shared' }))
    // Render after every surface is mounted, so the first ones prove they survived the rest.
    for (let i = 0; i < ids.length; i++) await window.harness.render(ids[i]!, [pills[i]!])
    return ids.map((id) => window.harness.inspect(id).overlay)
  }, pills)

  const webgl2 = overlays.map((o) => o.webgl2)
  console.log(`  ${browserName} shared overlay webgl2: ${webgl2[0]}`)
  expect(new Set(webgl2).size).toBe(1)
  if (browserName === 'chromium') expect(webgl2[0]).toBe(true)

  const shot = await stableScreenshot(page)
  const edges = pills.map((p) => ({ x: p.x - 20, y: p.y - p.height / 2 - 4, width: 40, height: 8 }))
  const changes = edges.map((edge) => maxDiff(shot, reference, edge))
  record('weakest pill edge', Math.min(...changes))
  for (let i = 0; i < changes.length; i++) {
    expect(changes[i], `pill ${i} drew its edge`).toBeGreaterThan(EDGE_MIN)
  }

  // Releasing every user tears the shared context down; the next surface must build a new one.
  await page.evaluate(() => window.harness.disposeAll())
  const id = await page.evaluate(async (pane) => {
    const id = window.harness.mount({ mode: 'frosted', overlay: 'shared' })
    await window.harness.render(id, [pane])
    return id
  }, PANE)
  expect((await page.evaluate((id) => window.harness.inspect(id), id)).overlay.webgl2).toBe(webgl2[0])
  const topEdge = { x: 300, y: 196, width: 200, height: 8 }
  await expect
    .poll(async () => maxDiff(await screenshot(page), reference, topEdge))
    .toBeGreaterThan(EDGE_MIN)
})
