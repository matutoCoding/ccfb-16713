import { EFFECTIVE_EARTH_RADIUS_M } from './constants'

const DEG2RAD = Math.PI / 180

// 波束中心几何：输入斜距、仰角（度），输出海拔高度与地面大圆距离
// 考虑 4/3 等效地球半径的标准大气折射与地球曲率
export function beamPosition(
  slantRangeM: number,
  elevationDeg: number,
  radarAltitudeM: number,
): { groundRangeM: number; altitudeM: number } {
  const el = elevationDeg * DEG2RAD
  const sinEl = Math.sin(el)
  const cosEl = Math.cos(el)
  const r = slantRangeM
  const Re = EFFECTIVE_EARTH_RADIUS_M

  const groundRangeM =
    Re * Math.asin((r * cosEl) / (Re + radarAltitudeM + r * sinEl))

  // 波束中心海拔（相对海平面），雷达海拔由调用方按需叠加
  const altitudeM = Math.sqrt(r * r + Re * Re + 2 * Re * r * sinEl) - Re

  return { groundRangeM, altitudeM }
}

// 给定斜距、仰角、方位，输出雷达中心笛卡尔坐标（x 东、y 北、z 上，单位米）
export function beamCartesian(
  slantRangeM: number,
  elevationDeg: number,
  azimuthDeg: number,
  radarAltitudeM: number,
): { xM: number; yM: number; zM: number } {
  const { groundRangeM, altitudeM } = beamPosition(
    slantRangeM,
    elevationDeg,
    radarAltitudeM,
  )
  const az = azimuthDeg * DEG2RAD
  return {
    xM: groundRangeM * Math.sin(az),
    yM: groundRangeM * Math.cos(az),
    zM: altitudeM + radarAltitudeM,
  }
}

// 由水平距离与仰角反解斜距，固定点迭代两次，曲率补偿后误差可忽略
export function slantFromGroundRange(
  groundRangeM: number,
  elevationDeg: number,
): number {
  const el = elevationDeg * DEG2RAD
  let range = groundRangeM / Math.cos(el)
  for (let i = 0; i < 2; i++) {
    const p = beamPosition(range, elevationDeg, 0)
    range += (groundRangeM - p.groundRangeM) / Math.max(0.2, Math.cos(el))
  }
  return range
}

// 角度差，归一化到 [-180, 180]
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

export const deg2rad = (deg: number): number => deg * DEG2RAD
export const rad2deg = (rad: number): number => rad / DEG2RAD
