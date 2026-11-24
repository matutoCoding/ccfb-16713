import { DBZ_COLOR_LEVELS } from '../core/constants'
import { decodeDbz, encodeDbz } from '../core/codec'
import type { CartesianGrid } from '../core/types'
import { buildColorLut, createLutTexture, createProgram, mat4Multiply, type Mat4 } from './gl_utils'
import type { OrbitCamera } from './orbit_camera'

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const VOLUME_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_ndc;
uniform mat4 u_invViewProj;
uniform vec3 u_boxMin;
uniform vec3 u_boxMax;
uniform vec3 u_camPos;
uniform highp sampler3D u_volume;
uniform sampler2D u_lut;
uniform float u_opacity;
uniform int u_mode;       // 0 体渲染, 1 等值面
uniform float u_iso;      // 等值面阈值 dBZ
uniform float u_dx;
out vec4 outColor;

vec3 ndcToWorld(vec3 ndc) {
  vec4 w = u_invViewProj * vec4(ndc, 1.0);
  return w.xyz / w.w;
}

vec2 intersectBox(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 tbot = (u_boxMin - ro) * inv;
  vec3 ttop = (u_boxMax - ro) * inv;
  vec3 tmin = min(tbot, ttop);
  vec3 tmax = max(tbot, ttop);
  return vec2(max(max(tmin.x, tmin.y), tmin.z),
              min(min(tmax.x, tmax.y), tmax.z));
}

float sampleDbz(vec3 worldPos) {
  vec3 uvw = (worldPos - u_boxMin) / (u_boxMax - u_boxMin);
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return -999.0;
  float code = texture(u_volume, uvw).r * 255.0 + 0.5;
  if (code > 254.0) return -999.0;
  return code * 0.5 - 32.0;
}

vec3 dbzColor(float dbz) {
  float code = (dbz + 32.0) * 2.0;
  return texture(u_lut, vec2(clamp(code, 0.0, 254.0) / 255.0 + 0.5/255.0, 0.5)).rgb;
}

vec3 gradient(vec3 p) {
  float s = u_dx;
  float gx = sampleDbz(p + vec3(s,0,0)) - sampleDbz(p - vec3(s,0,0));
  float gy = sampleDbz(p + vec3(0,s,0)) - sampleDbz(p - vec3(0,s,0));
  float gz = sampleDbz(p + vec3(0,0,s)) - sampleDbz(p - vec3(0,0,s));
  return normalize(vec3(gx, gy, gz));
}

