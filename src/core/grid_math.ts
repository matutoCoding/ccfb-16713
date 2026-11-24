import { ET_THRESHOLD_DBZ, MISSING_U8, VIL_MIN_DBZ } from './constants'
import { decodeDbz, encodeEt, encodeVil } from './codec'
import type { CartesianGrid, ProductGrid } from './types'

// VIL 计算用的 dBZ -> 液态水含量查表（Greene-Clark 近似，单位 kg/m3）
// Z = 3e6 * M^2 反演，按 0.5dBZ 步进预算好
const VIL_TABLE = new Float32Array(255)
for (let code = 0; code < 255; code++) {
  const dbz = decodeDbz(code)
  if (dbz < VIL_MIN_DBZ) {
    VIL_TABLE[code] = 0
    continue
  }
  const zLinear = 10 ** (dbz / 10)
  VIL_TABLE[code] = (zLinear / 3e6) ** (1 / 1.667) * 1e3
}

export interface ProductResult {
  cr: ProductGrid
  et: ProductGrid
  vil: ProductGrid
}

// 从三维网格一趟算出组合反射率、回波顶高、垂直积分液态水
export function computeProducts(grid: CartesianGrid): ProductResult {
  const { nx, ny, nz, dzM, originXM, originYM, dxM, dyM, dbz } = grid
  const layerSize = nx * ny
  const cr = new Uint8Array(layerSize).fill(MISSING_U8)
  const et = new Uint8Array(layerSize).fill(MISSING_U8)
  const vil = new Float32Array(layerSize)

  for (let z = 0; z < nz; z++) {
    const layerOffset = z * layerSize
    const layerZM = grid.originZM + (z + 0.5) * dzM
    for (let i = 0; i < layerSize; i++) {
      const code = dbz[layerOffset + i]
      if (code === MISSING_U8) continue
      if (cr[i] === MISSING_U8 || code > cr[i]) cr[i] = code

      const v = decodeDbz(code)
      if (v >= ET_THRESHOLD_DBZ && layerZM > (et[i] === MISSING_U8 ? -1 : decodeEtSafe(et[i]))) {
        et[i] = encodeEt(layerZM)
      }
      vil[i] += VIL_TABLE[code] * dzM
    }
  }

  const vilEncoded = new Uint8Array(layerSize).fill(MISSING_U8)
  for (let i = 0; i < layerSize; i++) {
    if (vil[i] > 0.05) vilEncoded[i] = encodeVil(vil[i])
  }

  const base = { originXM, originYM, dxM, dyM, nx, ny }
  return {
    cr: { ...base, kind: 'cr', values: cr },
    et: { ...base, kind: 'et', values: et },
    vil: { ...base, kind: 'vil', values: vilEncoded },
  }
}

function decodeEtSafe(code: number): number {
  return code === MISSING_U8 ? -1 : code * 100
}

// 三次方向的 3D 邻域填缝：仅把被有效格点半包围的空洞填上，最多迭代两轮
export function fillHoles(grid: CartesianGrid): number {
  const { nx, ny, nz, dbz } = grid
  const layer = nx * ny
  let filled = 0
  for (let pass = 0; pass < 2; pass++) {
    const snapshot = dbz.slice()
    let passFilled = 0
    for (let z = 1; z < nz - 1; z++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const idx = z * layer + y * nx + x
          if (snapshot[idx] !== MISSING_U8) continue
          // 6 邻域至少 3 个有效才填，取有效值的最大反射率，保持对流核完整
          const neighbors = [
            snapshot[idx - 1],
            snapshot[idx + 1],
            snapshot[idx - nx],
            snapshot[idx + nx],
            snapshot[idx - layer],
            snapshot[idx + layer],
          ]
          let validCount = 0
          let max = 0
          for (const n of neighbors) {
            if (n !== MISSING_U8) {
              validCount++
              if (n > max) max = n
            }
          }
          if (validCount >= 3) {
            dbz[idx] = max
            filled++
            passFilled++
          }
        }
      }
    }
    if (passFilled === 0) break
  }
  return filled
}

// 网格索引辅助
export const gridIndex = (grid: CartesianGrid, x: number, y: number, z: number): number =>
  z * grid.nx * grid.ny + y * grid.nx + x
