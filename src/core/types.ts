// 全局共享类型定义

// 雷达场类型
export type FieldType = 'dbz' | 'vel' | 'width'

// 单条径向：每个场一个 u8 量化数组，长度 = 库数
export interface RadarRay {
  azimuthDeg: number
  elevationDeg: number
  startRangeM: number
  gateWidthM: number
  fields: Record<FieldType, Uint8Array>
}

// 单层仰角扫描
export interface Sweep {
  elevationDeg: number
  rays: RadarRay[]
}

// 体扫元数据（列表与 IndexedDB 用）
export interface VolumeMeta {
  id: string
  stationId: string
  scanTimeIso: string
  elevationCount: number
  expectedElevationCount: number
  missingElevations: number[]
  rayCount: number
  gateCount: number
  rangeM: number
  nyquistMps: number
  lat: number
  lon: number
  altitudeM: number
  sizeBytes: number
  hasGroundTruth: boolean
  note?: string
}

// 完整体扫（内存态）
export interface RadarVolume {
  meta: VolumeMeta
  sweeps: Sweep[]
  // 合成数据附带的已知结构真值，真实文件为 null
  groundTruth: GroundTruth | null
}

// 合成结构真值，用于位置误差验收
export interface GroundTruth {
  cores: GroundTruthCore[]
  description: string
}

export interface GroundTruthCore {
  name: string
  kind: 'supercell' | 'squall'
  // 回波核心（最大反射率质心）的三维笛卡尔位置，单位米，雷达为原点
  xM: number
  yM: number
  zM: number
  peakDbz: number
}

// 笛卡尔网格上的重采样结果
export interface CartesianGrid {
  // 网格原点（西南下角）的笛卡尔坐标，米
  originXM: number
  originYM: number
  originZM: number
  dxM: number
  dyM: number
  dzM: number
  nx: number
  ny: number
  nz: number
  // u8 量化反射率，索引 z*nx*ny + y*nx + x，255 = 空
  dbz: Uint8Array
  // 填缝后仍为空的格点数
  holeCount: number
  resampleMs: number
}

// 二维产品格点
export interface ProductGrid {
  kind: 'cr' | 'et' | 'vil'
  originXM: number
  originYM: number
  dxM: number
  dyM: number
  nx: number
  ny: number
  // 量化值：CR 同 dbz 编码；ET 单位 0.1km，255=空；VIL 单位 0.1kg/m2，255=空
  values: Uint8Array
}

// 体扫处理流水线的完整产物
export interface ProcessedVolume {
  volumeId: string
  grid: CartesianGrid
  products: Record<'cr' | 'et' | 'vil', ProductGrid>
  // 强回波样本稀疏质心（亚格距位置校验用）
  strongCentroids: StrongCentroid[]
  totalMs: number
}

export interface StrongCentroid {
  name: string
  xM: number
  yM: number
  zM: number
  peakDbz: number
}

// 追踪到的风暴单体
export interface StormCell {
  id: number
  xM: number
  yM: number
  zTopM: number
  areaKm2: number
  maxDbz: number
  vil: number
}

export interface CellTrack {
  id: number
  points: { timeIso: string; xM: number; yM: number }[]
}

// 静态杂波图标记：极坐标库位是否为地物
export interface ClutterMap {
  stationId: string
  elevationDeg: number
  gateCount: number
  // 方位数 x 库数，1 = 地物
  flags: Uint8Array
  azimuthCount: number
}
