import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WALLPAPER_FOLD_COUNT,
  WALLPAPER_PALETTES,
  hexToRgb,
} from '../src/components/backdropSettings.ts'

test('hexToRgb decodes sRGB hex into unit channels', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [1, 128 / 255, 0])
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0])
})

test('wallpaper palettes fill every fold and keep neighbouring fold edges distinguishable', () => {
  for (const theme of ['light', 'dark'] as const) {
    const palette = WALLPAPER_PALETTES[theme]
    assert.equal(
      palette.length,
      WALLPAPER_FOLD_COUNT,
      `${theme} palette must match the shader array`,
    )
    for (let i = 1; i < palette.length; i++) {
      const a = hexToRgb(palette[i - 1]!)
      const b = hexToRgb(palette[i]!)
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      // Glass only shows bending where the backdrop has an edge; near-identical folds would hide it.
      assert.ok(
        distance >= 0.12,
        `${theme} folds ${i - 1} and ${i} are too similar (${distance.toFixed(3)})`,
      )
    }
  }
})
