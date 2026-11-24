import { RVF_HEADER_BYTES, RVF_MAGIC, RVF_VERSION } from './constants'
import type { FieldType, RadarRay, RadarVolume, Sweep, VolumeMeta } from './types'

const FIELD_TYPES: FieldType[] = ['dbz', 'vel', 'width']

// RVF 布局：
// 128B 文件头 + N * 32B 仰角目录 + 逐射线数据（8B 头 + 在场 u8 库值）
interface RawHeader {
  magic: number
  version: number
  stationId: string
  scanTimeIso: string
  expectedSweeps: number
  sweepCount: number
  rayCount: number
  gateCount: number
  rangeM: number
  nyquistMps: number
  lat: number
  lon: number
  altitudeM: number
  flags: number
  note: string
}

function writeFixedAscii(dv: DataView, offset: number, max: number, text: string): void {
  const bytes = new TextEncoder().encode(text)
  const n = Math.min(bytes.length, max - 1)
  for (let i = 0; i < n; i++) dv.setUint8(offset + i, bytes[i])
}

function readFixedAscii(dv: DataView, offset: number, max: number): string {
  let end = offset
  while (end < offset + max && dv.getUint8(end) !== 0) end++
  return new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + offset, end - offset))
}

// 序列化为 RVF 二进制
export function writeRvf(volume: RadarVolume): ArrayBuffer {
  const { meta, sweeps } = volume
  const sweepCount = sweeps.length
  const tableBytes = sweepCount * 32
  let rayBytes = 0
  for (const sweep of sweeps) {
    for (const ray of sweep.rays) {
      let fieldCount = 0
      for (const f of FIELD_TYPES) if (ray.fields[f]) fieldCount++
      rayBytes += 8 + fieldCount * meta.gateCount
    }
  }
  const total = RVF_HEADER_BYTES + tableBytes + rayBytes
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)

  dv.setUint32(0, RVF_MAGIC, true)
  dv.setUint16(4, RVF_VERSION, true)
  writeFixedAscii(dv, 6, 8, meta.stationId)
  writeFixedAscii(dv, 14, 24, meta.scanTimeIso)
  dv.setUint8(38, meta.expectedElevationCount)
  dv.setUint8(39, sweepCount)
  dv.setUint16(40, meta.rayCount, true)
  dv.setUint16(42, meta.gateCount, true)
  dv.setFloat32(44, meta.rangeM, true)
  dv.setFloat32(48, meta.nyquistMps, true)
  dv.setFloat64(52, meta.lat, true)
  dv.setFloat64(60, meta.lon, true)
  dv.setFloat32(68, meta.altitudeM, true)
  dv.setUint8(72, meta.hasGroundTruth ? 1 : 0)
  writeFixedAscii(dv, 73, 40, meta.note ?? '')

  // 仰角目录先占位，回填偏移
  let cursor = RVF_HEADER_BYTES + tableBytes
  sweeps.forEach((sweep, si) => {
    const tableOff = RVF_HEADER_BYTES + si * 32
    dv.setFloat32(tableOff, sweep.elevationDeg, true)
    dv.setUint16(tableOff + 4, sweep.rays.length, true)
    dv.setUint32(tableOff + 8, cursor, true)
    for (const ray of sweep.rays) {
      let fieldMask = 0
      let fieldCount = 0
      FIELD_TYPES.forEach((f, fi) => {
        if (ray.fields[f]) {
          fieldMask |= 1 << fi
          fieldCount++
        }
      })
      dv.setFloat32(cursor, ray.azimuthDeg, true)
      dv.setUint8(cursor + 4, fieldMask)
      const dataOff = cursor + 8
      let fIdx = 0
      for (const f of FIELD_TYPES) {
        const arr = ray.fields[f]
        if (!arr) continue
        u8.set(arr, dataOff + fIdx * meta.gateCount)
        fIdx++
      }
      cursor += 8 + fieldCount * meta.gateCount
    }
  })
  return buf
}

