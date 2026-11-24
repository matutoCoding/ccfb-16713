// 确定性伪随机与值噪声，保证合成数据可复现、可验收

export class DeterministicRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  // xorshift32
  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return this.state / 4294967296
  }

  // 标准正态近似（Box-Muller）
  gaussian(): number {
    const u = Math.max(this.next(), 1e-9)
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

// 二维可平滑插值的网格值噪声
export class ValueNoise2D {
  private grid: Float32Array
  constructor(
    private size: number,
    rng: DeterministicRandom,
  ) {
    this.grid = new Float32Array(size * size)
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rng.next()
  }

  static fromSeed(size: number, seed: number): ValueNoise2D {
    return new ValueNoise2D(size, new DeterministicRandom(seed))
  }

  private smooth(t: number): number {
    return t * t * (3 - 2 * t)
  }

  // 输入归一化坐标 [0,1)，输出 [0,1)
  sample(u: number, v: number): number {
    const x = ((u % 1) + 1) % 1 * this.size
    const y = ((v % 1) + 1) % 1 * this.size
    const x0 = Math.floor(x) % this.size
    const y0 = Math.floor(y) % this.size
    const x1 = (x0 + 1) % this.size
    const y1 = (y0 + 1) % this.size
    const tx = this.smooth(x - Math.floor(x))
    const ty = this.smooth(y - Math.floor(y))
    const a = this.grid[y0 * this.size + x0]
    const b = this.grid[y0 * this.size + x1]
    const c = this.grid[y1 * this.size + x0]
    const d = this.grid[y1 * this.size + x1]
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
  }

  // 多倍频叠加，返回近似 [-1,1]
  fbm(u: number, v: number, octaves = 3): number {
    let sum = 0
    let amp = 0.5
    let freq = 1
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += (this.sample(u * freq, v * freq) * 2 - 1) * amp
      norm += amp
      amp *= 0.5
      freq *= 2
    }
    return sum / norm
  }
}

// 高斯权重
export const gaussianWeight = (
  dx: number,
  dy: number,
  sigma: number,
): number => {
  const q = (dx * dx + dy * dy) / (2 * sigma * sigma)
  return q > 9 ? 0 : Math.exp(-q)
}
