import { buildColorLut, createLutTexture, createProgram } from './gl_utils'
import {
  DBZ_COLOR_LEVELS,
  MISSING_U8,
  VEL_COLOR_LEVELS,
  WIDTH_COLOR_LEVELS,
} from '../core/constants'
import { decodeDbz, decodeVel, decodeWidth } from '../core/codec'
import type { FieldType, Sweep } from '../core/types'

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_lut;
uniform float u_missing;
out vec4 outColor;
void main() {
  float code = texture(u_field, v_uv).r * 255.0 + 0.5;
  vec4 c = texture(u_lut, vec2(code / 255.0 + 0.5/255.0, 0.5));
  if (c.a < 0.01) discard;
  outColor = c;
}`

// PPI 极坐标渲染：每个方位-库单元一个三角形扇单元，整屏一次绘制
export class PolarRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private vbo: WebGLBuffer
  private fieldTex: WebGLTexture
  private lutTex: WebGLTexture
  private currentField: FieldType | null = null
  private azimuthCount = 0
  private gateCount = 0
  private cachedGeometryKey = ''
  private cachedVertices: Float32Array | null = null
  private vertexCount = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VERT, FRAG)
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    this.fieldTex = gl.createTexture() as WebGLTexture
    this.lutTex = gl.createTexture() as WebGLTexture
    this.vbo = gl.createBuffer() as WebGLBuffer
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    // 上限：360 方位 x 900 库 x 6 顶点 x 4 float
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 4 * 360 * 900 * 6, gl.DYNAMIC_DRAW)
    const locPos = gl.getAttribLocation(this.program, 'a_pos')
    const locUv = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(locPos)
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(locUv)
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
  }

  private ensureLut(field: FieldType): void {
    if (this.currentField === field) return
    const gl = this.gl
    const levels =
      field === 'dbz'
        ? DBZ_COLOR_LEVELS
        : field === 'vel'
          ? VEL_COLOR_LEVELS
          : WIDTH_COLOR_LEVELS
    const decode = field === 'dbz' ? decodeDbz : field === 'vel' ? decodeVel : decodeWidth
    const lut = buildColorLut(levels, () => 0, decode)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.currentField = field
  }

  // 上传单层扫描的指定场为 2D 纹理（行=方位，列=库）
  uploadSweep(sweep: Sweep, field: FieldType, gateCount: number): void {
    const gl = this.gl
    const azimuthCount = sweep.rays.length
    const data = new Uint8Array(azimuthCount * gateCount).fill(MISSING_U8)
    sweep.rays.forEach((ray, az) => {
      const arr = ray.fields[field]
      if (arr) data.set(arr, az * gateCount)
    })
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      gateCount,
      azimuthCount,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      data,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.azimuthCount = azimuthCount
    this.gateCount = gateCount
  }

  private buildGeometry(rangeM: number, displayRangeM: number): { vertices: Float32Array; count: number } {
    const key = `${this.azimuthCount}|${this.gateCount}|${rangeM}|${displayRangeM}`
    if (key === this.cachedGeometryKey && this.cachedVertices) {
      return { vertices: this.cachedVertices, count: this.vertexCount }
    }
    // 每单元 2 个三角形 = 6 顶点，每顶点 pos.xy + uv.xy
    const verts: number[] = []
    const scale = displayRangeM > 0 ? Math.min(1, rangeM / displayRangeM) : 1
    const nAz = this.azimuthCount
    const nGate = this.gateCount
    for (let a = 0; a < nAz; a++) {
      const az0 = (a / nAz) * Math.PI * 2
      const az1 = ((a + 1) / nAz) * Math.PI * 2
      const v0 = a / nAz
      const v1 = (a + 1) / nAz
      for (let g = 0; g < nGate; g++) {
        const r0 = (g / nGate) * scale
        const r1 = ((g + 1) / nGate) * scale
        const u0 = g / nGate
        const u1 = (g + 1) / nGate
        const p00 = [r0 * Math.sin(az0), r0 * Math.cos(az0)]
        const p10 = [r1 * Math.sin(az0), r1 * Math.cos(az0)]
        const p01 = [r0 * Math.sin(az1), r0 * Math.cos(az1)]
        const p11 = [r1 * Math.sin(az1), r1 * Math.cos(az1)]
        pushTri(verts, p00, [u0, v0], p10, [u1, v0], p11, [u1, v1])
        pushTri(verts, p00, [u0, v0], p11, [u1, v1], p01, [u0, v1])
      }
    }
    const vertices = new Float32Array(verts)
    this.cachedGeometryKey = key
    this.cachedVertices = vertices
    this.vertexCount = verts.length / 4
    return { vertices, count: this.vertexCount }
  }

  render(sweep: Sweep, field: FieldType, rangeM: number, displayRangeM: number): void {
    const gl = this.gl
    this.ensureLut(field)
    this.uploadSweep(sweep, field, sweep.rays[0]?.fields[field]?.length ?? 0)
    const { vertices, count } = this.buildGeometry(rangeM, displayRangeM)

    gl.clearColor(0.02, 0.03, 0.05, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_field'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, count)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteTexture(this.fieldTex)
    gl.deleteTexture(this.lutTex)
    gl.deleteBuffer(this.vbo)
    gl.deleteVertexArray(this.vao)
  }
}

function pushTri(
  out: number[],
  p0: number[],
  uv0: number[],
  p1: number[],
  uv1: number[],
  p2: number[],
  uv2: number[],
): void {
  out.push(p0[0], p0[1], uv0[0], uv0[1])
  out.push(p1[0], p1[1], uv1[0], uv1[1])
  out.push(p2[0], p2[1], uv2[0], uv2[1])
}

// 供页面叠加距离环用：把屏幕坐标反算为极坐标（米）
export function screenToPolar(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  displayRangeM: number,
): { azimuthDeg: number; rangeM: number; x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1
  const ny = -(((clientY - rect.top) / rect.height) * 2 - 1)
  const r = Math.hypot(nx, ny)
  const rangeM = r * displayRangeM
  const azimuthDeg = (Math.atan2(nx, ny) * 180) / Math.PI
  return { azimuthDeg: (azimuthDeg + 360) % 360, rangeM, x: nx, y: ny }
}
