/**
 * Zero-dependency CLI microbenchmark suite for Sessile core and DOM refraction hot paths.
 *
 * Usage:
 *   pnpm bench
 *   pnpm bench --quick
 *   pnpm bench --json
 *   pnpm bench --filter=nine-slice
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import { performance } from 'node:perf_hooks'
import {
  evaluateFieldSdf,
  extractFieldContourPath,
  prepareField,
  type GlassFieldState,
  type GlassPrimitive,
} from '../packages/core/src/index.ts'
import {
  buildRefractMapDataUrl,
  clearRefractTilesCache,
  computeRefractionProfileLut,
  resolveRefractTiles,
  resolveRefractionProfileLut,
} from '../packages/core/src/entries/internal.ts'
import { createRefractFilterController } from '../packages/dom/src/index.ts'
import { resolveEffectiveMapScale } from '../packages/dom/src/entries/internal.ts'

const FRAME_BUDGET_60FPS_MS = 1000 / 60

interface CliOptions {
  quick: boolean
  json: boolean
  filter: string
}

interface BenchmarkSpec {
  name: string
  warmupOps: number
  samples: number
  batchSize: number
  payloadKb?: () => number
  setup?: () => void
  teardown?: () => void
  run: (iter: number) => unknown
}

interface BenchmarkRecord {
  name: string
  opsPerSec: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  frameBudgetPct: number
  payloadKb: number | null
}

// Module-level sink prevents V8 from eliminating side-effect-free calculations.
let benchSink: unknown = null

function parseCliArgs(argv: readonly string[]): CliOptions {
  let quick = false
  let json = false
  let filter = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--quick') {
      quick = true
    } else if (arg === '--json') {
      json = true
    } else if (arg.startsWith('--filter=')) {
      filter = arg.slice('--filter='.length).trim().toLowerCase()
    } else if (arg === '--filter' && i + 1 < argv.length) {
      filter = argv[++i]!.trim().toLowerCase()
    }
  }

  return { quick, json, filter }
}

/** Minimal headless DOM mock sufficient to drive `createRefractFilterController` end-to-end. */
class BenchMockElement {
  readonly tagName: string
  readonly style: Record<string, string> = {}
  readonly childNodes: BenchMockElement[] = []
  readonly attributes = new Map<string, string>()
  parentNode: BenchMockElement | null = null

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get firstChild(): BenchMockElement | null {
    return this.childNodes[0] ?? null
  }

  appendChild<T extends BenchMockElement>(node: T): T {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    this.childNodes.push(node)
    node.parentNode = this
    return node
  }

  insertBefore<T extends BenchMockElement>(node: T, referenceNode: BenchMockElement | null): T {
    if (!referenceNode) {
      return this.appendChild(node)
    }
    const refIdx = this.childNodes.indexOf(referenceNode)
    if (refIdx === -1) {
      return this.appendChild(node)
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
    const targetIdx = this.childNodes.indexOf(referenceNode)
    this.childNodes.splice(targetIdx, 0, node)
    node.parentNode = this
    return node
  }

  removeChild<T extends BenchMockElement>(node: T): T {
    const idx = this.childNodes.indexOf(node)
    if (idx !== -1) {
      this.childNodes.splice(idx, 1)
      node.parentNode = null
    }
    return node
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }
}

class BenchMockDocument {
  readonly body = new BenchMockElement('body')

  createElementNS(_namespaceURI: string, qualifiedName: string): BenchMockElement {
    return new BenchMockElement(qualifiedName)
  }
}

function makeClusterPrimitives(count: number, spanW: number, spanH: number): GlassPrimitive[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.max(1, Math.ceil(count / cols))
  const padX = 56
  const padY = 48
  const usableW = Math.max(40, spanW - padX * 2)
  const usableH = Math.max(40, spanH - padY * 2)
  const primitives: GlassPrimitive[] = []

  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = cols === 1 ? spanW * 0.5 : padX + (col / (cols - 1)) * usableW
    const cy = rows === 1 ? spanH * 0.5 : padY + (row / (rows - 1)) * usableH
    const w = Math.max(44, Math.min(120, usableW / Math.max(1, cols * 0.85)))
    const h = Math.max(36, Math.min(84, usableH / Math.max(1, rows * 0.85)))
    primitives.push({
      id: `p-${i}`,
      center: { x: cx, y: cy },
      size: { width: w, height: h },
      radius: Math.min(20, w * 0.35, h * 0.35),
    })
  }
  return primitives
}