void main() {
  vec3 ro = u_camPos;
  vec3 farPoint = ndcToWorld(vec3(v_ndc, 1.0));
  vec3 nearPoint = ndcToWorld(vec3(v_ndc, -1.0));
  vec3 rd = normalize(farPoint - nearPoint);

  vec2 hit = intersectBox(ro, rd);
  float tStart = max(hit.x, 0.0);
  float tEnd = hit.y;
  if (tEnd <= tStart) discard;

  float stepLen = max(u_dx * 1.4, 120.0);
  vec4 accum = vec4(0.0);

  if (u_mode == 1) {
    // 等值面：阈值穿越检测 + 中心差分法线 + 简单方向光
    float prev = sampleDbz(ro + rd * tStart);
    for (float t = tStart + stepLen; t < tEnd; t += stepLen) {
      vec3 p = ro + rd * t;
      float cur = sampleDbz(p);
      bool crossed = (prev < u_iso && cur >= u_iso) || (prev >= u_iso && cur < u_iso);
      if (crossed && cur > -900.0) {
        vec3 n = gradient(p);
        vec3 light = normalize(vec3(0.5, 0.6, 0.8));
        float diff = abs(dot(n, light)) * 0.75 + 0.35;
        vec3 base = dbzColor(max(cur, u_iso));
        outColor = vec4(base * diff, 1.0);
        return;
      }
      prev = cur;
      if (t > 800000.0) break;
    }
    discard;
  }

  // 体渲染：前向积分，alpha 随反射率强度增长
  for (float t = tStart; t < tEnd; t += stepLen) {
    vec3 p = ro + rd * t;
    float dbz = sampleDbz(p);
    if (dbz > 5.0) {
      vec3 c = dbzColor(dbz);
      float strength = clamp((dbz - 5.0) / 55.0, 0.0, 1.0);
      float a = strength * u_opacity * 0.28;
      accum.rgb += (1.0 - accum.a) * a * c;
      accum.a += (1.0 - accum.a) * a;
      if (accum.a > 0.96) break;
    }
    if (t > 800000.0) break;
  }
  if (accum.a < 0.02) discard;
  outColor = vec4(accum.rgb, accum.a);
}`

export class VolumeRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private volumeTex: WebGLTexture | null = null
  private lutTex: WebGLTexture
  private grid: CartesianGrid | null = null

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.program = createProgram(gl, QUAD_VS, VOLUME_FS)
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject
    gl.bindVertexArray(this.vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const loc = gl.getAttribLocation(this.program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    const lut = buildColorLut(DBZ_COLOR_LEVELS, encodeDbz, decodeDbz)
    this.lutTex = createLutTexture(gl, lut)
  }

  uploadGrid(grid: CartesianGrid): void {
    const gl = this.gl
    if (!this.volumeTex) this.volumeTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    // R8UI 以整数格式上传，着色器中用归一化采样取 r
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      grid.nx,
      grid.ny,
      grid.nz,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      grid.dbz,
    )
    this.grid = grid
  }

  render(
    camera: OrbitCamera,
    viewport: { width: number; height: number },
    mode: 'volume' | 'iso',
    isoThresholdDbz: number,
    opacity: number,
  ): void {
    const gl = this.gl
    const grid = this.grid
    if (!grid) return
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    const aspect = viewport.width / viewport.height
    const proj = camera.projectionMatrix(aspect)
    const view = camera.viewMatrix()
    const vp = mat4Multiply(proj, view)
    const invVp = invertMat4(vp)

    const boxMin: [number, number, number] = [grid.originXM, grid.originYM, grid.originZM]
    const boxMax: [number, number, number] = [
      grid.originXM + grid.nx * grid.dxM,
      grid.originYM + grid.ny * grid.dyM,
      grid.originZM + grid.nz * grid.dzM,
    ]
    const eye = camera.eye

    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_invViewProj'), false, invVp)
    gl.uniform3fv(gl.getUniformLocation(this.program, 'u_boxMin'), boxMin)
    gl.uniform3fv(gl.getUniformLocation(this.program, 'u_boxMax'), boxMax)
    gl.uniform3fv(gl.getUniformLocation(this.program, 'u_camPos'), eye)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), opacity)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_mode'), mode === 'iso' ? 1 : 0)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_iso'), isoThresholdDbz)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_dx'), grid.dxM)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_volume'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  getTextureHandle(): WebGLTexture {
    if (!this.volumeTex) throw new Error('三维纹理尚未上传')
    return this.volumeTex
  }

  getGrid(): CartesianGrid | null {
    return this.grid
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    if (this.volumeTex) gl.deleteTexture(this.volumeTex)
    gl.deleteTexture(this.lutTex)
  }
}

// 4x4 求逆（列主序，通用高斯消元）
function invertMat4(m: Mat4): Mat4 {
  const inv = new Float32Array(16)
  const a: number[] = Array.from(m)
  for (let i = 0; i < 4; i++) inv[i * 4 + i] = 1
  for (let col = 0; col < 4; col++) {
    let pivot = col
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(a[row * 4 + col]) > Math.abs(a[pivot * 4 + col])) pivot = row
    }
    for (let j = 0; j < 4; j++) {
      const tmp = a[pivot * 4 + j]
      a[pivot * 4 + j] = a[col * 4 + j]
      a[col * 4 + j] = tmp
      const tmp2 = inv[pivot * 4 + j]
      inv[pivot * 4 + j] = inv[col * 4 + j]
      inv[col * 4 + j] = tmp2
    }
    const diag = a[col * 4 + col] || 1e-9
    for (let j = 0; j < 4; j++) {
      a[col * 4 + j] /= diag
      inv[col * 4 + j] /= diag
    }
    for (let row = 0; row < 4; row++) {
      if (row === col) continue
      const factor = a[row * 4 + col]
      for (let j = 0; j < 4; j++) {
        a[row * 4 + j] -= factor * a[col * 4 + j]
        inv[row * 4 + j] -= factor * inv[col * 4 + j]
      }
    }
  }
  return inv
}
