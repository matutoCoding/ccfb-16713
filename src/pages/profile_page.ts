import { appStore } from '../core/store'
import type { Disposable } from '../ui/components'
import { h, icon } from '../ui/components'
import { toast } from '../ui/toast'
import { runPipeline } from '../services/pipeline'
import { getSyntheticClutterMaps } from '../services/clutter_service'
import { resizeCanvas } from '../services/view_helper'
import { createGl } from '../webgl/gl_utils'
import { OrbitCamera } from '../webgl/orbit_camera'
import { VolumeRenderer } from '../webgl/volume_renderer'
import { SliceRenderer, type SliceLine } from '../webgl/slice_renderer'
import type { ProcessedVolume } from '../core/types'

export function profilePage(container: HTMLElement): Disposable {
  let gl: WebGL2RenderingContext | null = null
  let volumeRenderer: VolumeRenderer | null = null
  let sliceRenderer: SliceRenderer | null = null
  let processed: ProcessedVolume | null = null
  const camera = new OrbitCamera()
  camera.elevationDeg = 18
  camera.distanceM = 110000
  let rafId = 0
  let disposed = false
  let line: SliceLine = { x0: -30000, y0: -20000, x1: 30000, y1: 20000 }
  let sliceVisible = true

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['剖面分析']),
      h('p', { className: 'page-subtitle' }, ['在示意 PPI 上拉任意一条线，三维场景中生成对应的垂直剖面，观察回波悬垂与有界弱回波区']),
    ]),
  ])

  const canvas = h('canvas', {}) as HTMLCanvasElement
  const canvasWrap = h('div', { className: 'viewer-canvas-wrap' }, [canvas])
  const miniMap = h('canvas', {
    style: 'position:absolute;right:16px;top:16px;width:220px;height:220px;background:rgba(5,8,15,0.85);border:1px solid var(--border);border-radius:8px;cursor:crosshair',
  }) as HTMLCanvasElement
  canvasWrap.append(miniMap)
  const hud = h('div', { className: 'overlay-hud' }, ['在右上角缩略图上拖拽拉线'])
  canvasWrap.append(hud)

  const side = h('div', { className: 'viewer-side' })
  const layout = h('div', { className: 'viewer-layout' }, [canvasWrap, side])
  container.append(header, layout)

  function panel(title: string, children: HTMLElement[]): HTMLElement {
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, [title]),
      ...children,
    ])
  }

  const lengthKm = (): number => Math.hypot(line.x1 - line.x0, line.y1 - line.y0) / 1000
  const info = h('div', { className: 'stat-label', style: 'line-height:1.9' }, [
    `剖面长度 ${lengthKm().toFixed(1)} km`,
  ])

  const presetBtns: HTMLElement[] = [
    ['SW-NE 对角线', { x0: -45000, y0: -35000, x1: 45000, y1: 35000 }],
    ['EW 横线', { x0: -50000, y0: 0, x1: 50000, y1: 0 }],
    ['NS 纵线', { x0: 0, y0: -50000, x1: 0, y1: 50000 }],
  ].map(([label, preset]) => {
    const btn = h('button', { className: 'btn btn-sm', style: 'width:100%;margin-bottom:8px' }, [label as string])
    btn.addEventListener('click', () => {
      line = preset as SliceLine
      sliceRenderer?.setLine(line, 15000)
      info.textContent = `剖面长度 ${lengthKm().toFixed(1)} km`
      drawMiniMap()
    })
    return btn
  })

  const toggleBtn = h('button', { className: 'btn btn-primary', style: 'width:100%' }, ['隐藏剖面'])
  toggleBtn.addEventListener('click', () => {
    sliceVisible = !sliceVisible
    toggleBtn.textContent = sliceVisible ? '隐藏剖面' : '显示剖面'
    toggleBtn.classList.toggle('btn-primary', sliceVisible)
  })

  const exportBtn = h('button', { className: 'btn', style: 'width:100%' }, [icon('download'), '导出剖面图 PNG'])
  exportBtn.addEventListener('click', () => {
    const a = h('a', { href: canvas.toDataURL('image/png'), download: `profile-${Date.now()}.png` }) as HTMLAnchorElement
    a.click()
    toast('剖面图已导出', 'success')
  })

  side.append(
    panel('剖面线', [info, ...presetBtns]),
    panel('显示', [toggleBtn, h('div', { style: 'height:8px' }), exportBtn]),
    panel('读图提示', [
      h('div', { className: 'stat-label', style: 'line-height:1.9' }, [
        '悬垂结构表现为高层回波水平位置超出低层降水区；BWER 为被强回波包裹的低层弱回波穹窿，是超级单体典型特征。',
      ]),
    ]),
  )

  // 缩略 PPI：用组合反射率产品画底图 + 可拖拽剖面线
  function drawMiniMap(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = 220
    miniMap.width = w * dpr
    miniMap.height = w * dpr
    const ctx = miniMap.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#070b14'
    ctx.fillRect(0, 0, w, w)
    const extent = 60000
    const toX = (x: number): number => ((x + extent) / (extent * 2)) * w
    const toY = (y: number): number => w - ((y + extent) / (extent * 2)) * w
    if (processed) {
      const cr = processed.products.cr
      const cell = w / cr.nx
      for (let y = 0; y < cr.ny; y++) {
        for (let x = 0; x < cr.nx; x++) {
          const code = cr.values[y * cr.nx + x]
          if (code === 255) continue
          const dbz = code * 0.5 - 32
          const t = Math.max(0, Math.min(1, (dbz - 5) / 55))
          ctx.fillStyle = `rgba(${Math.round(80 + 175 * t)},${Math.round(160 - 120 * t)},${Math.round(220 - 200 * t)},0.9)`
          ctx.fillRect(x * cell, w - (y + 1) * cell, cell + 0.5, cell + 0.5)
        }
      }
    }
    // 雷达中心
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(toX(0), toY(0), 3, 0, Math.PI * 2)
    ctx.fill()
    // 剖面线
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(toX(line.x0), toY(line.y0))
    ctx.lineTo(toX(line.x1), toY(line.y1))
    ctx.stroke()
    ctx.fillStyle = '#38bdf8'
    ctx.beginPath()
    ctx.arc(toX(line.x0), toY(line.y0), 4, 0, Math.PI * 2)
    ctx.arc(toX(line.x1), toY(line.y1), 4, 0, Math.PI * 2)
    ctx.fill()
  }

  // 缩略图拖拽拉线
  let drawing = false
  const eventToWorld = (ev: MouseEvent): { x: number; y: number } => {
    const rect = miniMap.getBoundingClientRect()
    const nx = (ev.clientX - rect.left) / rect.width
    const ny = (ev.clientY - rect.top) / rect.height
    const extent = 60000
    return { x: nx * extent * 2 - extent, y: (1 - ny) * extent * 2 - extent }
  }
  miniMap.addEventListener('mousedown', (ev) => {
    drawing = true
    const p = eventToWorld(ev)
    line = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
  })
  window.addEventListener('mousemove', (ev) => {
    if (!drawing) return
    const p = eventToWorld(ev)
    line.x1 = p.x
    line.y1 = p.y
    sliceRenderer?.setLine(line, 15000)
    info.textContent = `剖面长度 ${lengthKm().toFixed(1)} km`
    drawMiniMap()
  })
  window.addEventListener('mouseup', () => {
    if (drawing) {
      drawing = false
      sliceRenderer?.setLine(line, 15000)
      drawMiniMap()
    }
  })

  // 三维相机交互
  let dragging = false
  let lastX = 0
  let lastY = 0
  canvas.addEventListener('mousedown', (ev) => {
    dragging = true
    lastX = ev.clientX
    lastY = ev.clientY
  })
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return
    camera.orbit(ev.clientX - lastX, ev.clientY - lastY)
    lastX = ev.clientX
    lastY = ev.clientY
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    camera.zoom(ev.deltaY > 0 ? 1.12 : 0.89)
  }, { passive: false })

  function renderLoop(): void {
    if (disposed) return
    if (gl && volumeRenderer && processed) {
      const size = resizeCanvas(canvas)
      gl.viewport(0, 0, size.width, size.height)
      gl.clearColor(0.02, 0.03, 0.05, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      volumeRenderer.render(camera, size, 'volume', appStore.getState().isoThresholdDbz, 0.25)
      if (sliceVisible && sliceRenderer) {
        sliceRenderer.render(camera, size, processed.grid, volumeRenderer)
      }
    }
    rafId = requestAnimationFrame(renderLoop)
  }

  async function init(): Promise<void> {
    const selectedId = appStore.getState().selectedVolumeId
    if (!selectedId) {
      toast('请先在数据管理页选用体扫', 'error')
      return
    }
    try {
      const state = appStore.getState()
      const result = await runPipeline(selectedId, getSyntheticClutterMaps(), {
        clutterFilterEnabled: state.clutterFilterEnabled,
        dxM: state.gridDxM,
      })
      processed = result.processed
      gl = createGl(canvas)
      volumeRenderer = new VolumeRenderer(gl)
      sliceRenderer = new SliceRenderer(gl)
      volumeRenderer.uploadGrid(processed.grid)
      sliceRenderer.setLine(line, 15000)
      drawMiniMap()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  window.addEventListener('resize', drawMiniMap)
  void init()
  rafId = requestAnimationFrame(renderLoop)

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', drawMiniMap)
      volumeRenderer?.dispose()
      sliceRenderer?.dispose()
    },
  }
}
