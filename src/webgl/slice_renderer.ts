import { DBZ_COLOR_LEVELS } from '../core/constants'
import { decodeDbz, encodeDbz } from '../core/codec'
import type { CartesianGrid } from '../core/types'
import { buildColorLut, createLutTexture, createProgram, mat4Multiply } from './gl_utils'
import type { OrbitCamera } from './orbit_camera'
import type { VolumeRenderer } from './volume_renderer'

// 垂直剖面：在用户指定的两个水平点之间铺一块高度方向的四边形，
// 片元里按世界坐标采样三维纹理，悬垂/BWER 直接可见
const VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
out vec3 v_world;
void main() {
  v_world = a_pos;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec3 v_world;
uniform vec3 u_boxMin;
uniform vec3 u_boxMax;
uniform highp sampler3D u_volume;
uniform sampler2D u_lut;
out vec4 outColor;
void main() {
  vec3 uvw = (v_world - u_boxMin) / (u_boxMax - u_boxMin);
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) discard;
  float code = texture(u_volume, uvw).r * 255.0 + 0.5;
  if (code > 254.0) discard;
  vec4 c = texture(u_lut, vec2(code / 255.0 + 0.5/255.0, 0.5));
  if (c.a < 0.01) discard;
  outColor = vec4(c.rgb, 1.0);
}`

export interface SliceLine {
  x0: number
  y0: number
  x1: number
  y1: number
}

export class SliceRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private vbo: WebGLBuffer
  private lutTex: WebGLTexture
  private vertexCount = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, VS, FS)
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    this.vbo = gl.createBuffer() as WebGLBuffer
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 3 * 6, gl.DYNAMIC_DRAW)
    const loc = gl.getAttribLocation(this.program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.lutTex = createLutTexture(gl, buildColorLut(DBZ_COLOR_LEVELS, encodeDbz, decodeDbz))
  }

  setLine(line: SliceLine, topM: number): void {
    const gl = this.gl
    const verts = new Float32Array([
      line.x0, line.y0, 0,
      line.x1, line.y1, 0,
      line.x1, line.y1, topM,
      line.x0, line.y0, 0,
      line.x1, line.y1, topM,
      line.x0, line.y0, topM,
    ])
    this.vertexCount = 6
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts)
    gl.bindVertexArray(null)
  }

  render(
    camera: OrbitCamera,
    viewport: { width: number; height: number },
    grid: CartesianGrid,
    volume: VolumeRenderer,
  ): void {
    const gl = this.gl
    const mvp = mat4Multiply(
      camera.projectionMatrix(viewport.width / viewport.height),
      camera.viewMatrix(),
    )
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_mvp'), false, mvp)
    gl.uniform3fv(gl.getUniformLocation(this.program, 'u_boxMin'), [
      grid.originXM,
      grid.originYM,
      grid.originZM,
    ])
    gl.uniform3fv(gl.getUniformLocation(this.program, 'u_boxMax'), [
      grid.originXM + grid.nx * grid.dxM,
      grid.originYM + grid.ny * grid.dyM,
      grid.originZM + grid.nz * grid.dzM,
    ])
    // 体渲染器持有三维纹理，借它绑定到 texture0
    gl.activeTexture(gl.TEXTURE0)
    const texHandle = volume.getTextureHandle()
    gl.bindTexture(gl.TEXTURE_3D, texHandle)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_volume'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1)
    gl.enable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.vbo)
    gl.deleteTexture(this.lutTex)
  }
}
