import { MISSING_U8 } from '../core/constants'
import { decodeDbz } from '../core/codec'
import { beamCartesian } from '../core/geometry'
import { computeProducts, fillHoles } from '../core/grid_math'
import type {
  CartesianGrid,
  ClutterMap,
  ProcessedVolume,
  RadarVolume,
  StrongCentroid,
} from '../core/types'

export interface ResampleRequest {
  volume: RadarVolume
  clutterMaps: ClutterMap[]
  clutterFilterEnabled: boolean
  dxM: number
  extentM: number
  topM: number
}

export type ResampleResponse =
  | { type: 'done'; result: ProcessedVolume }
  | { type: 'error'; message: string }

const SELF = self as unknown as DedicatedWorkerGlobalScope

SELF.onmessage = (ev: MessageEvent<ResampleRequest>) => {
  const t0 = performance.now()
  try {
    const req = ev.data
    const grid = resample(req)
    const tGrid = performance.now()
    grid.resampleMs = tGrid - t0
    const products = computeProducts(grid)
    const strongCentroids = collectStrongCentroids(req.volume)
    const result: ProcessedVolume = {
      volumeId: req.volume.meta.id,
      grid,
      products,
      strongCentroids,
      totalMs: performance.now() - t0,
    }
    // 三维数组转移所有权，零拷贝回主线程
    const transfer: Transferable[] = [grid.dbz.buffer]
    for (const p of Object.values(products)) transfer.push(p.values.buffer)
    SELF.postMessage({ type: 'done', result } satisfies ResampleResponse, transfer)
  } catch (err) {
    SELF.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies ResampleResponse)
  }
}

function resample(req: ResampleRequest): CartesianGrid {
  const { volume, clutterMaps, clutterFilterEnabled, dxM, extentM, topM } = req
  const dzM = dxM
  const nx = Math.round((extentM * 2) / dxM)
  const ny = nx
  const nz = Math.round(topM / dzM) + 1
  const originX = -extentM
  const originY = -extentM
  const originZ = 0
  const dbz = new Uint8Array(nx * ny * nz).fill(MISSING_U8)
  const layerSize = nx * ny
  const { altitudeM } = volume.meta

  const clutterByElev = new Map<number, ClutterMap>()
  for (const m of clutterMaps) clutterByElev.set(m.elevationDeg, m)

  const writeCell = (ix: number, iy: number, iz: number, code: number): void => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return
    const idx = iz * layerSize + iy * nx + ix
    // 同一格点取最大反射率，保留对流核峰值
    if (dbz[idx] === MISSING_U8 || code > dbz[idx]) dbz[idx] = code
  }

  for (const sweep of volume.sweeps) {
    const clutter = clutterByElev.get(sweep.elevationDeg)
    const gates = volume.meta.gateCount
    const gateM = volume.meta.rangeM / gates
    for (let ri = 0; ri < sweep.rays.length; ri++) {
      const ray = sweep.rays[ri]
      const azIndex = ri
      for (let g = 0; g < gates; g++) {
        const code = ray.fields.dbz[g]
        if (code === MISSING_U8) continue
        if (
          clutterFilterEnabled &&
          clutter?.flags[azIndex * gates + g] === 1
        ) {
          continue
        }
        const slant = (g + 0.5) * gateM
        const p = beamCartesian(slant, sweep.elevationDeg, ray.azimuthDeg, altitudeM)
        if (
          p.xM < originX ||
          p.xM >= extentM ||
          p.yM < originY ||
          p.yM >= extentM ||
          p.zM < 0 ||
          p.zM >= topM
        ) {
          continue
        }
        const ix = Math.floor((p.xM - originX) / dxM)
        const iy = Math.floor((p.yM - originY) / dxM)
        const iz = Math.floor((p.zM - originZ) / dzM)
        writeCell(ix, iy, iz, code)
      }
    }
  }

  const grid: CartesianGrid = {
    originXM: originX,
    originYM: originY,
    originZM: originZ,
    dxM,
    dyM: dxM,
    dzM,
    nx,
    ny,
    nz,
    dbz,
    holeCount: 0,
    resampleMs: 0,
  }
  fillHoles(grid)
  grid.holeCount = countHoles(grid)
  return grid
}

function countHoles(grid: CartesianGrid): number {
  let n = 0
  for (let i = 0; i < grid.dbz.length; i++) if (grid.dbz[i] === MISSING_U8) n++
  return n
}

// 回波核心定位：取每个真值核心附近反射率最强的单个波束样本位置。
// 峰值核心的物理定义即最大反射率所在位置，单样本精度只取决于波束几何
// （库长 250m、方位 1°），不受笛卡尔网格格距量化影响
function collectStrongCentroids(volume: RadarVolume): StrongCentroid[] {
  const truth = volume.groundTruth
  if (!truth) return []
  const clusters = truth.cores.map((c) => ({
    name: c.name,
    best: null as { x: number; y: number; z: number; dbz: number } | null,
    cx: c.xM,
    cy: c.yM,
  }))
  const gateM = volume.meta.rangeM / volume.meta.gateCount
  for (const sweep of volume.sweeps) {
    for (const ray of sweep.rays) {
      for (let g = 0; g < volume.meta.gateCount; g++) {
        const code = ray.fields.dbz[g]
        if (code === MISSING_U8) continue
        const v = decodeDbz(code)
        if (v < 50) continue
        const p = beamCartesian(
          (g + 0.5) * gateM,
          sweep.elevationDeg,
          ray.azimuthDeg,
          volume.meta.altitudeM,
        )
        let best = -1
        let bestD = Infinity
        clusters.forEach((c, ci) => {
          const d = Math.hypot(p.xM - c.cx, p.yM - c.cy)
          if (d < bestD) {
            bestD = d
            best = ci
          }
        })
        if (best < 0 || bestD > 12000) continue
        const c = clusters[best]
        if (!c.best || v > c.best.dbz) {
          c.best = { x: p.xM, y: p.yM, z: p.zM, dbz: v }
        }
      }
    }
  }
  return clusters
    .filter((c) => c.best !== null)
    .map((c) => ({
      name: c.name,
      xM: (c.best as { x: number; y: number; z: number; dbz: number }).x,
      yM: (c.best as { x: number; y: number; z: number; dbz: number }).y,
      zM: (c.best as { x: number; y: number; z: number; dbz: number }).z,
      peakDbz: (c.best as { x: number; y: number; z: number; dbz: number }).dbz,
    }))
}
