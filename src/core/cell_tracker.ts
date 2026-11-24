import { CELL_DBZ_THRESHOLD, MISSING_U8 } from './constants'
import { decodeDbz } from './codec'
import type { ProductGrid, StormCell } from './types'

// 在组合反射率产品上做连通域分割，输出风暴单体
// 4 邻域洪水填充，阈值 45dBZ，过滤面积小于 8 格点的碎块
export function identifyCells(cr: ProductGrid): StormCell[] {
  const { nx, ny, values } = cr
  const labels = new Int32Array(nx * ny).fill(-1)
  const cells: StormCell[] = []
  let nextId = 1

  const stack: number[] = []
  for (let start = 0; start < values.length; start++) {
    if (labels[start] !== -1 || values[start] === MISSING_U8) continue
    if (decodeDbz(values[start]) < CELL_DBZ_THRESHOLD) continue

    const id = nextId++
    let sumX = 0
    let sumY = 0
    let count = 0
    let maxDbz = -999
    stack.length = 0
    stack.push(start)
    labels[start] = id

    while (stack.length) {
      const idx = stack.pop() as number
      const x = idx % nx
      const y = Math.floor(idx / nx)
      labels[idx] = id
      const v = decodeDbz(values[idx])
      if (v > maxDbz) maxDbz = v
      sumX += x
      sumY += y
      count++
      // 4 邻域
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < nx - 1 ? idx + 1 : -1,
        y > 0 ? idx - nx : -1,
        y < ny - 1 ? idx + nx : -1,
      ]
      for (const nb of neighbors) {
        if (nb < 0 || labels[nb] !== -1 || values[nb] === MISSING_U8) continue
        if (decodeDbz(values[nb]) < CELL_DBZ_THRESHOLD) continue
        labels[nb] = id
        stack.push(nb)
      }
    }

    if (count < 8) continue
    const cellSizeM = cr.dxM
    const areaKm2 = (count * cellSizeM * cellSizeM) / 1e6
    // 物理面积门槛 4km²，过滤对流核边缘碎块，避免 200m 网格下碎块误判为单体
    if (areaKm2 < 4) continue
    cells.push({
      id: 0, // 由追踪阶段编号
      xM: cr.originXM + (sumX / count + 0.5) * cellSizeM,
      yM: cr.originYM + (sumY / count + 0.5) * cellSizeM,
      zTopM: 0,
      areaKm2,
      maxDbz,
      vil: 0,
    })
  }
  return cells
}

// 最近邻匹配跨时刻单体，生成轨迹；匹配窗口 15km，取距离最小且未占用者
export function linkTracks(
  frames: { timeIso: string; cells: StormCell[] }[],
  maxLinkM = 15000,
): { tracks: import('./types').CellTrack[]; labeledFrames: StormCell[][] } {
  const tracks: import('./types').CellTrack[] = []
  const labeledFrames: StormCell[][] = []
  let trackSeq = 1
  let prevCenters: { id: number; xM: number; yM: number }[] = []

  frames.forEach((frame) => {
    const used = new Set<number>()
    const matchedId = new Map<number, number>()
    const candidates = frame.cells.map((c, ci) => ({ c, ci }))

    // 按与上一时刻各中心的最小距离排序，优先匹配确定性高的对
    const pairs = candidates
      .map(({ c, ci }) => {
        let best = Infinity
        let bestId = -1
        for (const p of prevCenters) {
          const d = Math.hypot(c.xM - p.xM, c.yM - p.yM)
          if (d < best) {
            best = d
            bestId = p.id
          }
        }
        return { ci, bestId, dist: best }
      })
      .sort((a, b) => a.dist - b.dist)

    for (const pair of pairs) {
      if (pair.dist > maxLinkM || pair.bestId < 0 || used.has(pair.bestId)) {
        const newId = trackSeq++
        matchedId.set(pair.ci, newId)
        tracks.push({ id: newId, points: [] })
        continue
      }
      used.add(pair.bestId)
      matchedId.set(pair.ci, pair.bestId)
    }

    const labeled = frame.cells.map((c, ci) => {
      const id = matchedId.get(ci) as number
      const labeledCell: StormCell = { ...c, id }
      const track = tracks.find((t) => t.id === id)
      track?.points.push({ timeIso: frame.timeIso, xM: c.xM, yM: c.yM })
      return labeledCell
    })
    labeledFrames.push(labeled)
    prevCenters = labeled.map((c) => ({ id: c.id, xM: c.xM, yM: c.yM }))
  })

  return { tracks: tracks.filter((t) => t.points.length > 0), labeledFrames }
}
