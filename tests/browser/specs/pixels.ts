/**
 * Screenshot pixel helpers. Regions are in CSS pixels, which equal screenshot pixels because
 * every project runs at DPR 1.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export type Image = PNG

/** Opens the fixture page and waits until the harness is installed. */
export async function openFixture(page: Page, backdrop: 'checker' | 'flat' = 'checker'): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.evaluate((kind) => window.harness.setBackdrop(kind), backdrop)
  await page.evaluate(() => window.harness.nextFrames(2))
}

export async function screenshot(page: Page): Promise<Image> {
  return PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' }))
}

/**
 * Takes screenshots a few frames apart until two in a row match, so a pending filter image
 * decode or compositor update cannot land between the measurement and the assertion.
 */
export async function stableScreenshot(page: Page, attempts = 12): Promise<Image> {
  let previous = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  for (let i = 0; i < attempts; i++) {
    await page.evaluate(() => window.harness.nextFrames(3))
    const next = await page.screenshot({ animations: 'disabled', caret: 'hide' })
    if (next.equals(previous)) return PNG.sync.read(next)
    previous = next
  }
  throw new Error('page did not settle into a stable frame')
}

function forEachPixel(image: Image, region: Region, fn: (offset: number) => void): number {
  const x0 = Math.max(0, Math.floor(region.x))
  const y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(image.width, Math.ceil(region.x + region.width))
  const y1 = Math.min(image.height, Math.ceil(region.y + region.height))
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      fn((y * image.width + x) * 4)
      count++
    }
  }
  if (count === 0) throw new Error(`empty region ${JSON.stringify(region)}`)
  return count
}

/** Mean absolute RGB difference (0-255) between two screenshots inside `region`. */
export function meanDiff(a: Image, b: Image, region: Region): number {
  let sum = 0
  const count = forEachPixel(a, region, (o) => {
    sum +=
      Math.abs(a.data[o]! - b.data[o]!) +
      Math.abs(a.data[o + 1]! - b.data[o + 1]!) +
      Math.abs(a.data[o + 2]! - b.data[o + 2]!)
  })
  return sum / (count * 3)
}

/** Mean of `meanDiff` over several regions. */
export function meanDiffOver(a: Image, b: Image, regions: readonly Region[]): number {
  return regions.reduce((acc, r) => acc + meanDiff(a, b, r), 0) / regions.length
}

/** Largest single-channel difference (0-255) inside `region`. */
export function maxDiff(a: Image, b: Image, region: Region): number {
  let max = 0
  forEachPixel(a, region, (o) => {
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(a.data[o + c]! - b.data[o + c]!))
  })
  return max
}

/** Standard deviation of Rec. 709 luma (0-255) inside `region`: high on the bare checkerboard, low once blurred. */
export function lumaStdDev(image: Image, region: Region): number {
  let sum = 0
  let sumSq = 0
  const count = forEachPixel(image, region, (o) => {
    const l = 0.2126 * image.data[o]! + 0.7152 * image.data[o + 1]! + 0.0722 * image.data[o + 2]!
    sum += l
    sumSq += l * l
  })
  const mean = sum / count
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean))
}

/**
 * Mean of blue minus red (-255 to 255) inside `region`. The checkerboard is neutral grey (0), and
 * a blue veil tint shifts it strongly whether or not the backdrop under it is blurred, so this
 * measures where the veil paints in every engine.
 */
export function blueShift(image: Image, region: Region): number {
  let sum = 0
  const count = forEachPixel(image, region, (o) => {
    sum += image.data[o + 2]! - image.data[o]!
  })
  return sum / count
}

/** Logs a measured value next to the test, so CI output shows how much margin each threshold has. */
export function record(name: string, value: number): number {
  const rounded = Math.round(value * 100) / 100
  expect.soft(Number.isFinite(value), `${name} is finite`).toBe(true)
  console.log(`  ${name}: ${rounded}`)
  return value
}
