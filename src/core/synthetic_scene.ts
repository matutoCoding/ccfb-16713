import { DeterministicRandom, gaussianWeight } from './random'
import type { ClutterMap } from './types'

// 合成场景定义
export type ScenarioKind = 'supercell' | 'squall' | 'mixed' | 'broken'

export interface ScenarioConfig {
  kind: ScenarioKind
  stationId: string
  // 相对基准时间的分钟偏移
  timeOffsetMin: number
  baseTimeIso: string
  // broken 场景下要剔除的仰角序号
  dropElevationIndices?: number[]
  seed: number
}

// 固定的雷达站参数（合成数据约定）
export const SYNTH_STATION = {
  stationId: 'Z9871',
  lat: 30.6586,
  lon: 114.3245,
  altitudeM: 32,
  rangeM: 200000,
  gateCount: 800,
  azimuthCount: 360,
  nyquistMps: 11.5,
  expectedElevations: 20,
}

// 超级单体场景的几何参数（真值与生成共用，保证验收可核对）
export const SUPERCELL_TRUTH = {
  cx: 28000,
  cy: 22000,
  moveDirDeg: 235,
  moveSpeed: 13,
  maxDbz: 62,
}

export const SQUALL_TRUTH = {
  cx: -12000,
  cy: -18000,
  angleDeg: 35,
  lengthM: 90000,
  widthM: 9000,
  maxDbz: 55,
}

// 静态地物杂波：低仰角、近距固定方位的强回波，无垂直结构
export function makeClutterMap(
  stationId: string,
  elevationDeg: number,
  azimuthCount: number,
  gateCount: number,
  seed: number,
): ClutterMap {
  const flags = new Uint8Array(azimuthCount * gateCount)
  if (elevationDeg > 2.5) return { stationId, elevationDeg, gateCount, azimuthCount, flags }
  const rng = new DeterministicRandom(seed + Math.round(elevationDeg * 100))
  // 五片山地/城市地物，方位与距离固定
  const patches = [
    { az: 42, range: 18000, azSpread: 6, rangeSpread: 2500 },
    { az: 118, range: 9000, azSpread: 10, rangeSpread: 1800 },
    { az: 205, range: 26000, azSpread: 5, rangeSpread: 3200 },
    { az: 286, range: 14000, azSpread: 8, rangeSpread: 2000 },
    { az: 333, range: 32000, azSpread: 4, rangeSpread: 2800 },
  ]
  const gateM = SYNTH_STATION.rangeM / gateCount
  for (let az = 0; az < azimuthCount; az++) {
    for (const patch of patches) {
      const azDiff = Math.min(Math.abs(az - patch.az), 360 - Math.abs(az - patch.az))
      if (azDiff > patch.azSpread) continue
      for (let g = 0; g < gateCount; g++) {
        const range = g * gateM
        const w =
          Math.exp(-(azDiff * azDiff) / (2 * (patch.azSpread * 0.5) ** 2)) *
          gaussianWeight(range - patch.range, 0, patch.rangeSpread)
        if (w > 0.25 && rng.next() > 0.15) flags[az * gateCount + g] = 1
      }
    }
  }
  return { stationId, elevationDeg, gateCount, azimuthCount, flags }
}

// 在杂波位置给反射率/速度注入地物特征：反射率强但速度近零、谱宽极小
export function clutterContribution(
  flags: Uint8Array,
  azIndex: number,
  gateIndex: number,
  gateCount: number,
): { dbz: number; vel: number; width: number } | null {
  if (!flags[azIndex * gateCount + gateIndex]) return null
  return { dbz: 48 + Math.sin(gateIndex * 1.7 + azIndex) * 6, vel: 0.4, width: 0.3 }
}

// 合成地形高度场（米），用于三维地形叠加：东南侧山地 + 平缓平原
export function syntheticTerrainHeight(xM: number, yM: number): number {
  const hill1 = 380 * Math.exp(-((xM - 35000) ** 2 + (yM - 40000) ** 2) / (2 * 18000 ** 2))
  const hill2 = 220 * Math.exp(-((xM + 40000) ** 2 + (yM + 15000) ** 2) / (2 * 12000 ** 2))
  const ridge = 140 * Math.exp(-((yM - 52000) ** 2) / (2 * 9000 ** 2)) * Math.exp(-(xM ** 2) / (2 * 55000 ** 2))
  const roll = 12 * Math.sin(xM / 14000) * Math.cos(yM / 11000)
  return Math.max(0, hill1 + hill2 + ridge + roll)
}
