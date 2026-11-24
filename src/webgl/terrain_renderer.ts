import { syntheticTerrainHeight } from '../core/synthetic_scene'
import { createProgram, mat4Multiply } from './gl_utils'
import type { OrbitCamera } from './orbit_camera'

const VS = `#version 300 es
in vec3 a_pos;
in float a_h;
uniform mat4 u_mvp;
out float v_h;
void main() {
  v_h = a_h;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in float v_h;
out vec4 outColor;
void main() {
  float t = clamp(v_h / 450.0, 0.0, 1.0);
  vec3 low = vec3(0.10, 0.16, 0.12);
  vec3 high = vec3(0.34, 0.30, 0.22);
  outColor = vec4(mix(low, high, t), 0.85);
}`

const LINE_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`

// 地形：规则网格按合成高度场起伏，深色调半透明
export class TerrainRenderer {
  private gl: WebGL2RenderingContext
  private terrainProgram: WebGLProgram
  private lineProgram: WebGLProgram
  private vao: WebGLVertexArrayObject
  private lineVao: WebGLVertexArrayObject
  private vertexCount = 0
  private lineCount = 0
  readonly extentM: number

  constructor(gl: WebGL2RenderingContext, extentM = 70000, gridStep = 2500) {
    this.gl = gl
    this.extentM = extentM
    this.terrainProgram = createProgram(gl, VS, FS)
    this.lineProgram = createProgram(gl, LINE_VS, LINE_FS)

    // 地形网格
    const n = Math.round((extentM * 2) / gridStep) + 1
    const positions: number[] = []
    const heights: number[] = []
    const indices: number[] = []
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = -extentM + ix * gridStep
        const y = -extentM + iy * gridStep
        const h = syntheticTerrainHeight(x, y)
        positions.push(x, y, h)
        heights.push(h)
      }
    }
    for (let iy = 0; iy < n - 1; iy++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const a = iy * n + ix
        const b = a + 1
        const c = a + n
        const d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
    this.vertexCount = indices.length
    const interleaved = new Float32Array(positions.length + heights.length)
    positions.forEach((v, i) => {
      interleaved[i * 2] = v
      interleaved[i * 2 + 1] = heights[i]
    })

    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    gl.bindVertexArray(this.vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW)
    const locPos = gl.getAttribLocation(this.terrainProgram, 'a_pos')
    const locH = gl.getAttribLocation(this.terrainProgram, 'a_h')
    gl.enableVertexAttribArray(locPos)
    gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(locH)
    gl.vertexAttribPointer(locH, 1, gl.FLOAT, false, 16, 12)
    const ibo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW)
    gl.bindVertexArray(null)

    // 城市边界：合成的矩形环路与两条行政线，抬升到地表以上 30m
    const rings = [
      [12000, 8000, 9000, 7000],
      [-22000, 14000, 7000, 5500],
      [6000, -24000, 11000, 6000],
    ]
    const linePts: number[] = []
    for (const [cx, cy, sx, sy] of rings) {
      const corners: [number, number][] = [
        [cx - sx, cy - sy],
        [cx + sx, cy - sy],
        [cx + sx, cy + sy],
        [cx - sx, cy + sy],
      ]
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = corners[i]
        const [x1, y1] = corners[(i + 1) % 4]
        linePts.push(x0, y0, syntheticTerrainHeight(x0, y0) + 30)
        linePts.push(x1, y1, syntheticTerrainHeight(x1, y1) + 30)
      }
    }
    this.lineCount = linePts.length / 3
    this.lineVao = gl.createVertexArray() as WebGLVertexArrayObject
    gl.bindVertexArray(this.lineVao)
    const lineVbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(linePts), gl.STATIC_DRAW)
    const lineLoc = gl.getAttribLocation(this.lineProgram, 'a_pos')
    gl.enableVertexAttribArray(lineLoc)
    gl.vertexAttribPointer(lineLoc, 3, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  render(camera: OrbitCamera, viewport: { width: number; height: number }): void {
    const gl = this.gl
    const mvp = mat4Multiply(
      camera.projectionMatrix(viewport.width / viewport.height),
      camera.viewMatrix(),
    )
    gl.useProgram(this.terrainProgram)
    gl.bindVertexArray(this.vao)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.terrainProgram, 'u_mvp'), false, mvp)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawElements(gl.TRIANGLES, this.vertexCount, gl.UNSIGNED_INT, 0)

    gl.useProgram(this.lineProgram)
    gl.bindVertexArray(this.lineVao)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'u_mvp'), false, mvp)
    gl.uniform4fv(gl.getUniformLocation(this.lineProgram, 'u_color'), [0.75, 0.72, 0.55, 0.9])
    gl.lineWidth(1.5)
    gl.drawArrays(gl.LINES, 0, this.lineCount)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.terrainProgram)
    gl.deleteProgram(this.lineProgram)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.lineVao)
  }
}
