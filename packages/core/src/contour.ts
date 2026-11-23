/**
 * @meniscus/core 通用 N-图元 SVG 等值线轮廓提取器。
 * 单图元或无融合时直接输出解析圆角矩形路径；多图元平滑融合时通过自适应网格
 * Marching Squares（24..128 网格 + 3 次二分精修 + 鞍点消歧 + 有向边环路串联）
 * 提取零泄漏闭合 SVG 轮廓路径，支持多岛屿分离。
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import type { GlassFieldState, GlassPrimitive, Point } from './contracts.ts'
import { createPreparedField, evaluateFieldDistance, prepareField, type PreparedField } from './sdf.ts'

const MAX_GRID_STEPS = 128
const MIN_GRID_STEPS = 24
const MAX_GRID_NODES = MAX_GRID_STEPS + 1
const MAX_CELLS = MAX_GRID_STEPS * MAX_GRID_STEPS
const MIN_ACTIVE_SIZE = 0.01

// 预分配模块级复用缓冲，避免 60/120fps 形变期间每帧产生 TypedArray 垃圾回收。
const fieldBuf = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const hEdgeX = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const hEdgeY = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const vEdgeX = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)
const vEdgeY = new Float64Array(MAX_GRID_NODES * MAX_GRID_NODES)

// 有向边图唯一边 ID 映射：
// 水平边 (ix, iy) -> id = iy * MAX_GRID_NODES + ix
// 垂直边 (ix, iy) -> id = TOTAL_H + iy * MAX_GRID_NODES + ix
const TOTAL_H = MAX_GRID_NODES * MAX_GRID_NODES
const TOTAL_EDGES = TOTAL_H * 2
const nextEdgeBuf = new Int32Array(TOTAL_EDGES)
const activeEdgeList = new Int32Array(MAX_CELLS * 2)
const visitedBuf = new Uint8Array(TOTAL_EDGES)

// 复用的 SoA 场缓冲与字符串拼接数组
const sharedPreparedField: PreparedField = createPreparedField(16)
const reusableLoopStrings: string[] = []
const reusableLoopParts: string[] = []

const ZERO_POINT: Point = { x: 0, y: 0 }

function fmt(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function isActivePrimitive(shape: GlassPrimitive): boolean {
  return shape.size.width > MIN_ACTIVE_SIZE && shape.size.height > MIN_ACTIVE_SIZE
}

/** 评估轮廓网格点处的场距离，并将严格落于零点邻域的采样微调至内侧，确保所有跨零边均严格在 (0, 1) 内。 */
function evalContourFieldPoint(x: number, y: number, prepared: PreparedField): number {
  const val = evaluateFieldDistance(x, y, prepared)
  return val > -1e-6 && val < 1e-6 ? -1e-6 : val
}

function addSegment(edgeFrom: number, edgeTo: number, activeCount: number): number {
  nextEdgeBuf[edgeFrom] = edgeTo
  activeEdgeList[activeCount] = edgeFrom
  return activeCount + 1
}

/**
 * 将单个圆角矩形图元格式化为解析 SVG 路径（`M...A...Z`），退化圆角时回退为直角矩形，
 * 尺寸无效时返回空串。减去 `offset` 后输出局部坐标。
 */
export function formatRoundedRectPath(
  primitive: GlassPrimitive,
  offset: Point = ZERO_POINT,
): string {
  const w = primitive.size.width
  const h = primitive.size.height
  if (w <= MIN_ACTIVE_SIZE || h <= MIN_ACTIVE_SIZE) {
    return ''
  }

  const x0 = fmt(primitive.center.x - w * 0.5 - offset.x)
  const y0 = fmt(primitive.center.y - h * 0.5 - offset.y)
  const x1 = fmt(x0 + w)
  const y1 = fmt(y0 + h)
  const r = fmt(Math.max(0, Math.min(primitive.radius, w * 0.5, h * 0.5)))

  if (r <= MIN_ACTIVE_SIZE) {
    return `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`
  }

  const xl = fmt(x0 + r)
  const xr = fmt(x1 - r)
  const yt = fmt(y0 + r)
  const yb = fmt(y1 - r)

  const parts: string[] = [`M${xl} ${y0}`]
  if (xr > xl) parts.push(`L${xr} ${y0}`)
  parts.push(`A${r} ${r} 0 0 1 ${x1} ${yt}`)
  if (yb > yt) parts.push(`L${x1} ${yb}`)
  parts.push(`A${r} ${r} 0 0 1 ${xr} ${y1}`)
  if (xr > xl) parts.push(`L${xl} ${y1}`)
  parts.push(`A${r} ${r} 0 0 1 ${x0} ${yb}`)
  if (yb > yt) parts.push(`L${x0} ${yt}`)
  parts.push(`A${r} ${r} 0 0 1 ${xl} ${y0}Z`)
  return parts.join('')
}