function sumTilesKb(tiles: ReturnType<typeof resolveRefractTiles>): number {
  const totalBytes =
    tiles.tl.length +
    tiles.tr.length +
    tiles.bl.length +
    tiles.br.length +
    tiles.top.length +
    tiles.bottom.length +
    tiles.left.length +
    tiles.right.length
  return totalBytes / 1024
}

function percentileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[idx]!
}

function executeBenchmark(spec: BenchmarkSpec, quick: boolean): BenchmarkRecord {
  const batchSize = quick ? Math.max(1, Math.ceil(spec.batchSize * 0.35)) : spec.batchSize
  const warmupOps = quick ? Math.max(1, Math.ceil(spec.warmupOps * 0.35)) : spec.warmupOps
  const samples = quick ? Math.max(5, Math.ceil(spec.samples * 0.45)) : spec.samples

  spec.setup?.()
  try {
    for (let i = 0; i < warmupOps; i++) {
      benchSink = spec.run(i)
    }

    const perOpMs: number[] = []
    let iter = warmupOps
    let totalMs = 0

    for (let s = 0; s < samples; s++) {
      const start = performance.now()
      for (let b = 0; b < batchSize; b++) {
        benchSink = spec.run(iter++)
      }
      const elapsed = performance.now() - start
      totalMs += elapsed
      perOpMs.push(elapsed / batchSize)
    }

    perOpMs.sort((a, b) => a - b)
    const meanMs = totalMs / (samples * batchSize)
    const opsPerSec = meanMs > 0 ? 1000 / meanMs : 0
    const p50Ms = percentileSorted(perOpMs, 0.5)
    const p95Ms = percentileSorted(perOpMs, 0.95)
    const payloadKb = spec.payloadKb ? spec.payloadKb() : null

    return {
      name: spec.name,
      opsPerSec,
      meanMs,
      p50Ms,
      p95Ms,
      frameBudgetPct: (meanMs / FRAME_BUDGET_60FPS_MS) * 100,
      payloadKb,
    }
  } finally {
    spec.teardown?.()
  }
}

