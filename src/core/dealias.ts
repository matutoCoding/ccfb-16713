import { decodeVel, MISSING_U8 } from './codec'
import type { RadarRay, Sweep } from './types'

// 速度退模糊：极坐标区域生长 BFS
// 策略：
// 1. 以反射率最强库为主种子，BFS 逐邻居按 2*Nyquist 整数倍选择跳变最小订正量
// 2. 无回波库会割裂连通区，主 BFS 结束后对剩余未访问有效库按连通区独立播种
// 3. 仅当原始相邻跳变超过 Nyquist 才做折叠订正，正常风场切变保持原值
export function dealiasVolume(
  sweeps: Sweep[],
  nyquistMps: number,
): { correctedVel: (Float32Array | null)[]; foldCount: number } {
  const span = 2 * nyquistMps
  const result: (Float32Array | null)[] = []
  let foldCount = 0

  for (const sweep of sweeps) {
    const rays = sweep.rays
    if (rays.length === 0 || !rays[0].fields.vel) {
      result.push(null)
      continue
    }
    const gates = rays[0].fields.vel.length
    const nAz = rays.length
    const total = nAz * gates
    const vel = new Float32Array(total)
    const dbz = new Float32Array(total)
    const valid = new Uint8Array(total)
    for (let a = 0; a < nAz; a++) {
      for (let g = 0; g < gates; g++) {
        const idx = a * gates + g
        const code = rays[a].fields.vel[g]
        if (code !== MISSING_U8) {
          vel[idx] = decodeVel(code)
          valid[idx] = 1
        } else {
          vel[idx] = NaN
        }
        const dCode = rays[a].fields.dbz?.[g] ?? MISSING_U8
        dbz[idx] = dCode === MISSING_U8 ? -999 : dCode
      }
    }

    const corrected = new Float32Array(total).fill(NaN)
    const visited = new Uint8Array(total)
    const queue = new Int32Array(total)

    const neighbors = (idx: number): number[] => {
      const a = Math.floor(idx / gates)
      const g = idx % gates
      const out: number[] = []
      for (const da of [-1, 1]) out.push(((a + da + nAz) % nAz) * gates + g)
      if (g > 0) out.push(a * gates + g - 1)
      if (g < gates - 1) out.push(a * gates + g + 1)
      return out
    }

    // 从指定种子生长一个连通区
    const grow = (seedIdx: number): void => {
      let head = 0
      let tail = 0
      corrected[seedIdx] = vel[seedIdx]
      visited[seedIdx] = 1
      queue[tail++] = seedIdx
      while (head < tail) {
        const cur = queue[head++]
        const ref = corrected[cur]
        for (const nb of neighbors(cur)) {
          if (visited[nb] || !valid[nb]) continue
          visited[nb] = 1
          const raw = vel[nb]
          let best = raw
          if (Math.abs(raw - ref) > nyquistMps) {
            let bestDiff = Math.abs(raw - ref)
            for (const k of [-2, -1, 1, 2]) {
              const candidate = raw + k * span
              const diff = Math.abs(candidate - ref)
              if (diff < bestDiff) {
                bestDiff = diff
                best = candidate
              }
            }
          }
          if (best !== raw) foldCount++
          corrected[nb] = best
          queue[tail++] = nb
        }
      }
    }

    // 主种子：全场反射率最强的有效速度库
    let mainSeed = -1
    let bestDbz = -999
    for (let i = 0; i < total; i++) {
      if (valid[i] && dbz[i] > bestDbz) {
        bestDbz = dbz[i]
        mainSeed = i
      }
    }
    if (mainSeed < 0) {
      result.push(null)
      continue
    }
    grow(mainSeed)

    // 被无回波区割裂的剩余连通区，线性扫描逐个播种（grow 会标记整个区）
    for (let i = 0; i < total; i++) {
      if (valid[i] && !visited[i]) grow(i)
    }
    result.push(corrected)
  }
  return { correctedVel: result, foldCount }
}

// 取某条射线上退模糊后的速度数组（未启用或缺失时回退原始解码）
export function getRayVelocity(
  ray: RadarRay,
  corrected: Float32Array | null,
  rayIndex: number,
): Float32Array {
  const gates = ray.fields.vel.length
  const out = new Float32Array(gates)
  for (let g = 0; g < gates; g++) {
    if (corrected) {
      out[g] = corrected[rayIndex * gates + g]
    } else {
      const code = ray.fields.vel[g]
      out[g] = code === MISSING_U8 ? NaN : decodeVel(code)
    }
  }
  return out
}
