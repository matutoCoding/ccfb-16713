import { loadVolumeBytes } from '../core/idb'
import { readRvf } from '../core/rvf_format'
import type { RadarVolume } from '../core/types'

// 从 IndexedDB 读完整体扫（页面级使用，区别于 pipeline 的 Worker 路径）
export async function loadVolume(volumeId: string): Promise<RadarVolume> {
  const bytes = await loadVolumeBytes(volumeId)
  if (!bytes) throw new Error('体扫数据不存在，请先在数据管理页导入或合成')
  const volume = readRvf(bytes)
  volume.meta.id = volumeId
  return volume
}

// 画布按设备像素比调整，保证清晰
export function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(64, Math.round(rect.width * dpr))
  const height = Math.max(64, Math.round(rect.height * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  return { width, height }
}
