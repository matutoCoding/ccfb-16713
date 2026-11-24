// 算法链路验证：退模糊、单体识别、追踪、缺仰角容错
import { generateSyntheticVolume } from '../src/core/synthetic_gen'
import { dealiasVolume } from '../src/core/dealias'
import { decodeVel, MISSING_U8 } from '../src/core/codec'
import { identifyCells, linkTracks } from '../src/core/cell_tracker'
import { computeProducts, fillHoles } from '../src/core/grid_math'
import { beamCartesian } from '../src/core/geometry'
import type { CartesianGrid } from '../src/core/types'

console.log('=== 1. 速度折叠与退模糊 ===')
const { volume } = generateSyntheticVolume({
  kind: 'supercell',
  stationId: 'Z9871',
  baseTimeIso: new Date().toISOString(),
  timeOffsetMin: 0,
  seed: 20260625,
})
// 统计原始速度里接近 Nyquist 的库（折叠高发区）
const nyq = volume.meta.nyquistMps
let nearEdge = 0
let validVel = 0
for (const sweep of volume.sweeps.slice(0, 6)) {
  for (const ray of sweep.rays) {
    for (let g = 0; g < ray.fields.vel.length; g++) {
      const code = ray.fields.vel[g]
      if (code === MISSING_U8) continue
      validVel++
      const v = decodeVel(code)
      if (Math.abs(v) > nyq * 0.85) nearEdge++
    }
  }
}
console.log(`Nyquist=${nyq}m/s，有效速度库 ${validVel}，靠近折叠边缘 ${nearEdge}`)

const t0 = performance.now()
const dealias = dealiasVolume(volume.sweeps, nyq)
console.log(`退模糊耗时 ${(performance.now() - t0).toFixed(0)}ms，折叠订正 ${dealias.foldCount} 处（涡旋物理风速 26m/s > 2*Nyquist，大面积折叠属预期）`)

// 验收看物理合理性：退模糊后速度场连续无大跳变，且恢复出超过 Nyquist 的物理风速
let maxAbs = 0
let discontinuity = 0
let beyondNyq = 0
dealias.correctedVel.forEach((corrected, si) => {
  if (!corrected) return
  const gates = volume.sweeps[si].rays[0].fields.vel.length
  for (let a = 0; a < volume.sweeps[si].rays.length; a++) {
    for (let g = 1; g < gates; g++) {
      const v1 = corrected[a * gates + g]
      const v0 = corrected[a * gates + g - 1]
      if (Number.isNaN(v1) || Number.isNaN(v0)) continue
      maxAbs = Math.max(maxAbs, Math.abs(v1))
      if (Math.abs(v1) > nyq) beyondNyq++
      if (Math.abs(v1 - v0) > nyq * 1.5) discontinuity++
    }
  }
})
console.log(`退模糊后最大风速 ${maxAbs.toFixed(1)}m/s，超 Nyquist 库 ${beyondNyq} 个，残余大跳变 ${discontinuity} 处`)
console.log(`物理连续性 -> ${discontinuity === 0 && maxAbs > nyq * 1.5 ? 'PASS' : 'FAIL'}`)

console.log('\n=== 2. 缺仰角容错 ===')
const broken = generateSyntheticVolume({
  kind: 'broken',
  stationId: 'Z9871',
  baseTimeIso: new Date().toISOString(),
  timeOffsetMin: 0,
  dropElevationIndices: [3, 7, 14],
  seed: 20260625,
})
console.log(`期望 20 层，实际 ${broken.volume.sweeps.length} 层，缺失标记 ${broken.volume.meta.missingElevations.join(',')}°`)
const stillWorks = broken.volume.sweeps.every((s) => s.rays.length === 360)
console.log(`其余仰角射线完整（360 条/层）-> ${stillWorks ? 'PASS' : 'FAIL'}`)

console.log('\n=== 3. 单体识别与跨时刻追踪 ===')
const frames: { timeIso: string; cells: ReturnType<typeof identifyCells> }[] = []
const dxM = 200
for (let i = 0; i < 6; i++) {
  const v = generateSyntheticVolume({
    kind: 'supercell',
    stationId: 'Z9871',
    baseTimeIso: new Date().toISOString(),
    timeOffsetMin: i * 12,
    seed: 20260625 + i,
  }).volume
  // 与生产同规格的 200m 网格重采样
  const extent = 60000
  const nx = Math.round((extent * 2) / dxM)
  const nz = Math.round(15000 / dxM) + 1
  const dbz = new Uint8Array(nx * nx * nz).fill(MISSING_U8)
  const layer = nx * nx
  const gateM = v.meta.rangeM / v.meta.gateCount
  for (const sweep of v.sweeps) {
    for (const ray of sweep.rays) {
      for (let g = 0; g < v.meta.gateCount; g++) {
        const code = ray.fields.dbz[g]
        if (code === MISSING_U8) continue
        const p = beamCartesian((g + 0.5) * gateM, sweep.elevationDeg, ray.azimuthDeg, v.meta.altitudeM)
        if (Math.abs(p.xM) >= extent || Math.abs(p.yM) >= extent || p.zM < 0 || p.zM >= 15000) continue
        const ix = Math.floor((p.xM + extent) / dxM)
        const iy = Math.floor((p.yM + extent) / dxM)
        const iz = Math.floor(p.zM / dxM)
        const idx = iz * layer + iy * nx + ix
        if (dbz[idx] === MISSING_U8 || code > dbz[idx]) dbz[idx] = code
      }
    }
  }
  const grid: CartesianGrid = {
    originXM: -extent, originYM: -extent, originZM: 0,
    dxM, dyM: dxM, dzM: dxM, nx, ny: nx, nz,
    dbz, holeCount: 0, resampleMs: 0,
  }
  fillHoles(grid)
  const products = computeProducts(grid)
  const cells = identifyCells(products.cr)
  frames.push({ timeIso: v.meta.scanTimeIso, cells })
  const main = cells.find((c) => c.maxDbz >= 50)
  console.log(`帧 ${i}：识别单体 ${cells.length} 个，主核 (${main?.xM.toFixed(0)},${main?.yM.toFixed(0)}) ${main?.maxDbz.toFixed(1)}dBZ`)
}
const linked = linkTracks(frames)
console.log(`追踪轨迹 ${linked.tracks.length} 条`)
linked.tracks.forEach((t) => {
  const first = t.points[0]
  const last = t.points[t.points.length - 1]
  const dist = Math.hypot(last.xM - first.xM, last.yM - first.yM) / 1000
  console.log(`  轨迹 #${t.id}：${t.points.length} 帧，移动 ${dist.toFixed(1)} km`)
})
const trackPass = linked.tracks.some((t) => t.points.length >= 4)
console.log(`同一单体跨 4 帧以上连续追踪 -> ${trackPass ? 'PASS' : 'FAIL'}`)
