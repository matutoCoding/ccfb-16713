import { appStore } from '../core/store'
import type { FieldType, RadarVolume, Sweep } from '../core/types'
import { dealiasVolume } from '../core/dealias'
import { MISSING_U8 } from '../core/constants'
import { encodeVel } from '../core/codec'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import { fieldLegend } from '../ui/legend'
import { loadVolume, resizeCanvas } from '../services/view_helper'
import { getLowElevationClutter } from '../services/clutter_service'
import { createGl } from '../webgl/gl_utils'
import { PolarRenderer, screenToPolar } from '../webgl/polar_renderer'
import { RhiRenderer } from '../webgl/rhi_renderer'

interface PageState {
  volume: RadarVolume | null
  sweepIndex: number
  field: FieldType
  mode: 'PPI' | 'RHI'
  rhiAzimuth: number
  dealias: boolean
  displayRangeM: number
}

export function ppiPage(container: HTMLElement): Disposable {
  const settings = appStore.getState()
  const ps: PageState = {
    volume: null,
    sweepIndex: 0,
    field: settings.selectedField,
    mode: 'PPI',
    rhiAzimuth: 0,
    dealias: settings.autoDealias,
    displayRangeM: 100000,
  }
  let renderer: PolarRenderer | null = null
  let rhiRenderer: RhiRenderer | null = null
  let gl: WebGL2RenderingContext | null = null
  let rafId = 0
  let correctedVelocity: (Float32Array | null)[] = []
  let foldCount = 0
  const overlays: { dispose(): void }[] = []

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['PPI / RHI 显示']),
      h('p', { className: 'page-subtitle' }, ['标准色标显示反射率、径向速度与谱宽，速度折叠可自动退模糊']),
    ]),
  ])

  const canvas = h('canvas', {}) as HTMLCanvasElement
  const overlayCanvas = h('canvas', {
    style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none',
  }) as HTMLCanvasElement
  const canvasWrap = h('div', { className: 'viewer-canvas-wrap' }, [canvas, overlayCanvas])

  const side = h('div', { className: 'viewer-side' })
  const layout = h('div', { className: 'viewer-layout' }, [canvasWrap, side])
  const loading = h('div', { className: 'loading-mask', hidden: 'true' }, [
    h('div', { className: 'spinner' }),
    h('span', {}, ['加载体扫...']),
  ])
  canvasWrap.append(loading)
  container.append(header, layout)

  function buildSidePanel(): void {
    clear(side)
    if (!ps.volume) {
      side.append(
        h('div', { className: 'empty-state' }, [
          icon('ppi', 40),
          h('div', { className: 'empty-title' }, ['未选用体扫']),
          h('div', { className: 'empty-desc' }, ['去数据管理页选用或合成一个体扫']),
        ]),
      )
      return
    }
    const volume = ps.volume

    // 模式切换
    const modeSelect = h('select', {}, [
      h('option', { value: 'PPI' }, ['PPI 平面位置显示']),
      h('option', { value: 'RHI' }, ['RHI 距离高度显示']),
    ]) as HTMLSelectElement
    modeSelect.value = ps.mode
    modeSelect.addEventListener('change', () => {
      ps.mode = modeSelect.value as PageState['mode']
      buildSidePanel()
      scheduleDraw()
    })

    // 场切换
    const fieldSelect = h('select', {}, [
      h('option', { value: 'dbz' }, ['反射率 dBZ']),
      h('option', { value: 'vel' }, ['径向速度 m/s']),
      h('option', { value: 'width' }, ['谱宽 m/s']),
    ]) as HTMLSelectElement
    fieldSelect.value = ps.field
    fieldSelect.addEventListener('change', () => {
      ps.field = fieldSelect.value as FieldType
      appStore.setState({ selectedField: ps.field })
      buildSidePanel()
      scheduleDraw()
    })

    // 仰角选择（PPI）
    const elevSelect = h('select', {}) as HTMLSelectElement
    volume.sweeps.forEach((sweep, i) => {
      elevSelect.append(h('option', { value: String(i) }, [`${sweep.elevationDeg.toFixed(1)}°`]))
    })
    elevSelect.value = String(Math.min(ps.sweepIndex, volume.sweeps.length - 1))
    elevSelect.addEventListener('change', () => {
      ps.sweepIndex = Number(elevSelect.value)
      scheduleDraw()
    })

    // RHI 方位
    const azInput = h('input', {
      type: 'range',
      min: '0',
      max: '359',
      value: String(ps.rhiAzimuth),
      style: 'width:100%',
    }) as HTMLInputElement
    const azLabel = h('div', { className: 'stat-label' }, [`RHI 方位：${ps.rhiAzimuth}°`])
    azInput.addEventListener('input', () => {
      ps.rhiAzimuth = Number(azInput.value)
      azLabel.textContent = `RHI 方位：${ps.rhiAzimuth}°`
      scheduleDraw()
    })

    // 显示半径
    const rangeSelect = h('select', {}, [
      h('option', { value: '50000' }, ['50 km']),
      h('option', { value: '100000' }, ['100 km']),
      h('option', { value: '150000' }, ['150 km']),
      h('option', { value: '200000' }, ['200 km（全量程）']),
    ]) as HTMLSelectElement
    rangeSelect.value = String(ps.displayRangeM)
    rangeSelect.addEventListener('change', () => {
      ps.displayRangeM = Number(rangeSelect.value)
      scheduleDraw()
    })

    const dealiasBtn = h(
      'button',
      { className: `btn ${ps.dealias ? 'btn-primary' : ''}`, style: 'width:100%' },
      [ps.dealias ? '退模糊：已启用' : '退模糊：已关闭'],
    )
    dealiasBtn.addEventListener('click', () => {
      ps.dealias = !ps.dealias
      appStore.setState({ autoDealias: ps.dealias })
      if (ps.dealias) runDealias()
      buildSidePanel()
      scheduleDraw()
    })

    const legendPanel = h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px' }, ['色标']),
      fieldLegend(ps.field),
    ])

    side.append(
      panel('显示模式', [modeSelect]),
      panel('气象场', [fieldSelect]),
      ps.mode === 'PPI' ? panel('仰角层', [elevSelect]) : panel('RHI 方位', [azLabel, azInput]),
      panel('显示半径', [rangeSelect]),
      panel('速度处理', [
        dealiasBtn,
        h('div', { className: 'stat-label', style: 'margin-top:8px' }, [
          foldCount > 0 ? `检测并订正折叠库 ${foldCount} 处` : '当前无折叠订正记录',
        ]),
      ]),
      legendPanel,
    )
  }

  function panel(title: string, children: HTMLElement[]): HTMLElement {
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, [title]),
      ...children,
    ])
  }

  function runDealias(): void {
    if (!ps.volume) return
    const result = dealiasVolume(ps.volume.sweeps, ps.volume.meta.nyquistMps)
    correctedVelocity = result.correctedVel
    foldCount = result.foldCount
  }

  // 把退模糊后的速度重新编码回射线，供 PolarRenderer 统一走纹理路径
  function effectiveSweep(sweep: Sweep, sweepIndex: number): Sweep {
    if (ps.field !== 'vel' || !ps.dealias || !correctedVelocity[sweepIndex]) return sweep
    const corrected = correctedVelocity[sweepIndex] as Float32Array
    const gates = sweep.rays[0].fields.vel.length
    const rays = sweep.rays.map((ray, ri) => {
      const vel = new Uint8Array(gates)
      for (let g = 0; g < gates; g++) {
        const v = corrected[ri * gates + g]
        vel[g] = Number.isNaN(v) ? MISSING_U8 : encodeVel(v, ps.volume?.meta.nyquistMps ?? 11.5)
      }
      return { ...ray, fields: { ...ray.fields, vel } }
    })
    return { ...sweep, rays }
  }

  function scheduleDraw(): void {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(draw)
  }

  function draw(): void {
    if (!ps.volume) return
    const size = resizeCanvas(canvas)
    if (ps.mode === 'RHI') {
      if (!rhiRenderer) rhiRenderer = new RhiRenderer()
      // RHI 使用独立 2D 画布，隐藏 WebGL 画布与叠加层
      canvas.style.visibility = 'hidden'
      overlayCanvas.style.visibility = 'hidden'
      if (!rhiRenderer.element.isConnected) canvasWrap.prepend(rhiRenderer.element)
      rhiRenderer.element.style.position = 'absolute'
      rhiRenderer.element.style.inset = '8px'
      const rect = canvasWrap.getBoundingClientRect()
      rhiRenderer.render(
        ps.volume,
        ps.rhiAzimuth,
        ps.field,
        rect.width - 16,
        rect.height - 16,
        ps.displayRangeM,
      )
      return
    }
    if (!gl || !renderer) return
    canvas.style.visibility = 'visible'
    overlayCanvas.style.visibility = 'visible'
    rhiRenderer?.element.remove()
    gl.viewport(0, 0, size.width, size.height)
    overlayCanvas.width = size.width
    overlayCanvas.height = size.height
    const sweep = ps.volume.sweeps[Math.min(ps.sweepIndex, ps.volume.sweeps.length - 1)]
    const effective = effectiveSweep(sweep, ps.sweepIndex)
    renderer.render(effective, ps.field, ps.volume.meta.rangeM, ps.displayRangeM)
    drawOverlay()
  }

  function drawOverlay(): void {
    const ctx = overlayCanvas.getContext('2d')
    if (!ctx) return
    const w = overlayCanvas.width
    const h = overlayCanvas.height
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) / 2 - 8
    ctx.strokeStyle = 'rgba(148,163,184,0.55)'
    ctx.fillStyle = 'rgba(203,213,225,0.9)'
    ctx.lineWidth = 1
    ctx.font = '12px sans-serif'
    const ringCount = 5
    for (let i = 1; i <= ringCount; i++) {
      const r = (radius * i) / ringCount
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
      const label = `${((ps.displayRangeM * i) / ringCount / 1000).toFixed(0)}km`
      ctx.fillText(label, cx + 4, cy - r - 3)
    }
    // 方位十字与刻度
    for (const deg of [0, 90, 180, 270]) {
      const rad = (deg * Math.PI) / 180
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + radius * Math.sin(rad), cy - radius * Math.cos(rad))
      ctx.stroke()
      const labels = ['N', 'E', 'S', 'W']
      ctx.fillText(labels[deg / 90], cx + radius * Math.sin(rad) - 4, cy - radius * Math.cos(rad) + (deg === 0 ? -6 : 14))
    }
  }

  // 鼠标移动 HUD：显示方位与距离
  const onMove = (ev: MouseEvent): void => {
    if (!ps.volume) return
    const p = screenToPolar(canvas, ev.clientX, ev.clientY, ps.displayRangeM)
    if (p.rangeM > ps.displayRangeM) return
    hud.innerHTML = `方位 ${p.azimuthDeg.toFixed(1)}° · 距离 ${(p.rangeM / 1000).toFixed(2)} km`
  }
  canvasWrap.addEventListener('mousemove', onMove)
  const hud = h('div', { className: 'overlay-hud' }, ['移动鼠标读取方位/距离'])
  canvasWrap.append(hud)

  const onResize = (): void => scheduleDraw()
  window.addEventListener('resize', onResize)

  async function init(): Promise<void> {
    const selectedId = appStore.getState().selectedVolumeId
    if (!selectedId) {
      buildSidePanel()
      return
    }
    loading.hidden = false
    try {
      ps.volume = await loadVolume(selectedId)
      gl = createGl(canvas)
      renderer = new PolarRenderer(gl)
      if (ps.dealias) runDealias()
      // 地物杂波过滤：PPI 低仰角直接屏蔽静态图标记库
      if (appStore.getState().clutterFilterEnabled) applyClutterFilter()
      buildSidePanel()
      scheduleDraw()
    } catch (err) {
      toast((err as Error).message, 'error')
      buildSidePanel()
    } finally {
      loading.hidden = true
    }
  }

  function applyClutterFilter(): void {
    if (!ps.volume) return
    const maps = getLowElevationClutter()
    ps.volume.sweeps.forEach((sweep) => {
      const map = maps.find((m) => Math.abs(m.elevationDeg - sweep.elevationDeg) < 0.05)
      if (!map) return
      sweep.rays.forEach((ray, az) => {
        for (let g = 0; g < map.gateCount; g++) {
          if (map.flags[az * map.gateCount + g] === 1) {
            ray.fields.dbz[g] = MISSING_U8
            ray.fields.vel[g] = MISSING_U8
            ray.fields.width[g] = MISSING_U8
          }
        }
      })
    })
  }

  void init()

  return {
    dispose() {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      overlays.forEach((o) => o.dispose())
      renderer?.dispose()
      rhiRenderer?.dispose()
    },
  }
}
