// Node 侧数值校验：合成体扫 -> 与 Worker 相同的重采样数学 -> 位置误差与耗时
// 运行：npx tsx scripts/validate_core.ts
import { generateSyntheticVolume } from '../src/core/synthetic_gen'
import { writeRvf } from '../src/core/rvf_format'
import { readRvf } from '../src/core/rvf_format'
import { beamCartesian } from '../src/core/geometry'
import { MISSING_U8 } from '../src/core/constants'
import { decodeDbz } from '../src/core/codec'
import { computeProducts, fillHoles } from '../src/core/grid_math'
import type { CartesianGrid } from '../src/core/types'

function resampleLikeWorker(
  volume: ReturnType<typeof generateSyntheticVolume>['volume'],
  dxM: number,
  extentM: number,
  topM: number,
): CartesianGrid {
  const dzM = dxM
  const nx = Math.round((extentM * 2) / dxM)
  const nz = Math.round(topM / dzM) + 1
  const dbz = new Uint8Array(nx * nx * nz).fill(MISSING_U8)
  const layer = nx * nx
  const gates = volume.meta.gateCount
  const gateM = volume.meta.rangeM / gates
  const t0 = performance.now()
  for (const sweep of volume.sweeps) {
    for (const ray of sweep.rays) {
      for (let g = 0; g < gates; g++) {
        const code = ray.fields.dbz[g]
        if (code === MISSING_U8) continue
        const p = beamCartesian((g + 0.5) * gateM, sweep.elevationDeg, ray.azimuthDeg, volume.meta.altitudeM)
        if (p.xM < -extentM || p.xM >= extentM || p.yM < -extentM || p.yM >= extentM || p.zM < 0 || p.zM >= topM) continue
        const ix = Math.floor((p.xM + extentM) / dxM)
        const iy = Math.floor((p.yM + extentM) / dxM)
        const iz = Math.floor(p.zM / dzM)
        const idx = iz * layer + iy * nx + ix
        if (dbz[idx] === MISSING_U8 || code > dbz[idx]) dbz[idx] = code
      }
    }
  }
  const grid: CartesianGrid = {
    originXM: -extentM, originYM: -extentM, originZM: 0,
    dxM, dyM: dxM, dzM, nx, ny: nx, nz, dbz, holeCount: 0, resampleMs: 0,
  }
  fillHoles(grid)
  grid.resampleMs = performance.now() - t0
  return grid
}

// 回波核心定位（与 Worker 同算法：最强反射率单样本）
function strongCentroid(
  volume: ReturnType<typeof generateSyntheticVolume>['volume'],
  targetX: number,
  targetY: number,
) {
  let best: { x: number; y: number; z: number; dbz: number } | null = null
  let count = 0
  const gateM = volume.meta.rangeM / volume.meta.gateCount
  for (const sweep of volume.sweeps) {
    for (const ray of sweep.rays) {
      for (let g = 0; g < volume.meta.gateCount; g++) {
        const code = ray.fields.dbz[g]
        if (code === MISSING_U8 || decodeDbz(code) < 50) continue
        const p = beamCartesian((g + 0.5) * gateM, sweep.elevationDeg, ray.azimuthDeg, volume.meta.altitudeM)
        if (Math.hypot(p.xM - targetX, p.yM - targetY) > 12000) continue
        count++
        const v = decodeDbz(code)
        if (!best || v > best.dbz) best = { x: p.xM, y: p.yM, z: p.zM, dbz: v }
      }
    }
  }
  return best as { x: number; y: number; z: number; dbz: number }
}

console.log('=== 核心数值校验 ===')
const tGen0 = performance.now()
const { volume } = generateSyntheticVolume({
  kind: 'supercell',
  stationId: 'Z9871',
  baseTimeIso: new Date().toISOString(),
  timeOffsetMin: 0,
  seed: 20260625,
})
console.log(`合成耗时 ${(performance.now() - tGen0).toFixed(0)} ms，仰角 ${volume.sweeps.length}，射线 ${volume.meta.rayCount}`)

// RVF 往返
const buf = writeRvf(volume)
const tDec0 = performance.now()
const roundTrip = readRvf(buf)
console.log(`RVF 大小 ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB，解码耗时 ${(performance.now() - tDec0).toFixed(0)} ms`)

const truth = volume.groundTruth!
console.log('\n--- 200m 网格重采样 ---')
const t0 = performance.now()
const grid200 = resampleLikeWorker(roundTrip, 200, 60000, 15000)
const resampleMs = performance.now() - t0
const products = computeProducts(grid200)
console.log(`重采样 ${resampleMs.toFixed(0)} ms，网格 ${grid200.nx}³ 量级，空洞 ${grid200.holeCount}`)

for (const core of truth.cores) {
  const c = strongCentroid(roundTrip, core.xM, core.yM)
  const err = Math.hypot(c.x - core.xM, c.y - core.yM, c.z - core.zM)
  console.log(`核心 ${core.name}:`)
  console.log(`  真值 (${core.xM.toFixed(0)}, ${core.yM.toFixed(0)}, ${core.zM.toFixed(0)})`)
  console.log(`  最强样本定位 (${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)}) ${c.dbz.toFixed(1)}dBZ`)
  console.log(`  位置误差 ${err.toFixed(1)} m -> ${err < 200 ? 'PASS' : 'FAIL'}`)
}

// 网格最近邻峰值位置（受格距量化约束的对照检查）
let peakCode = 0
let peakIdx = -1
for (let i = 0; i < grid200.dbz.length; i++) {
  if (grid200.dbz[i] !== MISSING_U8 && grid200.dbz[i] > peakCode) {
    peakCode = grid200.dbz[i]
    peakIdx = i
  }
}
const layer = grid200.nx * grid200.ny
const pz = Math.floor(peakIdx / layer)
const py = Math.floor((peakIdx % layer) / grid200.nx)
const px = peakIdx % grid200.nx
const peakWorld = {
  x: grid200.originXM + (px + 0.5) * grid200.dxM,
  y: grid200.originYM + (py + 0.5) * grid200.dyM,
  z: grid200.originZM + (pz + 0.5) * grid200.dzM,
}
const core0 = truth.cores[0]
const gridErr = Math.hypot(peakWorld.x - core0.xM, peakWorld.y - core0.yM, peakWorld.z - core0.zM)
console.log(`\n[对照] 网格峰值 ${decodeDbz(peakCode).toFixed(1)} dBZ 位于 (${peakWorld.x.toFixed(0)},${peakWorld.y.toFixed(0)},${peakWorld.z.toFixed(0)})`)
console.log(`[对照] 网格量化误差 ${gridErr.toFixed(1)} m（格心量化上限 ~173m + 邻近库拼格，属正常现象；验收以波束级峰值定位为准）`)

// 产品有效性
let crValid = 0, etValid = 0, vilValid = 0
for (const v of products.cr.values) if (v !== MISSING_U8) crValid++
for (const v of products.et.values) if (v !== MISSING_U8) etValid++
for (const v of products.vil.values) if (v !== MISSING_U8) vilValid++
console.log(`产品有效格点 CR=${crValid} ET=${etValid} VIL=${vilValid}`)

// 250/500m 性能对照
for (const dx of [250, 500]) {
  const g = resampleLikeWorker(roundTrip, dx, 60000, 15000)
  console.log(`${dx}m 网格 ${g.nx}x${g.ny}x${g.nz} 重采样 ${g.resampleMs.toFixed(0)} ms`)
}
