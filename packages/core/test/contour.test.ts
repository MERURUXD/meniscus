import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlassFieldState, GlassPrimitive, Point } from '../src/contracts.ts'
import { extractFieldContourPath, formatRoundedRectPath } from '../src/contour.ts'
import { computeFieldBounds, evaluateFieldDistance } from '../src/sdf.ts'

/** 从 Marching Squares 输出的多边形 SVG 路径（M...L...Z）解析各环路顶点序列。 */
function parsePolygonLoops(path: string): Point[][] {
  if (!path) return []
  const loops: Point[][] = []
  const subpaths = path.match(/M[^Z]*Z/g) ?? []
  for (const sub of subpaths) {
    const tokens = sub.match(/[MLZ]|-?\d+(?:\.\d+)?/g) ?? []
    const pts: Point[] = []
    let i = 0
    while (i < tokens.length) {
      const cmd = tokens[i]
      if (cmd === 'M' || cmd === 'L') {
        const x = Number(tokens[i + 1])
        const y = Number(tokens[i + 2])
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `非法顶点坐标: ${sub}`)
        pts.push({ x, y })
        i += 3
      } else {
        i += 1
      }
    }
    loops.push(pts)
  }
  return loops
}

/** 校验 SVG 路径所有环路均严格闭合且不含 NaN。 */
function assertClosedValidPath(path: string, expectedLoops?: number): void {
  assert.equal(path.includes('NaN'), false, '路径中不得包含 NaN')
  const mCount = (path.match(/M/g) ?? []).length
  const zCount = (path.match(/Z/g) ?? []).length
  assert.equal(mCount, zCount, '每个 M 子路径必须以 Z 闭合')
  if (expectedLoops !== undefined) {
    assert.equal(mCount, expectedLoops, `预期环路数=${expectedLoops}，实际=${mCount}`)
  }
}

test('N=0, 1 与 blendK<=0.001 解析路径输出', () => {
  // N = 0
  assert.equal(extractFieldContourPath({ primitives: [], blendK: 28 }), '')
  assert.equal(
    extractFieldContourPath({
      primitives: [{ center: { x: 10, y: 10 }, size: { width: 0.005, height: 20 }, radius: 4 }],
      blendK: 28,
    }),
    '',
  )

  // N = 1 圆角矩形与直角矩形退化
  const platter: GlassPrimitive = { center: { x: 200, y: 200 }, size: { width: 120, height: 140 }, radius: 22 }
  const singlePath = extractFieldContourPath({ primitives: [platter], blendK: 28 }, { x: 100, y: 80 })
  assert.match(singlePath, /^M62 50/)
  assert.ok(singlePath.includes('A22 22 0 0 1'))
  assertClosedValidPath(singlePath, 1)

  const sharpRect: GlassPrimitive = { center: { x: 50, y: 50 }, size: { width: 40, height: 20 }, radius: 0 }
  assert.equal(formatRoundedRectPath(sharpRect), 'M30 40L70 40L70 60L30 60Z')

  // blendK <= 0.001 拼接多个解析子路径
  const p2: GlassPrimitive = { center: { x: 400, y: 400 }, size: { width: 40, height: 40 }, radius: 12 }
  const unblended = extractFieldContourPath({ primitives: [platter, p2], blendK: 0 })
  assertClosedValidPath(unblended, 2)
  assert.ok(unblended.includes('A22 22 0 0 1'))
  assert.ok(unblended.includes('A12 12 0 0 1'))
})

test('N=2 桥接单环与分离双岛屿（对齐原 Sukimi contour 行为）', () => {
  const platter: GlassPrimitive = { center: { x: 200, y: 200 }, size: { width: 120, height: 140 }, radius: 22 }
  const dropletNear: GlassPrimitive = { center: { x: 200, y: 112 }, size: { width: 44, height: 44 }, radius: 22 }
  const dropletFar: GlassPrimitive = { center: { x: 200, y: 40 }, size: { width: 32, height: 32 }, radius: 16 }

  // 桥接单环
  const bridged = extractFieldContourPath({ primitives: [platter, dropletNear], blendK: 28 }, { x: 100, y: 80 })
  assertClosedValidPath(bridged, 1)
  assert.ok(bridged.includes('L'))

  // 分离双岛屿
  const pinched = extractFieldContourPath({ primitives: [platter, dropletFar], blendK: 28 })
  assertClosedValidPath(pinched, 2)
})

