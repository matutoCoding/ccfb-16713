import { loadVolumeBytes } from '../core/idb'
import { readRvf } from '../core/rvf_format'
import type { ClutterMap, ProcessedVolume, RadarVolume } from '../core/types'
import ResampleWorker from '../workers/resample_worker?worker'
import type { ResampleRequest, ResampleResponse } from '../workers/resample_worker'

export interface PipelineTiming {
  importMs: number
  decodeMs: number
  resampleMs: number
  totalMs: number
}

interface CacheEntry {
  processed: ProcessedVolume
  timing: PipelineTiming
}

// 已处理体扫的内存缓存，动画回放时复用
const cache = new Map<string, CacheEntry>()
const MAX_CACHE = 16

export function getCached(volumeId: string): CacheEntry | undefined {
  return cache.get(volumeId)
}

export function clearPipelineCache(): void {
  cache.clear()
}

// 从 IndexedDB 取字节 -> 解码 -> Worker 重采样与产品，全程计时
export async function runPipeline(
  volumeId: string,
  clutterMaps: ClutterMap[],
  options: {
    clutterFilterEnabled: boolean
    dxM: number
    extentM?: number
    topM?: number
  },
): Promise<{ processed: ProcessedVolume; timing: PipelineTiming; volume: RadarVolume }> {
  const t0 = performance.now()
  const bytes = await loadVolumeBytes(volumeId)
  if (!bytes) throw new Error('IndexedDB 中找不到该体扫数据')
  const tImport = performance.now()
  const volume = readRvf(bytes)
  volume.meta.id = volumeId
  const tDecode = performance.now()

  const worker = new ResampleWorker()
  const req: ResampleRequest = {
    volume,
    clutterMaps,
    clutterFilterEnabled: options.clutterFilterEnabled,
    dxM: options.dxM,
    extentM: options.extentM ?? 60000,
    topM: options.topM ?? 15000,
  }

  const processed = await new Promise<ProcessedVolume>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<ResampleResponse>) => {
      worker.terminate()
      if (ev.data.type === 'done') resolve(ev.data.result)
      else reject(new Error(ev.data.message))
    }
    worker.onerror = (e: ErrorEvent) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage(req)
  })

  const tEnd = performance.now()
  const timing: PipelineTiming = {
    importMs: tImport - t0,
    decodeMs: tDecode - tImport,
    resampleMs: processed.totalMs,
    totalMs: tEnd - t0,
  }
  const entry: CacheEntry = { processed, timing }
  cache.set(volumeId, entry)
  if (cache.size > MAX_CACHE) {
    const firstKey = cache.keys().next().value
    if (firstKey) cache.delete(firstKey)
  }
  return { processed, timing, volume }
}
