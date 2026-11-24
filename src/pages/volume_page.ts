import { appStore } from '../core/store'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import { loadVolume, resizeCanvas } from '../services/view_helper'
import { runPipeline, type PipelineTiming } from '../services/pipeline'
import { getSyntheticClutterMaps } from '../services/clutter_service'
import { createGl } from '../webgl/gl_utils'
import { OrbitCamera } from '../webgl/orbit_camera'
import { VolumeRenderer } from '../webgl/volume_renderer'
import { TerrainRenderer } from '../webgl/terrain_renderer'
import type { ProcessedVolume } from '../core/types'

export function volumePage(container: HTMLElement): Disposable {
  const settings = appStore.getState()
  let processed: ProcessedVolume | null = null
  let timing: PipelineTiming | null = null
  let volumeRenderer: VolumeRenderer | null = null
  let terrainRenderer: TerrainRenderer | null = null
  let gl: WebGL2RenderingContext | null = null
  const camera = new OrbitCamera()
  let mode: 'volume' | 'iso' = 'volume'
  let rafId = 0
  let disposed = false

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['三维体渲染']),
      h('p', { className: 'page-subtitle' }, ['极坐标体扫已在 Web Worker 中重采样到笛卡尔网格，考虑地球曲率与标准大气折射']),
    ]),
  ])

  const canvas = h('canvas', {}) as HTMLCanvasElement
  const canvasWrap = h('div', { className: 'viewer-canvas-wrap' }, [canvas])
  const side = h('div', { className: 'viewer-side' })
  const layout = h('div', { className: 'viewer-layout' }, [canvasWrap, side])
  const loading = h('div', { className: 'loading-mask', hidden: 'true' }, [
    h('div', { className: 'spinner' }),
    h('span', { id: 'loading-text' }, ['重采样中...']),
  ])
  canvasWrap.append(loading)
  const hud = h('div', { className: 'overlay-hud' }, ['等待数据'])
  canvasWrap.append(hud)
  container.append(header, layout)

  function panel(title: string, children: HTMLElement[]): HTMLElement {
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, [title]),
      ...children,
    ])
  }

  function buildSidePanel(): void {
    clear(side)
    const state = appStore.getState()

    const modeBtn = h(
      'button',
      { className: `btn ${mode === 'volume' ? 'btn-primary' : ''}`, style: 'flex:1' },
      ['体渲染'],
    )
    const isoBtn = h(
      'button',
      { className: `btn ${mode === 'iso' ? 'btn-primary' : ''}`,
        style: 'flex:1' },
      ['等值面'],
    )
    modeBtn.addEventListener('click', () => {
      mode = 'volume'
      buildSidePanel()
    })
    isoBtn.addEventListener('click', () => {
      mode = 'iso'
      buildSidePanel()
    })

    const isoSlider = h('input', {
      type: 'range',
      min: '20',
      max: '60',
      step: '1',
      value: String(state.isoThresholdDbz),
      style: 'width:100%',
    }) as HTMLInputElement
    const isoLabel = h('div', { className: 'stat-label' }, [`等值面阈值 ${state.isoThresholdDbz} dBZ`])
    isoSlider.addEventListener('input', () => {
      appStore.setState({ isoThresholdDbz: Number(isoSlider.value) })
      isoLabel.textContent = `等值面阈值 ${isoSlider.value} dBZ`
    })

    const opacitySlider = h('input', {
      type: 'range',
      min: '0.1',
      max: '1',
      step: '0.05',
      value: String(state.volumeOpacity),
      style: 'width:100%',
    }) as HTMLInputElement
    const opacityLabel = h('div', { className: 'stat-label' }, [`不透明度 ${state.volumeOpacity.toFixed(2)}`])
    opacitySlider.addEventListener('input', () => {
      appStore.setState({ volumeOpacity: Number(opacitySlider.value) })
      opacityLabel.textContent = `不透明度 ${Number(opacitySlider.value).toFixed(2)}`
    })

    const terrainToggle = toggleRow('地形叠加', state.terrainEnabled, (v) => {
      appStore.setState({ terrainEnabled: v })
    })
    const cityToggle = toggleRow('城市边界', state.cityEnabled, (v) => {
      appStore.setState({ cityEnabled: v })
    })
    const clutterToggle = toggleRow('静态杂波剔除', state.clutterFilterEnabled, (v) => {
      appStore.setState({ clutterFilterEnabled: v })
      toast('切换杂波剔除后请重新运行流水线', 'info')
    })

    const rerunBtn = h('button', { className: 'btn btn-primary', style: 'width:100%' }, [
      icon('refresh'), '重新运行重采样流水线',
    ])
    rerunBtn.addEventListener('click', () => void run())

    const shotBtn = h('button', { className: 'btn', style: 'width:100%' }, [
      icon('download'), '导出当前截图 PNG',
    ])
    shotBtn.addEventListener('click', () => {
      const url = canvas.toDataURL('image/png')
      const a = h('a', { href: url, download: `volume-3d-${Date.now()}.png` }) as HTMLAnchorElement
      a.click()
      toast('截图已导出', 'success')
    })

    side.append(
      panel('渲染模式', [h('div', { className: 'toolbar' }, [modeBtn, isoBtn])]),
      panel('等值面', [isoLabel, isoSlider]),
      panel('体渲染', [opacityLabel, opacitySlider]),
      panel('场景叠加', [terrainToggle, cityToggle, clutterToggle]),
      panel('流水线', [rerunBtn, shotBtn]),
    )
    if (timing) side.append(buildTimingPanel(timing, processed))
  }

  function toggleRow(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
    const btn = h('button', {
      className: `btn btn-sm ${initial ? 'btn-primary' : ''}`,
      style: 'width:100%;justify-content:space-between',
    }, [label, initial ? '开' : '关'])
    let value = initial
    btn.addEventListener('click', () => {
      value = !value
      btn.classList.toggle('btn-primary', value)
      btn.replaceChildren(document.createTextNode(label), document.createTextNode(value ? '开' : '关'))
      onChange(value)
    })
    return btn
  }

  function buildTimingPanel(t: PipelineTiming, pv: ProcessedVolume | null): HTMLElement {
    const pass3s = t.totalMs < 3000
    const grid = pv?.grid
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, ['性能计时']),
      h('div', { className: 'stat-grid' }, [
        stat('读取导入', `${t.importMs.toFixed(0)} ms`),
        stat('RVF 解码', `${t.decodeMs.toFixed(0)} ms`),
        stat('Worker 重采样+产品', `${t.resampleMs.toFixed(0)} ms`),
        stat('端到端总计', `${t.totalMs.toFixed(0)} ms`, pass3s ? 'success' : 'danger'),
      ]),
      grid
        ? h('p', { className: 'stat-label', style: 'margin-top:12px;line-height:1.8' }, [
            `网格 ${grid.nx}×${grid.ny}×${grid.nz}，格距 ${grid.dxM}m，空洞 ${grid.holeCount} 格`,
          ])
        : h('span'),
      h('p', {
        className: `badge ${pass3s ? 'badge-ok' : 'badge-danger'}`,
        style: 'margin-top:8px',
      }, [pass3s ? '满足 <3s 验收线' : '超出 3s 验收线，请调大格距']),
    ])
  }

  function stat(label: string, value: string, tone: '' | 'success' | 'danger' = ''): HTMLElement {
    return h('div', { className: 'stat-card' }, [
      h('div', { className: 'stat-label' }, [label]),
      h('div', { className: `stat-value ${tone === 'success' ? 'primary' : tone === 'danger' ? '' : ''}` }, [value]),
    ])
  }

  function renderLoop(): void {
    if (disposed) return
    if (gl && volumeRenderer && processed) {
      const size = resizeCanvas(canvas)
      gl.viewport(0, 0, size.width, size.height)
      gl.clearColor(0.02, 0.03, 0.05, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      const state = appStore.getState()
      if (state.terrainEnabled && terrainRenderer) {
        terrainRenderer.render(camera, size)
      }
      // 体渲染是屏幕空间光线积分，关闭深度测试让其与地形正确混合；
      // 等值面模式在着色器内做首次穿越，同样不写深度
      gl.disable(gl.DEPTH_TEST)
      volumeRenderer?.render(
        camera,
        size,
        mode,
        state.isoThresholdDbz,
        state.volumeOpacity,
      )
      hud.innerHTML =
        `方位 ${camera.azimuthDeg.toFixed(0)}° · 俯仰 ${camera.elevationDeg.toFixed(0)}° · 视距 ${(camera.distanceM / 1000).toFixed(1)}km`
    }
    rafId = requestAnimationFrame(renderLoop)
  }

  // 轨道相机交互
  let dragging = false
  let lastX = 0
  let lastY = 0
  let panning = false
  const onDown = (ev: MouseEvent): void => {
    dragging = true
    panning = ev.button === 2 || ev.shiftKey
    lastX = ev.clientX
    lastY = ev.clientY
  }
  const onMove = (ev: MouseEvent): void => {
    if (!dragging) return
    const dx = ev.clientX - lastX
    const dy = ev.clientY - lastY
    lastX = ev.clientX
    lastY = ev.clientY
    if (panning) camera.pan(dx, dy, canvas.clientHeight)
    else camera.orbit(dx, dy)
  }
  const onUp = (): void => {
    dragging = false
    panning = false
  }
  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    camera.zoom(ev.deltaY > 0 ? 1.12 : 0.89)
  }
  canvas.addEventListener('mousedown', onDown)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault())

  const onResize = (): void => {
    if (gl) {
      const size = resizeCanvas(canvas)
      gl.viewport(0, 0, size.width, size.height)
    }
  }
  window.addEventListener('resize', onResize)

  async function run(): Promise<void> {
    const selectedId = appStore.getState().selectedVolumeId
    if (!selectedId) {
      canvasWrap.append(
        h('div', { className: 'empty-state', style: 'position:absolute;inset:40px' }, [
          icon('cube', 48),
          h('div', { className: 'empty-title' }, ['未选用体扫']),
          h('div', { className: 'empty-desc' }, ['先到数据管理页合成或导入体扫']),
        ]),
      )
      return
    }
    loading.hidden = false
    const t0 = performance.now()
    try {
      const state = appStore.getState()
      const clutter = getSyntheticClutterMaps()
      const result = await runPipeline(selectedId, clutter, {
        clutterFilterEnabled: state.clutterFilterEnabled,
        dxM: state.gridDxM,
      })
      processed = result.processed
      timing = result.timing
      if (!gl || !volumeRenderer) {
        gl = createGl(canvas)
        volumeRenderer = new VolumeRenderer(gl)
        terrainRenderer = new TerrainRenderer(gl)
      }
      volumeRenderer.uploadGrid(processed.grid)
      const elapsed = performance.now() - t0
      hud.textContent = `导入到三维出图总耗时 ${elapsed.toFixed(0)} ms`
      buildSidePanel()
    } catch (err) {
      toast((err as Error).message, 'error', 6000)
    } finally {
      loading.hidden = true
    }
  }

  buildSidePanel()
  void run()
  rafId = requestAnimationFrame(renderLoop)

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('resize', onResize)
      volumeRenderer?.dispose()
      terrainRenderer?.dispose()
    },
  }
}
