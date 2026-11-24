// WebGL2 通用工具

export function createGl(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    premultipliedAlpha: false,
    alpha: false,
  })
  if (!gl) throw new Error('当前浏览器不支持 WebGL2，请换用最新版 Chrome/Edge')
  return gl
}

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('着色器对象创建失败')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`着色器编译失败: ${log}`)
  }
  return shader
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
  const program = gl.createProgram()
  if (!program) throw new Error('程序对象创建失败')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`着色器链接失败: ${log}`)
  }
  return program
}

// 列主序 4x4 矩阵工具
export type Mat4 = Float32Array

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

export function mat4Perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2)
  const nf = 1 / (near - far)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) * nf
  m[11] = -1
  m[14] = 2 * far * near * nf
  return m
}

export function mat4LookAt(eye: number[], center: number[], up: number[]): Mat4 {
  const [ex, ey, ez] = eye
  let zx = ex - center[0]
  let zy = ey - center[1]
  let zz = ez - center[2]
  const len = Math.hypot(zx, zy, zz) || 1
  zx /= len
  zy /= len
  zz /= len
  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  const xLen = Math.hypot(xx, xy, xz) || 1
  xx /= xLen
  xy /= xLen
  xz /= xLen
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const m = mat4Identity()
  m[0] = xx
  m[1] = yx
  m[2] = zx
  m[4] = xy
  m[5] = yy
  m[6] = zy
  m[8] = xz
  m[9] = yz
  m[10] = zz
  m[12] = -(xx * ex + xy * ey + xz * ez)
  m[13] = -(yx * ex + yy * ey + yz * ez)
  m[14] = -(zx * ex + zy * ey + zz * ez)
  return m
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[i] * b[j * 4] +
        a[4 + i] * b[j * 4 + 1] +
        a[8 + i] * b[j * 4 + 2] +
        a[12 + i] * b[j * 4 + 3]
    }
  }
  return out
}

// 由分级色标生成 256 项 RGBA LUT
export function buildColorLut(
  levels: readonly { value: number; color: readonly number[] }[],
  encode: (v: number) => number,
  decode: (code: number) => number,
  missingColor: [number, number, number] = [0, 0, 0],
): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  for (let code = 0; code < 256; code++) {
    const v = decode(code)
    const off = code * 4
    if (!Number.isFinite(v)) {
      lut[off] = missingColor[0]
      lut[off + 1] = missingColor[1]
      lut[off + 2] = missingColor[2]
      lut[off + 3] = 0
      continue
    }
    let lo = levels[0]
    let hi = levels[levels.length - 1]
    for (let i = 0; i < levels.length - 1; i++) {
      if (v >= levels[i].value && v <= levels[i + 1].value) {
        lo = levels[i]
        hi = levels[i + 1]
        break
      }
    }
    const t = hi.value === lo.value ? 0 : (v - lo.value) / (hi.value - lo.value)
    lut[off] = clamp255(lo.color[0] + (hi.color[0] - lo.color[0]) * t)
    lut[off + 1] = clamp255(lo.color[1] + (hi.color[1] - lo.color[1]) * t)
    lut[off + 2] = clamp255(lo.color[2] + (hi.color[2] - lo.color[2]) * t)
    lut[off + 3] = 255
  }
  // 255 = 缺测，透明
  lut[255 * 4 + 3] = 0
  void encode
  return lut
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

// 创建 256x1 的 RGBA 查表纹理
export function createLutTexture(gl: WebGL2RenderingContext, lut: Uint8Array): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('纹理创建失败')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}
