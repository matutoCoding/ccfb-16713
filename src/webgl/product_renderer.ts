import { buildColorLut, createLutTexture, createProgram } from './gl_utils'
import { DBZ_COLOR_LEVELS } from '../core/constants'
import { decodeDbz, decodeEt, decodeVil, encodeDbz, encodeEt, encodeVil } from '../core/codec'
import type { ProductGrid } from '../core/types'

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_lut;
out vec4 outColor;
void main() {
  float code = texture(u_field, v_uv).r * 255.0 + 0.5;
  vec4 c = texture(u_lut, vec2(code / 255.0 + 0.5/255.0, 0.5));
  if (c.a < 0.01) discard;
  outColor = c;
}`

// 产品专用色标：ET 蓝-红高度感，VIL 紫-黄强度感
const ET_LEVELS = [
  { value: 0, color: [20, 60, 120] },
  { value: 3000, color: [40, 140, 220] },
  { value: 6000, color: [80, 200, 160] },
  { value: 9000, color: [230, 220, 90] },
  { value: 12000, color: [240, 130, 40] },
  { value: 15000, color: [210, 40, 40] },
] as const

const VIL_LEVELS = [
  { value: 0.5, color: [70, 60, 140] },
  { value: 5, color: [90, 110, 220] },
  { value: 15, color: [80, 200, 200] },
  { value: 30, color: [160, 230, 120] },
  { value: 50, color: [250, 230, 90] },
  { value: 70, color: [240, 130, 40] },
  { value: 90, color: [210, 50, 60] },
] as const

// 笛卡尔格点产品的二维渲染，世界坐标 -> 屏幕的映射由页面叠加层负责
export class ProductRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private fieldTex: WebGLTexture
  private lutTex: WebGLTexture
  private kind: ProductGrid['kind'] | null = null

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VS, FS)
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    gl.bindVertexArray(this.vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 0,
        1, -1, 1, 0,
        -1, 1, 0, 1,
        -1, 1, 0, 1,
        1, -1, 1, 0,
        1, 1, 1, 1,
      ]),
      gl.STATIC_DRAW,
    )
    const locPos = gl.getAttribLocation(this.program, 'a_pos')
    const locUv = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(locPos)
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(locUv)
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
    this.fieldTex = gl.createTexture() as WebGLTexture
    this.lutTex = gl.createTexture() as WebGLTexture
  }

  private ensureLut(kind: ProductGrid['kind']): void {
    if (this.kind === kind) return
    const gl = this.gl
    let lut: Uint8Array
    if (kind === 'cr') {
      lut = buildColorLut(DBZ_COLOR_LEVELS, encodeDbz, decodeDbz)
    } else if (kind === 'et') {
      lut = buildColorLut(ET_LEVELS, encodeEt, decodeEt)
    } else {
      lut = buildColorLut(VIL_LEVELS, encodeVil, decodeVil)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.kind = kind
  }

  render(product: ProductGrid): void {
    const gl = this.gl
    this.ensureLut(product.kind)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      product.nx,
      product.ny,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      product.values,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.clearColor(0.02, 0.03, 0.05, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_field'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    gl.deleteTexture(this.fieldTex)
    gl.deleteTexture(this.lutTex)
  }
}
