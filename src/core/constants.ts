import type { FieldType } from './types'

// RVF 自定义二进制格式魔数与版本
export const RVF_MAGIC = 0x52564631 // 'RVF1' 小端
export const RVF_VERSION = 1
export const RVF_HEADER_BYTES = 128

// 场编码约定：统一 u8 量化，255 表示缺测/空
export const MISSING_U8 = 255

// 反射率：-32 ~ 95 dBZ，步进 0.5，编码 = (dbz + 32) * 2
export const DBZ_OFFSET = 32
export const DBZ_STEP = 0.5

// 径向速度：-48 ~ 79.5 m/s，步进 0.5，编码 = (vel + 48) * 2
export const VEL_OFFSET = 48
export const VEL_STEP = 0.5

// 谱宽：0 ~ 31.875 m/s，步进 0.125，编码 = width / 0.125
export const WIDTH_STEP = 0.125

// 回波顶高判定阈值
export const ET_THRESHOLD_DBZ = 18.3
// VIL 最低反射率门槛
export const VIL_MIN_DBZ = 18
// 风暴单体识别阈值（组合反射率）
export const CELL_DBZ_THRESHOLD = 45

// 标准大气折射：4/3 等效地球半径
export const EARTH_RADIUS_M = 6371000
export const EFFECTIVE_EARTH_RADIUS_M = (4 / 3) * EARTH_RADIUS_M

// 标准雷达色标（中国气象局常用反射率等级）
export const DBZ_COLOR_LEVELS = [
  { value: 5, color: [8, 77, 118] },
  { value: 10, color: [0, 170, 255] },
  { value: 15, color: [0, 240, 255] },
  { value: 20, color: [0, 200, 0] },
  { value: 25, color: [0, 144, 0] },
  { value: 30, color: [255, 255, 0] },
  { value: 35, color: [255, 200, 0] },
  { value: 40, color: [255, 128, 0] },
  { value: 45, color: [255, 0, 0] },
  { value: 50, color: [192, 0, 0] },
  { value: 55, color: [180, 0, 180] },
  { value: 60, color: [255, 170, 255] },
  { value: 65, color: [255, 255, 255] },
] as const

// 径向速度色标：蓝-白-红
export const VEL_COLOR_LEVELS = [
  { value: -30, color: [0, 0, 160] },
  { value: -20, color: [0, 80, 255] },
  { value: -10, color: [0, 220, 255] },
  { value: -2, color: [200, 255, 255] },
  { value: 2, color: [255, 255, 200] },
  { value: 10, color: [255, 220, 0] },
  { value: 20, color: [255, 80, 0] },
  { value: 30, color: [160, 0, 0] },
] as const

// 谱宽色标：冷到暖
export const WIDTH_COLOR_LEVELS = [
  { value: 0, color: [40, 40, 120] },
  { value: 2, color: [0, 160, 220] },
  { value: 4, color: [0, 200, 120] },
  { value: 6, color: [200, 220, 0] },
  { value: 8, color: [240, 140, 0] },
  { value: 10, color: [220, 40, 0] },
] as const

export const FIELD_LABEL: Record<FieldType, string> = {
  dbz: '反射率',
  vel: '径向速度',
  width: '谱宽',
}

export const FIELD_UNIT: Record<FieldType, string> = {
  dbz: 'dBZ',
  vel: 'm/s',
  width: 'm/s',
}
