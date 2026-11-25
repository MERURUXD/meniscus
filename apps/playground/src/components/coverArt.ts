/**
 * Deterministic procedural comic covers for the legibility stress wall.
 *
 * Everything, lettering included, is rasterized into a plain RGBA buffer so the pixels the page
 * shows are exactly the pixels its telemetry is measured from, and so tests run without a canvas.
 */

export type Rgb = readonly [number, number, number]

export type CoverLayout = 'diagonal' | 'halftone' | 'panels' | 'burst'

export interface CoverSpec {
  id: string
  seed: number
  layout: CoverLayout
  ground: Rgb
  accent: Rgb
  /** The title band takes one extreme and the credits strip the other, so every cover spans black to white. */
  band: 'black' | 'white'
  titleColor: Rgb
  title: string
  issue: number
}

export const COVER_SIZE = { width: 200, height: 300 } as const

const BLACK: Rgb = [10, 10, 12]
const WHITE: Rgb = [255, 255, 255]

const SATURATED: readonly Rgb[] = [
  [255, 31, 61],
  [255, 212, 0],
  [0, 150, 255],
  [255, 43, 214],
  [0, 210, 106],
  [255, 122, 0],
  [106, 44, 255],
  [0, 229, 255],
]

const TITLE_ON_BLACK: readonly Rgb[] = [
  [255, 228, 0],
  [255, 255, 255],
  [0, 240, 255],
  [255, 60, 90],
]

const TITLE_ON_WHITE: readonly Rgb[] = [
  [230, 0, 30],
  [10, 10, 12],
  [0, 70, 220],
]

const TITLES = [
  'NEON', 'RIOT', 'VOLT', 'ORBIT', 'BLAZE', 'HEX', 'NOVA', 'FLUX', 'SPARK', 'ZERO', 'COMET',
  'DYNAMO', 'PULSE', 'RAZOR', 'ECHO', 'TITAN', 'VIPER', 'QUAKE', 'GHOST', 'METRO', 'ROCKET',
  'STORM', 'JOLT', 'WARP',
] as const

const LAYOUTS: readonly CoverLayout[] = ['diagonal', 'halftone', 'panels', 'burst']

