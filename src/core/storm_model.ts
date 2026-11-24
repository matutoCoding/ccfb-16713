import { gaussianWeight, ValueNoise2D, DeterministicRandom } from './random'

// 合成风暴的场采样接口：给定雷达中心笛卡尔位置与高度，返回各场物理量
export interface StormSample {
  dbz: number
  vel: number
  width: number
}

export interface StormModel {
  // x/y 单位米，z 单位米，输出该点气象场；无回波时 dbz 为 NaN
  sample(x: number, y: number, z: number): StormSample
  // 解析意义上的反射率峰值位置，作为合成数据验收真值
  analyticPeak(): { xM: number; yM: number; zM: number; peakDbz: number }
}

interface SupercellParams {
  cx: number
  cy: number
  // 风暴移向（度，气象 convention）与移速 m/s
  moveDirDeg: number
  moveSpeed: number
  maxDbz: number
}

// 超级单体：随高度向东倾斜的悬垂结构 + 低层有界弱回波区 BWER
export class SupercellModel implements StormModel {
  private noise: ValueNoise2D
  private params: SupercellParams

  constructor(seed: number, params: SupercellParams) {
    this.noise = new ValueNoise2D(32, new DeterministicRandom(seed))
    this.params = params
  }

  sample(x: number, y: number, z: number): StormSample {
    const p = this.params
    const zKm = z / 1000
    // 核心轴线随高度顺风暴移动方向倾斜：每公里水平偏移 3.2km 量级
    const tilt = zKm * 3200 * 0.35
    const tiltRad = (p.moveDirDeg * Math.PI) / 180
    const axisX = p.cx + Math.sin(tiltRad) * tilt
    const axisY = p.cy + Math.cos(tiltRad) * tilt

    const dx = x - axisX
    const dy = y - axisY
    const dist = Math.hypot(dx, dy)

    // 反射率垂直廓线：0.5km 起增，4-5km 最强，12km 以上衰减
    const verticalProfile =
      Math.exp(-Math.pow((zKm - 4.5) / 3.2, 2)) * (zKm > 0.3 ? 1 : zKm / 0.3)
    // 低层 BWER：2-4km 高度、核心 1.2km 半径内人为削弱
    const bwer =
      zKm > 1.5 && zKm < 4.2 && dist < 1200
        ? 0.45 + 0.55 * Math.min(1, dist / 1200)
        : 1
    // 水平高斯结构，中层最宽
    const sigma = 2600 + zKm * 220
    const texture = 1 + 0.12 * this.noise.fbm(x / 9000 + 50, y / 9000 + 50, 3)
    const env = gaussianWeight(dx, dy, sigma) * verticalProfile * bwer * texture
    const dbz = env > 0.02 ? -10 + (p.maxDbz + 10) * Math.min(1, env) : NaN

    // 中气旋：切向速度随高度增强，投影到雷达径向
    const tangential = Math.min(24, 26 * (1 - Math.exp(-dist / 1800))) * (0.4 + zKm / 8)
    const vel = Number.isNaN(dbz) ? NaN : this.radialVelocity(x, y, tangential)
    // 谱宽：涡旋边缘与湍流区偏大
    const width = Number.isNaN(dbz)
      ? NaN
      : Math.min(11, 1.5 + 5 * Math.exp(-Math.pow((dist - 2200) / 900, 2)) + 1.5 * (zKm / 14))

    return { dbz, vel: Number.isNaN(dbz) ? NaN : vel, width }
  }

  // 峰值：垂直廓线中心 4.5km 高度处的轴线位置
  analyticPeak(): { xM: number; yM: number; zM: number; peakDbz: number } {
    const p = this.params
    const peakZKm = 4.5
    const tilt = peakZKm * 3200 * 0.35
    const tiltRad = (p.moveDirDeg * Math.PI) / 180
    return {
      xM: p.cx + Math.sin(tiltRad) * tilt,
      yM: p.cy + Math.cos(tiltRad) * tilt,
      zM: peakZKm * 1000,
      peakDbz: p.maxDbz,
    }
  }

  // 中气旋对雷达径向的投影
  private radialVelocity(x: number, y: number, tangential: number): number {
    const p = this.params
    const dx = x - p.cx
    const dy = y - p.cy
    const dist = Math.max(1, Math.hypot(dx, dy))
    // 切向单位矢量（逆时针旋转）
    const tx = -dy / dist
    const ty = dx / dist
    // 雷达径向单位矢量
    const rx = x / Math.max(1, Math.hypot(x, y))
    const ry = y / Math.max(1, Math.hypot(x, y))
    return tangential * (tx * rx + ty * ry) + p.moveSpeed * 0.25 * (rx * Math.sin((p.moveDirDeg * Math.PI) / 180) + ry * Math.cos((p.moveDirDeg * Math.PI) / 180))
  }
}

interface SquallParams {
  // 飑线走向（度）与中心
  angleDeg: number
  cx: number
  cy: number
  lengthM: number
  widthM: number
  maxDbz: number
}

// 飑线：线状对流带，沿线强度起伏，前沿上升后侧层状
export class SquallLineModel implements StormModel {
  private noise: ValueNoise2D
  private params: SquallParams

  constructor(seed: number, params: SquallParams) {
    this.noise = ValueNoise2D.fromSeed(48, seed)
    this.params = params
  }

  sample(x: number, y: number, z: number): StormSample {
    const p = this.params
    const rad = (p.angleDeg * Math.PI) / 180
    // 旋转到沿线条局部坐标：u 沿线，v 垂直于线
    const dx = x - p.cx
    const dy = y - p.cy
    const u = dx * Math.cos(rad) + dy * Math.sin(rad)
    const v = -dx * Math.sin(rad) + dy * Math.cos(rad)
    if (Math.abs(u) > p.lengthM / 2) return { dbz: NaN, vel: NaN, width: NaN }

    const zKm = z / 1000
    const alongProfile = Math.exp(-Math.pow(u / (p.lengthM / 2), 4))
    const acrossProfile = Math.exp(-Math.pow(v / p.widthM, 2))
    const vertical = Math.exp(-Math.pow((zKm - 5) / 3.5, 2)) * (zKm > 0.3 ? 1 : zKm / 0.3)
    const cells = 0.75 + 0.35 * this.noise.fbm(u / 12000 + 10, v / 6000, 3)
    const env = alongProfile * acrossProfile * vertical * cells
    const dbz = env > 0.03 ? -8 + (p.maxDbz + 8) * Math.min(1, env) : NaN

    // 飑线整体向法向移动，径向速度按雷达几何投影
    const moveRad = rad + Math.PI / 2
    const range = Math.max(1, Math.hypot(x, y))
    const radial = Math.cos(moveRad) * (x / range) + Math.sin(moveRad) * (y / range)
    const vel = Number.isNaN(dbz) ? NaN : 14 * radial * (0.5 + zKm / 12)
    const width = Number.isNaN(dbz)
      ? NaN
      : Math.min(9, 1.2 + 3.5 * Math.exp(-Math.pow(Math.abs(v) / p.widthM - 0.7, 2) / 0.1))

    return { dbz, vel, width }
  }

  // 飑线峰值在线条中心、垂直廓线峰值 5km 处
  analyticPeak(): { xM: number; yM: number; zM: number; peakDbz: number } {
    const p = this.params
    return { xM: p.cx, yM: p.cy, zM: 5000, peakDbz: p.maxDbz }
  }
}
