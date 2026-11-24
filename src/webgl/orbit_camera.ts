import { deg2rad } from '../core/geometry'
import { mat4LookAt, mat4Perspective, type Mat4 } from './gl_utils'

// 球面坐标轨道相机：方位角、俯仰角、距离三参数，目标固定在雷达附近
export class OrbitCamera {
  azimuthDeg = 35
  elevationDeg = 32
  distanceM = 130000
  target: [number, number, number] = [0, 0, 3000]
  fovyDeg = 45
  near = 100
  far = 600000

  get eye(): [number, number, number] {
    const az = deg2rad(this.azimuthDeg)
    const el = deg2rad(this.elevationDeg)
    const horizontal = this.distanceM * Math.cos(el)
    return [
      this.target[0] + horizontal * Math.sin(az),
      this.target[1] + horizontal * Math.cos(az),
      this.target[2] + this.distanceM * Math.sin(el),
    ]
  }

  viewMatrix(): Mat4 {
    return mat4LookAt(this.eye, this.target, [0, 0, 1])
  }

  projectionMatrix(aspect: number): Mat4 {
    return mat4Perspective(deg2rad(this.fovyDeg), aspect, this.near, this.far)
  }

  // 鼠标/触控拖拽
  orbit(dxPixel: number, dyPixel: number): void {
    this.azimuthDeg += dxPixel * 0.25
    this.elevationDeg = Math.max(2, Math.min(88, this.elevationDeg - dyPixel * 0.25))
  }

  zoom(factor: number): void {
    this.distanceM = Math.max(3000, Math.min(300000, this.distanceM * factor))
  }

  // 屏幕像素位移转地面平移量（拖拽平移目标点）
  pan(dxPixel: number, dyPixel: number, viewportHeight: number): void {
    const az = deg2rad(this.azimuthDeg)
    const scale = (this.distanceM * Math.tan(deg2rad(this.fovyDeg / 2)) * 2) / viewportHeight
    const right: [number, number, number] = [Math.cos(az), -Math.sin(az), 0]
    const forward: [number, number, number] = [Math.sin(az), Math.cos(az), 0]
    const move = scale * 1.2
    this.target[0] += (right[0] * dxPixel - forward[0] * dyPixel) * move
    this.target[1] += (right[1] * dxPixel - forward[1] * dyPixel) * move
  }
}
