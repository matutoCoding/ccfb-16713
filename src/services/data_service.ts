import { dbEstimateBytes, deleteVolume, listVolumeMeta, saveVolume } from '../core/idb'
import { readRvf, writeRvf } from '../core/rvf_format'
import { generateSyntheticVolume } from '../core/synthetic_gen'
import type { ScenarioKind } from '../core/synthetic_scene'
import type { VolumeMeta } from '../core/types'
import { toast } from '../ui/toast'

// 浏览器内一键合成：生成 -> 序列化 RVF -> 存 IndexedDB
export async function synthesizeAndStore(
  kind: ScenarioKind,
  baseTimeIso: string,
  count: number,
): Promise<number> {
  let stored = 0
  for (let i = 0; i < count; i++) {
    const offsetMin = (i - count + 1) * 6
    const drop =
      kind === 'broken' && i === count - 1 ? [3, 7, 14] : undefined
    const { volume } = generateSyntheticVolume({
      kind,
      stationId: 'Z9871',
      baseTimeIso,
      timeOffsetMin: offsetMin,
      dropElevationIndices: drop,
      seed: 20260625 + i * 101,
    })
    const buf = writeRvf(volume)
    const id = `${volume.meta.stationId}-${volume.meta.scanTimeIso}`
    volume.meta.id = id
    volume.meta.sizeBytes = buf.byteLength
    await saveVolume(id, buf, volume.meta)
    stored++
  }
  return stored
}

export async function importRvfFile(file: File): Promise<VolumeMeta> {
  const buf = await file.arrayBuffer()
  const volume = readRvf(buf)
  const id = `${volume.meta.stationId}-${volume.meta.scanTimeIso}-${Date.now()}`
  volume.meta.id = id
  volume.meta.sizeBytes = buf.byteLength
  await saveVolume(id, buf, volume.meta)
  if (volume.meta.missingElevations.length > 0) {
    toast(
      `文件缺少 ${volume.meta.missingElevations.length} 个仰角：${volume.meta.missingElevations.join('、')}°，其余仰角已正常导入`,
      'error',
      6000,
    )
  } else {
    toast(`体扫导入成功：${file.name}`, 'success')
  }
  return volume.meta
}

export async function refreshList(): Promise<VolumeMeta[]> {
  const list = await listVolumeMeta()
  // 按站号 + 时间排序
  return list.sort((a, b) => {
    if (a.stationId !== b.stationId) return a.stationId.localeCompare(b.stationId)
    return a.scanTimeIso.localeCompare(b.scanTimeIso)
  })
}

export async function removeVolume(id: string): Promise<void> {
  await deleteVolume(id)
  toast('体扫已删除', 'info')
}

export async function storageUsageText(): Promise<string> {
  const bytes = await dbEstimateBytes()
  if (bytes <= 0) return '浏览器未提供存储统计'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