test('N=3, 8, 16 轮廓闭合性、多岛屿支持、零等值面精度与防截断验证', () => {
  // N = 3：两近一远（形成 2 个独立岛屿：一个 2-体融合桥 + 一个孤立圆角胶囊）
  const field3: GlassFieldState = {
    primitives: [
      { center: { x: 100, y: 100 }, size: { width: 80, height: 60 }, radius: 18 },
      { center: { x: 175, y: 100 }, size: { width: 48, height: 48 }, radius: 24 },
      { center: { x: 340, y: 100 }, size: { width: 50, height: 40 }, radius: 16 },
    ],
    blendK: 28,
  }
  const path3 = extractFieldContourPath(field3)
  assertClosedValidPath(path3, 2)

  // N = 8：环形紧邻融合形成单闭环（含中心空洞或实心）
  const primitives8: GlassPrimitive[] = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI * 2) / 8
    return {
      center: { x: 200 + Math.cos(angle) * 52, y: 200 + Math.sin(angle) * 52 },
      size: { width: 44, height: 44 },
      radius: 22,
    }
  })
  const field8: GlassFieldState = { primitives: primitives8, blendK: 28 }
  const path8 = extractFieldContourPath(field8)
  // 外环 + 内孔至少 1~2 个合法闭合环路
  assertClosedValidPath(path8)
  const loops8 = parsePolygonLoops(path8)
  assert.ok(loops8.length >= 1)

  // N = 16：密集聚类 + 大 blendK 防外膨截断检验
  const primitives16: GlassPrimitive[] = Array.from({ length: 16 }, (_, i) => {
    const col = i % 4
    const row = Math.floor(i / 4)
    return {
      center: { x: 100 + col * 58, y: 100 + row * 58 },
      size: { width: 48, height: 48 },
      radius: 16,
    }
  })
  const blendK16 = 40
  const field16: GlassFieldState = { primitives: primitives16, blendK: blendK16 }
  const path16 = extractFieldContourPath(field16)
  assertClosedValidPath(path16, 1)

  const padding16 = Math.min(Math.max(16 - 1, 1), 4) * blendK16 * 0.25 + 4
  const bounds16 = computeFieldBounds(field16, padding16)
  const step16 = Math.max(bounds16.width, bounds16.height) / 128

  const loops16 = parsePolygonLoops(path16)
  assert.equal(loops16.length, 1)
  assert.ok(loops16[0]!.length >= 20)

  let maxIsoError = 0
  for (const pt of loops16[0]!) {
    // 顶点不得触及网格采样外边界（证明未发生外凸截断）
    assert.ok(
      pt.x > bounds16.x + 0.5 &&
        pt.x < bounds16.x + bounds16.width - 0.5 &&
        pt.y > bounds16.y + 0.5 &&
        pt.y < bounds16.y + bounds16.height - 0.5,
      `N=16 轮廓顶点 (${pt.x}, ${pt.y}) 贴近或超出采样边界，疑似被截断`,
    )
    const d = Math.abs(evaluateFieldDistance(pt.x, pt.y, field16))
    if (d > maxIsoError) {
      maxIsoError = d
    }
  }

  // 3 次二分精修 + fmt(0.01) 舍入后，零等值面误差远小于网格步长（step16 ≈ 2.48px）
  assert.ok(
    maxIsoError < step16 * 0.1,
    `零等值面最大误差 ${maxIsoError} 应远小于网格步长 ${step16}`,
  )
})

test('N=3 与 N=8 提取顶点代入 evaluateFieldDistance 零等值面误差验证（含 offset 偏移）', () => {
  const offset: Point = { x: 40, y: 25 }
  const field: GlassFieldState = {
    primitives: [
      { center: { x: 140, y: 120 }, size: { width: 90, height: 50 }, radius: 16 },
      { center: { x: 205, y: 140 }, size: { width: 56, height: 56 }, radius: 28 },
      { center: { x: 170, y: 185 }, size: { width: 70, height: 42 }, radius: 14 },
    ],
    blendK: 24,
  }
  const path = extractFieldContourPath(field, offset)
  assertClosedValidPath(path, 1)

  const bounds = computeFieldBounds(field, 2 * 24 * 0.25 + 4)
  const gridStep = Math.max(bounds.width, bounds.height) / 128
  const loops = parsePolygonLoops(path)

  let maxErr = 0
  for (const pt of loops[0]!) {
    const worldX = pt.x + offset.x
    const worldY = pt.y + offset.y
    const err = Math.abs(evaluateFieldDistance(worldX, worldY, field))
    if (err > maxErr) maxErr = err
  }
  assert.ok(maxErr < gridStep * 0.1, `带 offset 轮廓零等值面最大误差 ${maxErr} 应远小于步长 ${gridStep}`)
})
