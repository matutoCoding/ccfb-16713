import {
  DBZ_COLOR_LEVELS,
  MISSING_U8,
  VEL_COLOR_LEVELS,
  WIDTH_COLOR_LEVELS,
} from '../core/constants'
import { decodeDbz, decodeVel, decodeWidth } from '../core/codec'
import type { FieldType, RadarVolume } from '../core/types'

// 真正的 RHI：沿指定方位抽取全部仰角射线，映射到 距离-高度 平面
// 输出离屏 Canvas，页面直接 drawImage
export class RhiRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  constructor() {
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
  }

  get element(): HTMLCanvasElement {
    return this.canvas
  }

  render(
    volume: RadarVolume,
    azimuthDeg: number,
    field: FieldType,
    width: number,
    height: number,
    maxRangeM: number,
    maxHeightM = 16000,
  ): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#05080f'
    ctx.fillRect(0, 0, width, height)

    const levels =
      field === 'dbz'
        ? DBZ_COLOR_LEVELS
        : field === 'vel'
          ? VEL_COLOR_LEVELS
          : WIDTH_COLOR_LEVELS
    const decode = field === 'dbz' ? decodeDbz : field === 'vel' ? decodeVel : decodeWidth
    const gateM = volume.meta.rangeM / volume.meta.gateCount
    const padL = 44
    const padB = 28
    const padT = 12
    const padR = 12
    const plotW = width - padL - padR
    const plotH = height - padB - padT

    const xOf = (rangeM: number): number => padL + (rangeM / maxRangeM) * plotW
    const yOf = (z: number): number => padT + plotH - (z / maxHeightM) * plotH

    // 逐仰角、逐库绘制矩形单元，相邻仰角间垂直方向留缝由后层覆盖
    for (const sweep of volume.sweeps) {
      const ray = pickRay(sweep, azimuthDeg)
      if (!ray) continue
      const arr = ray.fields[field]
      for (let g = 0; g < arr.length; g++) {
        const code = arr[g]
        if (code === MISSING_U8) continue
        const value = decode(code)
        if (!Number.isFinite(value)) continue
        const range = (g + 0.5) * gateM
        if (range > maxRangeM) continue
        const z = beamHeightM(volume, sweep.elevationDeg, range)
        if (z > maxHeightM) continue
        const color = colorForValue(levels, value)
        const x = xOf(g * gateM)
        const w = xOf((g + 1) * gateM) - x + 1
        const y = yOf(z)
        ctx.fillStyle = color
        ctx.fillRect(x, y, Math.max(2, w), 3)
      }
    }

    // 高度/距离网格与刻度
    ctx.strokeStyle = 'rgba(148,163,184,0.35)'
    ctx.fillStyle = 'rgba(203,213,225,0.85)'
    ctx.font = '11px sans-serif'
    ctx.lineWidth = 1
    for (let km = 0; km <= maxRangeM / 1000; km += 10) {
      const x = xOf(km * 1000)
      ctx.beginPath()
      ctx.moveTo(x, padT)
      ctx.lineTo(x, padT + plotH)
      ctx.stroke()
      ctx.fillText(`${km}`, x - 6, padT + plotH + 16)
    }
    for (let km = 0; km <= maxHeightM / 1000; km += 2) {
      const y = yOf(km * 1000)
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.fillText(`${km}km`, 6, y + 4)
    }
    ctx.fillStyle = 'rgba(203,213,225,0.9)'
    ctx.fillText('距离 (km)', padL + plotW / 2 - 24, height - 6)
    ctx.save()
    ctx.translate(14, padT + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('高度', -14, 0)
    ctx.restore()
  }

  dispose(): void {
    this.canvas.remove()
  }
}

function pickRay(sweep: RadarVolume['sweeps'][number], azimuthDeg: number) {
  let best = sweep.rays[0]
  let bestDiff = 360
  for (const ray of sweep.rays) {
    let d = Math.abs(ray.azimuthDeg - azimuthDeg)
    d = Math.min(d, 360 - d)
    if (d < bestDiff) {
      bestDiff = d
      best = ray
    }
  }
  return best
}

function beamHeightM(volume: RadarVolume, elevationDeg: number, rangeM: number): number {
  // 与 geometry 一致的 4/3 地球近似，避免 RHI 与三维视图高度不一致
  const Re = 8494666.6667
  const el = (elevationDeg * Math.PI) / 180
  const h = Math.sqrt(rangeM * rangeM + Re * Re + 2 * Re * rangeM * Math.sin(el)) - Re
  return h + volume.meta.altitudeM
}

function colorForValue(
  levels: readonly { value: number; color: readonly number[] }[],
  value: number,
): string {
  let lo = levels[0]
  let hi = levels[levels.length - 1]
  for (let i = 0; i < levels.length - 1; i++) {
    if (value >= levels[i].value && value <= levels[i + 1].value) {
      lo = levels[i]
      hi = levels[i + 1]
      break
    }
  }
  const t = hi.value === lo.value ? 0 : (value - lo.value) / (hi.value - lo.value)
  const r = Math.round(lo.color[0] + (hi.color[0] - lo.color[0]) * t)
  const g = Math.round(lo.color[1] + (hi.color[1] - lo.color[1]) * t)
  const b = Math.round(lo.color[2] + (hi.color[2] - lo.color[2]) * t)
  return `rgb(${r},${g},${b})`
}
