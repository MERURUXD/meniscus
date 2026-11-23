import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKDROP_KINDS } from '../src/components/backdropSettings.ts'
import {
  WALLPAPER_FOLD_COUNT,
  WALLPAPER_FRAGMENT_SHADERS,
  WALLPAPER_PALETTES,
  WALLPAPER_SCENES,
  hexToRgb,
} from '../src/components/wallpaperScenes.ts'

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

test('every scene ships a GLSL ES 3.0 shader driven by the renderer uniforms', () => {
  for (const scene of WALLPAPER_SCENES) {
    const source = WALLPAPER_FRAGMENT_SHADERS[scene]
    assert.match(source, /^#version 300 es\n/, `${scene} must start with the version directive`)
    assert.match(source, /void main\(\)/, `${scene} has no entry point`)
    for (const uniform of ['uRes', 'uTime', 'uDark']) {
      assert.ok(source.includes(uniform), `${scene} ignores ${uniform}`)
    }
  }
})

test('the backdrop picker offers every scene plus the DOM test chart', () => {
  assert.deepEqual(BACKDROP_KINDS, [...WALLPAPER_SCENES, 'chart'])
})
