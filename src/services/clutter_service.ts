import { makeClutterMap, SYNTH_STATION } from '../core/synthetic_scene'
import { STANDARD_ELEVATIONS_20 } from '../core/rvf_format'
import type { ClutterMap } from '../core/types'

// 合成站的静态杂波图按仰角惰性生成并内存缓存
const mapCache = new Map<number, ClutterMap>()

export function getSyntheticClutterMaps(seed = 20260625): ClutterMap[] {
  return STANDARD_ELEVATIONS_20.map((elevationDeg) => {
    const cached = mapCache.get(elevationDeg)
    if (cached) return cached
    const map = makeClutterMap(
      SYNTH_STATION.stationId,
      elevationDeg,
      SYNTH_STATION.azimuthCount,
      SYNTH_STATION.gateCount,
      seed,
    )
    mapCache.set(elevationDeg, map)
    return map
  })
}

// 低仰角（<=1.5 度）杂波图用于 PPI 过滤
export function getLowElevationClutter(seed = 20260625): ClutterMap[] {
  return getSyntheticClutterMaps(seed).filter((m) => m.elevationDeg <= 1.5)
}