// 解析 RVF 二进制，缺仰角信息在 expectedSweeps 与实际仰角比对时产生
export function readRvf(buf: ArrayBuffer): RadarVolume {
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== RVF_MAGIC) throw new Error('不是合法的 RVF 体扫文件（魔数校验失败）')
  if (dv.getUint16(4, true) !== RVF_VERSION) throw new Error('RVF 版本不支持')

  const header: RawHeader = {
    magic: dv.getUint32(0, true),
    version: dv.getUint16(4, true),
    stationId: readFixedAscii(dv, 6, 8),
    scanTimeIso: readFixedAscii(dv, 14, 24),
    expectedSweeps: dv.getUint8(38),
    sweepCount: dv.getUint8(39),
    rayCount: dv.getUint16(40, true),
    gateCount: dv.getUint16(42, true),
    rangeM: dv.getFloat32(44, true),
    nyquistMps: dv.getFloat32(48, true),
    lat: dv.getFloat64(52, true),
    lon: dv.getFloat64(60, true),
    altitudeM: dv.getFloat32(68, true),
    flags: dv.getUint8(72),
    note: readFixedAscii(dv, 73, 40),
  }

  const sweeps: Sweep[] = []
  const u8 = new Uint8Array(buf)
  for (let si = 0; si < header.sweepCount; si++) {
    const tableOff = RVF_HEADER_BYTES + si * 32
    const elevationDeg = dv.getFloat32(tableOff, true)
    const raysInSweep = dv.getUint16(tableOff + 4, true)
    let off = dv.getUint32(tableOff + 8, true)
    const rays: RadarRay[] = []
    for (let ri = 0; ri < raysInSweep; ri++) {
      const azimuthDeg = dv.getFloat32(off, true)
      const fieldMask = dv.getUint8(off + 4)
      const dataOff = off + 8
      const fields = {} as Record<FieldType, Uint8Array>
      let fIdx = 0
      for (let fi = 0; fi < FIELD_TYPES.length; fi++) {
        if (!(fieldMask & (1 << fi))) continue
        const f = FIELD_TYPES[fi]
        fields[f] = u8.slice(dataOff + fIdx * header.gateCount, dataOff + (fIdx + 1) * header.gateCount)
        fIdx++
      }
      rays.push({
        azimuthDeg,
        elevationDeg,
        startRangeM: 0,
        gateWidthM: header.rangeM / header.gateCount,
        fields,
      })
      off += 8 + fIdx * header.gateCount
    }
    sweeps.push({ elevationDeg, rays })
  }

  // 期望仰角表：标准 S 波段 20 层 VCP21 风格序列
  const expected = STANDARD_ELEVATIONS_20.slice(0, header.expectedSweeps)
  const present = sweeps.map((s) => s.elevationDeg)
  const missingElevations = expected.filter(
    (e) => !present.some((p) => Math.abs(p - e) < 0.05),
  )

  const meta: VolumeMeta = {
    id: '',
    stationId: header.stationId,
    scanTimeIso: header.scanTimeIso,
    elevationCount: sweeps.length,
    expectedElevationCount: header.expectedSweeps,
    missingElevations,
    rayCount: header.rayCount,
    gateCount: header.gateCount,
    rangeM: header.rangeM,
    nyquistMps: header.nyquistMps,
    lat: header.lat,
    lon: header.lon,
    altitudeM: header.altitudeM,
    sizeBytes: buf.byteLength,
    hasGroundTruth: header.flags === 1,
    note: header.note || undefined,
  }

  return { meta, sweeps, groundTruth: null }
}

// 标准 20 层体扫仰角（度），由低到高
export const STANDARD_ELEVATIONS_20 = [
  0.5, 1.5, 2.4, 3.4, 4.3, 5.2, 6.0, 6.8, 7.6, 8.5,
  9.5, 10.6, 12.0, 13.5, 15.2, 17.0, 19.0, 21.5, 24.0, 27.0,
]