/**
 * 提取 N-图元玻璃场的闭合 SVG 等值线路径（零水平集），减去 `offset` 以输出容器局部坐标。
 * - 0 个活跃图元：返回 `''`。
 * - 1 个活跃图元：直接解析输出单个圆角矩形路径。
 * - `blendK <= 0.001`：直接拼接所有活跃图元的解析圆角矩形路径（空格分隔）。
 * - `activeCount >= 2 && blendK > 0.001`：使用自适应 Marching Squares 提取平滑融合/分离轮廓。
 */
export function extractFieldContourPath(
  field: GlassFieldState,
  offset: Point = ZERO_POINT,
): string {
  const prepared = prepareField(field, sharedPreparedField)
  const activeCount = prepared.count

  if (activeCount === 0) {
    return ''
  }

  if (activeCount === 1) {
    const primitives = field.primitives
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i]!
      if (isActivePrimitive(p)) {
        return formatRoundedRectPath(p, offset)
      }
    }
    return ''
  }

  const blendK = field.blendK
  if (blendK <= 0.001) {
    reusableLoopStrings.length = 0
    const primitives = field.primitives
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i]!
      if (isActivePrimitive(p)) {
        const sub = formatRoundedRectPath(p, offset)
        if (sub) {
          reusableLoopStrings.push(sub)
        }
      }
    }
    const result = reusableLoopStrings.join(' ')
    reusableLoopStrings.length = 0
    return result
  }

  // 从 SoA 缓冲直接计算联合包围盒，避免临时 Rect 对象分配
  let minX = prepared.minX[0]!
  let maxX = prepared.maxX[0]!
  let minY = prepared.minY[0]!
  let maxY = prepared.maxY[0]!
  for (let i = 1; i < activeCount; i++) {
    const pMinX = prepared.minX[i]!
    const pMaxX = prepared.maxX[i]!
    const pMinY = prepared.minY[i]!
    const pMaxY = prepared.maxY[i]!
    if (pMinX < minX) minX = pMinX
    if (pMaxX > maxX) maxX = pMaxX
    if (pMinY < minY) minY = pMinY
    if (pMaxY > maxY) maxY = pMaxY
  }

  // 多图元叠加 smin 外膨防截断边距，确保外边界节点全部严格为正并形成完全闭合环路
  const msPadding = Math.min(Math.max(activeCount - 1, 1), 4) * blendK * 0.25 + 4
  const boundsX = minX - msPadding
  const boundsY = minY - msPadding
  const boundsW = maxX - minX + msPadding * 2
  const boundsH = maxY - minY + msPadding * 2

  const longest = boundsW > boundsH ? boundsW : boundsH
  if (longest <= MIN_ACTIVE_SIZE) {
    return ''
  }

  const targetStep = longest / MAX_GRID_STEPS
  const cols = clampInt(Math.ceil(boundsW / targetStep), MIN_GRID_STEPS, MAX_GRID_STEPS)
  const rows = clampInt(Math.ceil(boundsH / targetStep), MIN_GRID_STEPS, MAX_GRID_STEPS)
  const dx = boundsW / cols
  const dy = boundsH / rows
  const stride = cols + 1
  const ox = offset.x
  const oy = offset.y

  // 1. 在 (cols+1) x (rows+1) 自适应网格上采样 SDF 场（复用 SoA + AABB 剪枝）
  for (let iy = 0; iy <= rows; iy++) {
    const y = boundsY + iy * dy
    const rowBase = iy * stride
    for (let ix = 0; ix <= cols; ix++) {
      fieldBuf[rowBase + ix] = evalContourFieldPoint(boundsX + ix * dx, y, prepared)
    }
  }

  // 2. 对水平与垂直跨零边执行 3 次二分迭代精修 + 线性插值求交
  for (let iy = 0; iy <= rows; iy++) {
    const yWorld = boundsY + iy * dy
    const yLocal = yWorld - oy
    const rowBase = iy * stride
    const edgeRowBase = iy * MAX_GRID_NODES
    for (let ix = 0; ix < cols; ix++) {
      const v0 = fieldBuf[rowBase + ix]!
      const v1 = fieldBuf[rowBase + ix + 1]!
      if ((v0 < 0) !== (v1 < 0)) {
        const x0 = boundsX + ix * dx
        let lo = 0
        let hi = 1
        let vLo = v0
        let vHi = v1
        for (let iter = 0; iter < 3; iter++) {
          const mid = 0.5 * (lo + hi)
          const vm = evalContourFieldPoint(x0 + mid * dx, yWorld, prepared)
          if ((vm < 0) === (vLo < 0)) {
            lo = mid
            vLo = vm
          } else {
            hi = mid
            vHi = vm
          }
        }
        const t = lo + (hi - lo) * (vLo / (vLo - vHi))
        const eId = edgeRowBase + ix
        hEdgeX[eId] = x0 + t * dx - ox
        hEdgeY[eId] = yLocal
      }
    }
  }

  for (let iy = 0; iy < rows; iy++) {
    const y0 = boundsY + iy * dy
    const rowBase = iy * stride
    const nextRowBase = (iy + 1) * stride
    const edgeRowBase = iy * MAX_GRID_NODES
    for (let ix = 0; ix <= cols; ix++) {
      const v0 = fieldBuf[rowBase + ix]!
      const v1 = fieldBuf[nextRowBase + ix]!
      if ((v0 < 0) !== (v1 < 0)) {
        const xWorld = boundsX + ix * dx
        let lo = 0
        let hi = 1
        let vLo = v0
        let vHi = v1
        for (let iter = 0; iter < 3; iter++) {
          const mid = 0.5 * (lo + hi)
          const vm = evalContourFieldPoint(xWorld, y0 + mid * dy, prepared)
          if ((vm < 0) === (vLo < 0)) {
            lo = mid
            vLo = vm
          } else {
            hi = mid
            vHi = vm
          }
        }
        const t = lo + (hi - lo) * (vLo / (vLo - vHi))
        const eId = edgeRowBase + ix
        vEdgeX[eId] = xWorld - ox
        vEdgeY[eId] = y0 + t * dy - oy
      }
    }
  }

  // 3. 按单元格构建有向边连接图（Y 轴向下坐标系中沿内部顺时针绕向），对 case 5/10 中心采样消歧
  let segmentCount = 0
  for (let cy = 0; cy < rows; cy++) {
    const r0 = cy * stride
    const r1 = (cy + 1) * stride
    const eRow = cy * MAX_GRID_NODES
    const eNextRow = (cy + 1) * MAX_GRID_NODES

    for (let cx = 0; cx < cols; cx++) {
      const vTL = fieldBuf[r0 + cx]!
      const vTR = fieldBuf[r0 + cx + 1]!
      const vBR = fieldBuf[r1 + cx + 1]!
      const vBL = fieldBuf[r1 + cx]!

      const mask =
        (vTL < 0 ? 8 : 0) |
        (vTR < 0 ? 4 : 0) |
        (vBR < 0 ? 2 : 0) |
        (vBL < 0 ? 1 : 0)

      if (mask === 0 || mask === 15) {
        continue
      }

      const eT = eRow + cx
      const eR = TOTAL_H + eRow + cx + 1
      const eB = eNextRow + cx
      const eL = TOTAL_H + eRow + cx

      switch (mask) {
        case 1:
          segmentCount = addSegment(eL, eB, segmentCount)
          break
        case 2:
          segmentCount = addSegment(eB, eR, segmentCount)
          break
        case 3:
          segmentCount = addSegment(eL, eR, segmentCount)
          break
        case 4:
          segmentCount = addSegment(eR, eT, segmentCount)
          break
        case 5: {
          const centerVal = evalContourFieldPoint(
            boundsX + (cx + 0.5) * dx,
            boundsY + (cy + 0.5) * dy,
            prepared,
          )
          if (centerVal < 0) {
            segmentCount = addSegment(eL, eT, segmentCount)
            segmentCount = addSegment(eR, eB, segmentCount)
          } else {
            segmentCount = addSegment(eR, eT, segmentCount)
            segmentCount = addSegment(eL, eB, segmentCount)
          }
          break
        }
        case 6:
          segmentCount = addSegment(eB, eT, segmentCount)
          break
        case 7:
          segmentCount = addSegment(eL, eT, segmentCount)
          break
        case 8:
          segmentCount = addSegment(eT, eL, segmentCount)
          break
        case 9:
          segmentCount = addSegment(eT, eB, segmentCount)
          break
        case 10: {
          const centerVal = evalContourFieldPoint(
            boundsX + (cx + 0.5) * dx,
            boundsY + (cy + 0.5) * dy,
            prepared,
          )
          if (centerVal < 0) {
            segmentCount = addSegment(eT, eR, segmentCount)
            segmentCount = addSegment(eB, eL, segmentCount)
          } else {
            segmentCount = addSegment(eT, eL, segmentCount)
            segmentCount = addSegment(eB, eR, segmentCount)
          }
          break
        }
        case 11:
          segmentCount = addSegment(eT, eR, segmentCount)
          break
        case 12:
          segmentCount = addSegment(eR, eL, segmentCount)
          break
        case 13:
          segmentCount = addSegment(eR, eB, segmentCount)
          break
        case 14:
          segmentCount = addSegment(eB, eL, segmentCount)
          break
      }
    }
  }

  if (segmentCount === 0) {
    return ''
  }

  for (let i = 0; i < segmentCount; i++) {
    visitedBuf[activeEdgeList[i]!] = 0
  }

  // 4. 沿有向边图串联各独立闭合环路（支持多岛屿与内部孔洞）
  reusableLoopStrings.length = 0
  const maxLoopSteps = segmentCount + 1

  for (let i = 0; i < segmentCount; i++) {
    const startEdge = activeEdgeList[i]!
    if (visitedBuf[startEdge]!) {
      continue
    }

    let cur = startEdge
    let vertexCount = 0
    let lastX = Number.NaN
    let lastY = Number.NaN
    reusableLoopParts.length = 0

    for (let step = 0; step < maxLoopSteps; step++) {
      if (visitedBuf[cur]!) {
        break
      }
      visitedBuf[cur] = 1

      let px: number
      let py: number
      if (cur < TOTAL_H) {
        px = fmt(hEdgeX[cur]!)
        py = fmt(hEdgeY[cur]!)
      } else {
        const vIdx = cur - TOTAL_H
        px = fmt(vEdgeX[vIdx]!)
        py = fmt(vEdgeY[vIdx]!)
      }

      if (vertexCount === 0) {
        reusableLoopParts.push(`M${px} ${py}`)
        lastX = px
        lastY = py
        vertexCount = 1
      } else if (Math.abs(px - lastX) > 0.02 || Math.abs(py - lastY) > 0.02) {
        reusableLoopParts.push(`L${px} ${py}`)
        lastX = px
        lastY = py
        vertexCount++
      }

      cur = nextEdgeBuf[cur]!
      if (cur === startEdge || cur < 0) {
        break
      }
    }

    if (vertexCount >= 3) {
      reusableLoopParts.push('Z')
      reusableLoopStrings.push(reusableLoopParts.join(''))
    }
  }

  const result = reusableLoopStrings.join(' ')
  reusableLoopStrings.length = 0
  reusableLoopParts.length = 0
  return result
}