function buildBenchmarks(): BenchmarkSpec[] {
  const card400Field: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 200, y: 120 }, size: { width: 380, height: 220 }, radius: 24 }],
  }
  const card400Bounds = { x: 0, y: 0, width: 400, height: 240 }

  const panel960Field: GlassFieldState = {
    blendK: 16,
    primitives: [{ center: { x: 480, y: 300 }, size: { width: 920, height: 560 }, radius: 24 }],
  }
  const panel960Bounds = { x: 0, y: 0, width: 960, height: 600 }

  const morph2Field: GlassFieldState = {
    blendK: 22,
    primitives: [
      { center: { x: 112, y: 80 }, size: { width: 120, height: 84 }, radius: 24 },
      { center: { x: 208, y: 80 }, size: { width: 112, height: 76 }, radius: 24 },
    ],
  }
  const morph2Bounds = { x: 0, y: 0, width: 320, height: 160 }

  const cluster4Field: GlassFieldState = {
    blendK: 20,
    primitives: makeClusterPrimitives(4, 480, 320),
  }
  const cluster4Bounds = { x: 0, y: 0, width: 480, height: 320 }

  const cluster16Field: GlassFieldState = {
    blendK: 18,
    primitives: makeClusterPrimitives(16, 600, 400),
  }
  const cluster16Bounds = { x: 0, y: 0, width: 600, height: 400 }

  const cluster8ContourField: GlassFieldState = {
    blendK: 20,
    primitives: makeClusterPrimitives(8, 520, 340),
  }

  const large4Field: GlassFieldState = {
    blendK: 24,
    primitives: makeClusterPrimitives(4, 1200, 800),
  }
  const large4Bounds = { x: 0, y: 0, width: 1200, height: 800 }
  const budget96kScale = resolveEffectiveMapScale(1200, 800, 0.5)

  const prepared16 = prepareField(cluster16Field)
  const evalPoint = { x: 0, y: 0 }
  const evalCoordsX = new Float64Array(1024)
  const evalCoordsY = new Float64Array(1024)
  for (let i = 0; i < 1024; i++) {
    evalCoordsX[i] = ((i % 32) + 0.5) * (600 / 32)
    evalCoordsY[i] = (Math.floor(i / 32) + 0.5) * (400 / 32)
  }

  let domFullController: ReturnType<typeof createRefractFilterController> | null = null
  let domNineSliceController: ReturnType<typeof createRefractFilterController> | null = null

  const buildResizeFrame = (iter: number) => {
    const width = 240 + (iter % 64) * 4
    const height = 220
    return {
      bounds: { x: 0, y: 0, width: width + 16, height: height + 16 },
      field: {
        blendK: 16,
        primitives: [
          {
            center: { x: 8 + width * 0.5, y: 8 + height * 0.5 },
            size: { width, height },
            radius: 24,
          },
        ],
      },
      blurSigma: 8,
      saturate: 1.5,
      brightness: 1,
      contrast: 1,
    }
  }

  return [
    {
      name: 'snell-lut/cold-squircle',
      warmupOps: 50,
      samples: 40,
      batchSize: 50,
      run: () =>
        computeRefractionProfileLut({
          profile: 'squircle',
          ior: 1.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'snell-lut/cached-lru',
      warmupOps: 200,
      samples: 30,
      batchSize: 5000,
      setup: () => {
        resolveRefractionProfileLut({ profile: 'squircle', ior: 1.5, thicknessRatio: 1.32 })
      },
      run: () =>
        resolveRefractionProfileLut({
          profile: 'squircle',
          ior: 1.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n1-card-400x240/full-map-0.5x',
      warmupOps: 5,
      samples: 20,
      batchSize: 3,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: card400Bounds,
          field: card400Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: card400Bounds,
          field: card400Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n1-card-400x240/nine-slice-cold',
      warmupOps: 10,
      samples: 25,
      batchSize: 5,
      payloadKb: () => {
        clearRefractTilesCache()
        return sumTilesKb(resolveRefractTiles({ radius: 24, bezel: 20, thicknessRatio: 1.32 }))
      },
      run: () => {
        clearRefractTilesCache()
        return resolveRefractTiles({ radius: 24, bezel: 20, thicknessRatio: 1.32 })
      },
    },
    {
      name: 'n1-card-400x240/nine-slice-cache-hit',
      warmupOps: 200,
      samples: 30,
      batchSize: 5000,
      payloadKb: () =>
        sumTilesKb(resolveRefractTiles({ radius: 24, bezel: 20, thicknessRatio: 1.32 })),
      setup: () => {
        clearRefractTilesCache()
        resolveRefractTiles({ radius: 24, bezel: 20, thicknessRatio: 1.32 })
      },
      run: () => resolveRefractTiles({ radius: 24, bezel: 20, thicknessRatio: 1.32 }),
    },
    {
      name: 'n1-panel-960x600/full-map-0.5x',
      warmupOps: 2,
      samples: 15,
      batchSize: 1,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: panel960Bounds,
          field: panel960Field,
          bezel: 22,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: panel960Bounds,
          field: panel960Field,
          bezel: 22,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n1-panel-960x600/nine-slice-cold',
      warmupOps: 10,
      samples: 25,
      batchSize: 5,
      payloadKb: () => {
        clearRefractTilesCache()
        return sumTilesKb(resolveRefractTiles({ radius: 24, bezel: 22, thicknessRatio: 1.32 }))
      },
      run: () => {
        clearRefractTilesCache()
        return resolveRefractTiles({ radius: 24, bezel: 22, thicknessRatio: 1.32 })
      },
    },
    {
      name: 'dom-resize-card/full-map',
      warmupOps: 4,
      samples: 15,
      batchSize: 2,
      setup: () => {
        const doc = new BenchMockDocument()
        domFullController = createRefractFilterController({
          id: 'bench-dom-full',
          document: doc as unknown as Document,
          bezel: 20,
          strength: 1.32,
          nineSlice: false,
        })
        domFullController.mount(doc.body as unknown as Element)
      },
      teardown: () => {
        domFullController?.dispose()
        domFullController = null
      },
      run: (iter) => {
        domFullController!.updateFrame(buildResizeFrame(iter))
        return iter
      },
    },
    {
      name: 'dom-resize-card/nine-slice',
      warmupOps: 200,
      samples: 30,
      batchSize: 500,
      setup: () => {
        const doc = new BenchMockDocument()
        domNineSliceController = createRefractFilterController({
          id: 'bench-dom-ns',
          document: doc as unknown as Document,
          bezel: 20,
          strength: 1.32,
          nineSlice: true,
        })
        domNineSliceController.mount(doc.body as unknown as Element)
        clearRefractTilesCache()
      },
      teardown: () => {
        domNineSliceController?.dispose()
        domNineSliceController = null
      },
      run: (iter) => {
        domNineSliceController!.updateFrame(buildResizeFrame(iter))
        return iter
      },
    },
    {
      name: 'n2-morph-320x160/full-map-0.5x',
      warmupOps: 5,
      samples: 20,
      batchSize: 3,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: morph2Bounds,
          field: morph2Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: morph2Bounds,
          field: morph2Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n4-cluster-480x320/full-map-0.5x',
      warmupOps: 3,
      samples: 15,
      batchSize: 2,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: cluster4Bounds,
          field: cluster4Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: cluster4Bounds,
          field: cluster4Field,
          bezel: 20,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n16-cluster-600x400/full-map-0.5x',
      warmupOps: 2,
      samples: 12,
      batchSize: 1,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: cluster16Bounds,
          field: cluster16Field,
          bezel: 18,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: cluster16Bounds,
          field: cluster16Field,
          bezel: 18,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n4-large-1200x800/uncapped-0.5x',
      warmupOps: 1,
      samples: 10,
      batchSize: 1,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: large4Bounds,
          field: large4Field,
          bezel: 22,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: large4Bounds,
          field: large4Field,
          bezel: 22,
          mapScale: 0.5,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'n4-large-1200x800/budget-96k',
      warmupOps: 2,
      samples: 15,
      batchSize: 1,
      payloadKb: () =>
        buildRefractMapDataUrl({
          bounds: large4Bounds,
          field: large4Field,
          bezel: 22,
          mapScale: budget96kScale,
          thicknessRatio: 1.32,
        }).length / 1024,
      run: () =>
        buildRefractMapDataUrl({
          bounds: large4Bounds,
          field: large4Field,
          bezel: 22,
          mapScale: budget96kScale,
          thicknessRatio: 1.32,
        }),
    },
    {
      name: 'contour/n2-bridged',
      warmupOps: 20,
      samples: 25,
      batchSize: 10,
      run: () => extractFieldContourPath(morph2Field),
    },
    {
      name: 'contour/n8-cluster',
      warmupOps: 10,
      samples: 20,
      batchSize: 4,
      run: () => extractFieldContourPath(cluster8ContourField),
    },
    {
      name: 'sdf/n16-eval-1024pts',
      warmupOps: 20,
      samples: 25,
      batchSize: 10,
      run: () => {
        let acc = 0
        for (let i = 0; i < 1024; i++) {
          evalPoint.x = evalCoordsX[i]!
          evalPoint.y = evalCoordsY[i]!
          acc += evaluateFieldSdf(evalPoint, prepared16).distance
        }
        return acc
      },
    },
  ]
}

function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}k`
  return ops.toFixed(1)
}

function formatMs(ms: number): string {
  if (ms < 0.001) return `${(ms * 1000).toFixed(2)} us`
  if (ms < 1) return `${ms.toFixed(4)} ms`
  return `${ms.toFixed(3)} ms`
}

function padLeft(value: string, width: number): string {
  return value.padStart(width, ' ')
}

function padRight(value: string, width: number): string {
  return value.padEnd(width, ' ')
}

function printHumanReport(records: readonly BenchmarkRecord[], quick: boolean): void {
  const modeLabel = quick ? 'quick smoke' : 'full'
  console.log(`\nSessile Performance Benchmarks (${modeLabel}, Node ${process.version})\n`)

  const headers = ['Benchmark', 'ops/sec', 'mean', 'p50', 'p95', '60fps%', 'payload']
  const widths = [38, 10, 12, 12, 12, 9, 10]

  const headerLine = headers
    .map((h, idx) => (idx === 0 ? padRight(h, widths[idx]!) : padLeft(h, widths[idx]!)))
    .join(' | ')
  const sepLine = widths.map((w) => '-'.repeat(w)).join('-|-')
  console.log(headerLine)
  console.log(sepLine)

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    const row = [
      padRight(r.name, widths[0]!),
      padLeft(formatOps(r.opsPerSec), widths[1]!),
      padLeft(formatMs(r.meanMs), widths[2]!),
      padLeft(formatMs(r.p50Ms), widths[3]!),
      padLeft(formatMs(r.p95Ms), widths[4]!),
      padLeft(`${r.frameBudgetPct.toFixed(2)}%`, widths[5]!),
      padLeft(r.payloadKb !== null ? `${r.payloadKb.toFixed(1)} KB` : '-', widths[6]!),
    ]
    console.log(row.join(' | '))
  }

  const byName = new Map<string, BenchmarkRecord>()
  for (let i = 0; i < records.length; i++) {
    byName.set(records[i]!.name, records[i]!)
  }

  const highlights: string[] = []
  const addPairHighlight = (label: string, fastName: string, slowName: string): void => {
    const fast = byName.get(fastName)
    const slow = byName.get(slowName)
    if (!fast || !slow || fast.meanMs <= 0) return
    const speedup = slow.meanMs / fast.meanMs
    let suffix = ''
    if (fast.payloadKb !== null && slow.payloadKb !== null && slow.payloadKb > 0) {
      const reduction = (1 - fast.payloadKb / slow.payloadKb) * 100
      suffix = `, payload ${slow.payloadKb.toFixed(1)} KB -> ${fast.payloadKb.toFixed(1)} KB (-${reduction.toFixed(1)}%)`
    }
    highlights.push(`- ${label}: ${speedup.toFixed(2)}x faster (${formatMs(slow.meanMs)} -> ${formatMs(fast.meanMs)}${suffix})`)
  }

  addPairHighlight(
    'Card 400x240 (nine-slice cold vs full-map 0.5x)',
    'n1-card-400x240/nine-slice-cold',
    'n1-card-400x240/full-map-0.5x',
  )
  addPairHighlight(
    'Panel 960x600 (nine-slice cold vs full-map 0.5x)',
    'n1-panel-960x600/nine-slice-cold',
    'n1-panel-960x600/full-map-0.5x',
  )
  addPairHighlight(
    'DOM resize card (nine-slice vs full-map)',
    'dom-resize-card/nine-slice',
    'dom-resize-card/full-map',
  )
  addPairHighlight(
    'Large 1200x800 N=4 (budget-96k vs uncapped 0.5x)',
    'n4-large-1200x800/budget-96k',
    'n4-large-1200x800/uncapped-0.5x',
  )

  if (highlights.length > 0) {
    console.log('\nHighlights:')
    for (let i = 0; i < highlights.length; i++) {
      console.log(highlights[i]!)
    }
  }
  console.log('')
}

function main(): void {
  const cli = parseCliArgs(process.argv.slice(2))
  const all = buildBenchmarks()
  const selected = cli.filter
    ? all.filter((b) => b.name.toLowerCase().includes(cli.filter))
    : all

  const results: BenchmarkRecord[] = []
  for (let i = 0; i < selected.length; i++) {
    results.push(executeBenchmark(selected[i]!, cli.quick))
  }

  if (cli.json) {
    console.log(
      JSON.stringify(
        {
          node: process.version,
          quick: cli.quick,
          filter: cli.filter || null,
          benchmarks: results,
          sinkPresent: benchSink !== null,
        },
        null,
        2,
      ),
    )
    return
  }

  printHumanReport(results, cli.quick)
}

main()
