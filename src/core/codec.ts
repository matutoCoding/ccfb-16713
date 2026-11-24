import {
  DBZ_OFFSET,
  DBZ_STEP,
  MISSING_U8,
  VEL_OFFSET,
  VEL_STEP,
  WIDTH_STEP,
} from './constants'
import type { FieldType } from './types'

export { MISSING_U8 }

// 物理量 <-> u8 量化
export const encodeDbz = (dbz: number): number =>
  dbz <= -999 ? MISSING_U8 : Math.max(0, Math.min(254, Math.round((dbz + DBZ_OFFSET) / DBZ_STEP)))

export const decodeDbz = (code: number): number =>
  code === MISSING_U8 ? NaN : code * DBZ_STEP - DBZ_OFFSET

export const encodeVel = (vel: number, nyquist: number): number => {
  if (!Number.isFinite(vel)) return MISSING_U8
  // 折叠到 [-Nyquist, Nyquist) 后编码
  const span = 2 * nyquist
  let v = vel
  while (v >= nyquist) v -= span
  while (v < -nyquist) v += span
  return Math.max(0, Math.min(254, Math.round((v + VEL_OFFSET) / VEL_STEP)))
}

export const decodeVel = (code: number): number =>
  code === MISSING_U8 ? NaN : code * VEL_STEP - VEL_OFFSET

export const encodeWidth = (width: number): number =>
  !Number.isFinite(width) ? MISSING_U8 : Math.max(0, Math.min(254, Math.round(width / WIDTH_STEP)))

export const decodeWidth = (code: number): number =>
  code === MISSING_U8 ? NaN : code * WIDTH_STEP

// 产品量化：ET 0.1km，VIL 0.1kg/m2
export const encodeEt = (heightM: number): number =>
  !Number.isFinite(heightM) ? MISSING_U8 : Math.max(0, Math.min(254, Math.round(heightM / 100)))

export const decodeEt = (code: number): number => (code === MISSING_U8 ? NaN : code * 100)

export const encodeVil = (vil: number): number =>
  !Number.isFinite(vil) ? MISSING_U8 : Math.max(0, Math.min(254, Math.round(vil * 10)))

export const decodeVil = (code: number): number => (code === MISSING_U8 ? NaN : code / 10)

export const fieldDecoder = (
  field: FieldType,
): ((code: number) => number) => {
  if (field === 'dbz') return decodeDbz
  if (field === 'vel') return decodeVel
  return decodeWidth
}