/** Mulberry32: tiny, fast and stable across engines, which is all a reproducible wall needs. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]!
}

export function createCoverSpecs(count: number, seed: number): CoverSpec[] {
  const rng = createRng(seed)
  const titleOffset = Math.floor(rng() * TITLES.length)
  const specs: CoverSpec[] = []
  for (let i = 0; i < count; i++) {
    const groundIdx = Math.floor(rng() * SATURATED.length)
    const accentIdx = (groundIdx + 1 + Math.floor(rng() * (SATURATED.length - 1))) % SATURATED.length
    const band = rng() < 0.5 ? 'black' : 'white'
    specs.push({
      id: `cover-${i}`,
      seed: Math.floor(rng() * 0xffffffff),
      layout: LAYOUTS[(i + Math.floor(rng() * 2)) % LAYOUTS.length]!,
      ground: SATURATED[groundIdx]!,
      accent: SATURATED[accentIdx]!,
      band,
      titleColor: pick(rng, band === 'black' ? TITLE_ON_BLACK : TITLE_ON_WHITE),
      // Stride 5 is coprime with the list length, so neighbouring covers never repeat a title.
      title: TITLES[(titleOffset + i * 5) % TITLES.length]!,
      issue: 1 + Math.floor(rng() * 99),
    })
  }
  return specs
}

// 5x7 bitmap font, one 5-bit row per entry with bit 4 as the leftmost column.
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
}

const GLYPH_W = 5
const GLYPH_H = 7
const FILLER = 'ABCDEFGHIJKLMNOPRSTUVWY'

interface Raster {
  data: Uint8ClampedArray<ArrayBuffer>
  w: number
  h: number
}

function setPixel(r: Raster, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return
  const i = (y * r.w + x) * 4
  r.data[i] = c[0]
  r.data[i + 1] = c[1]
  r.data[i + 2] = c[2]
  r.data[i + 3] = 255
}

function fillRect(r: Raster, x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
  const ax = Math.max(0, Math.floor(x0))
  const ay = Math.max(0, Math.floor(y0))
  const bx = Math.min(r.w, Math.floor(x1))
  const by = Math.min(r.h, Math.floor(y1))
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) setPixel(r, x, y, c)
  }
}

function fillWhere(r: Raster, inside: (x: number, y: number) => boolean, c: Rgb): void {
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (inside(x + 0.5, y + 0.5)) setPixel(r, x, y, c)
    }
  }
}

function drawText(r: Raster, text: string, x: number, y: number, scale: number, c: Rgb): void {
  let pen = Math.floor(x)
  for (const ch of text) {
    const rows = GLYPHS[ch]
    if (rows) {
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const bits = rows[gy]!
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (bits & (1 << (GLYPH_W - 1 - gx))) {
            fillRect(r, pen + gx * scale, y + gy * scale, pen + (gx + 1) * scale, y + (gy + 1) * scale, c)
          }
        }
      }
    }
    pen += (GLYPH_W + 1) * scale
  }
}

function textWidth(text: string, scale: number): number {
  return Math.max(0, text.length * (GLYPH_W + 1) - 1) * scale
}

type LayoutPainter = (r: Raster, spec: CoverSpec, rng: () => number) => void

const LAYOUT_PAINTERS: Readonly<Record<CoverLayout, LayoutPainter>> = {
  diagonal(r, spec, rng) {
    const yl = r.h * (0.35 + rng() * 0.35)
    const yr = r.h * (0.35 + rng() * 0.35)
    const slope = (yr - yl) / r.w
    const half = rng() < 0.5 ? BLACK : WHITE
    fillWhere(r, (x, y) => y > yl + slope * x, half)
    fillWhere(r, (x, y) => Math.abs(y - (yl + slope * x)) < 7, spec.accent)
  },
  halftone(r, spec, rng) {
    const cell = 8 + Math.floor(rng() * 3)
    const ink = rng() < 0.7 ? BLACK : spec.accent
    for (let cy = 0; cy * cell < r.h; cy++) {
      const radius = cell * 0.62 * (cy * cell / r.h)
      for (let cx = 0; cx * cell < r.w; cx++) {
        const ox = (cx + 0.5 + (cy % 2) * 0.5) * cell
        const oy = (cy + 0.5) * cell
        for (let y = Math.floor(oy - radius); y <= oy + radius; y++) {
          for (let x = Math.floor(ox - radius); x <= ox + radius; x++) {
            if ((x + 0.5 - ox) ** 2 + (y + 0.5 - oy) ** 2 <= radius * radius) setPixel(r, x, y, ink)
          }
        }
      }
    }
    const sx = r.w * (0.25 + rng() * 0.5)
    const sy = r.h * (0.35 + rng() * 0.3)
    const sr = r.w * (0.18 + rng() * 0.08)
    fillWhere(r, (x, y) => (x - sx) ** 2 + (y - sy) ** 2 <= sr * sr, WHITE)
  },
  panels(r, spec, rng) {
    const gutter = 5
    const splitX = r.w * (0.35 + rng() * 0.3)
    const splitY = r.h * (0.3 + rng() * 0.4)
    fillRect(r, splitX, 0, r.w, splitY, spec.accent)
    fillRect(r, 0, splitY, splitX, r.h, rng() < 0.5 ? WHITE : spec.accent)
    fillRect(r, splitX - gutter / 2, 0, splitX + gutter / 2, r.h, BLACK)
    fillRect(r, 0, splitY - gutter / 2, r.w, splitY + gutter / 2, BLACK)
  },
  burst(r, spec, rng) {
    const cx = r.w * (0.3 + rng() * 0.4)
    const cy = r.h * (0.4 + rng() * 0.25)
    const rays = 10 + 2 * Math.floor(rng() * 4)
    fillWhere(
      r,
      (x, y) => Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * rays) % 2 === 0,
      spec.accent,
    )
    const core = r.w * 0.17
    fillWhere(r, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= (core + 4) ** 2, BLACK)
    fillWhere(r, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= core ** 2, WHITE)
  },
}

/** Paints `spec` into a fresh `width * height` RGBA buffer, ready for `ImageData`. */
export function paintCover(
  spec: CoverSpec,
  width: number = COVER_SIZE.width,
  height: number = COVER_SIZE.height,
): Uint8ClampedArray<ArrayBuffer> {
  const r: Raster = { data: new Uint8ClampedArray(width * height * 4), w: width, h: height }
  const rng = createRng(spec.seed)
  const bandInk = spec.band === 'black' ? BLACK : WHITE
  const stripInk = spec.band === 'black' ? WHITE : BLACK

  fillRect(r, 0, 0, width, height, spec.ground)
  LAYOUT_PAINTERS[spec.layout](r, spec, rng)

  const pad = Math.round(width * 0.06)
  const scale = Math.max(2, Math.min(7, Math.floor((width - pad * 2) / ((GLYPH_W + 1) * spec.title.length))))
  const bandH = GLYPH_H * scale + pad * 2
  fillRect(r, 0, 0, width, bandH, bandInk)
  const tx = Math.round((width - textWidth(spec.title, scale)) / 2)
  const shadow = Math.max(1, Math.floor(scale / 2))
  drawText(r, spec.title, tx + shadow, pad + shadow, scale, spec.accent)
  drawText(r, spec.title, tx, pad, scale, spec.titleColor)

  const issue = `#${spec.issue}`
  const badgeScale = 2
  const badgeW = textWidth(issue, badgeScale) + 8
  const badgeY = bandH + 6
  fillRect(r, pad, badgeY, pad + badgeW, badgeY + GLYPH_H * badgeScale + 8, stripInk)
  drawText(r, issue, pad + 4, badgeY + 4, badgeScale, bandInk)

  // Credits strip: single-pixel lettering is what dense small cover text looks like at wall scale.
  const stripH = Math.round(height * 0.2)
  const stripY = height - stripH
  fillRect(r, 0, stripY, width, height, stripInk)
  const barcodeW = Math.round(width * 0.26)
  const lineH = GLYPH_H + 3
  for (let y = stripY + 5; y + GLYPH_H <= height - 4; y += lineH) {
    let line = ''
    const maxChars = Math.floor((width - barcodeW - pad * 2) / (GLYPH_W + 1))
    while (line.length < maxChars) {
      line += rng() < 0.18 ? ' ' : FILLER[Math.floor(rng() * FILLER.length)]
    }
    drawText(r, line, pad, y, 1, bandInk)
  }
  const bx0 = width - barcodeW - pad / 2
  fillRect(r, bx0, stripY + 5, width - pad / 2, height - 5, WHITE)
  for (let x = bx0 + 3; x < width - pad / 2 - 3; ) {
    const bar = 1 + Math.floor(rng() * 3)
    fillRect(r, x, stripY + 8, x + bar, height - 8, BLACK)
    x += bar + 1 + Math.floor(rng() * 2)
  }
  return r.data
}
