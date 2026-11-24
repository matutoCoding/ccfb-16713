import { appStore } from '../core/store'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import { refreshList } from '../services/data_service'
import { runPipeline, getCached } from '../services/pipeline'
import { getSyntheticClutterMaps } from '../services/clutter_service'
import { identifyCells, linkTracks } from '../core/cell_tracker'
import { resizeCanvas } from '../services/view_helper'
import { createGl } from '../webgl/gl_utils'
import { ProductRenderer } from '../webgl/product_renderer'
import type { CellTrack, ProductGrid, StormCell, VolumeMeta } from '../core/types'

interface AnimationFrame {
  meta: VolumeMeta
  cr: ProductGrid
  cells: StormCell[]
}

export function animationPage(container: HTMLElement): Disposable {
  let renderer: ProductRenderer | null = null
  let gl: WebGL2RenderingContext | null = null
  const canvas = h('canvas', {}) as HTMLCanvasElement
  const overlay = h('canvas', {
    style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none',
  }) as HTMLCanvasElement
  const canvasWrap = h('div', { className: 'viewer-canvas-wrap' }, [canvas, overlay])
  const loading = h('div', { className: 'loading-mask' }, [
    h('div', { className: 'spinner' }),
    h('span', { id: 'anim-loading-text' }, ['预处理体扫序列...']),
  ])
  canvasWrap.append(loading)

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['动画回放与单体追踪']),
      h('p', { className: 'page-subtitle' }, ['连续体扫组合反射率动画，自动识别 45dBZ 以上风暴单体并跨时刻匹配轨迹']),
    ]),
  ])

  const side = h('div', { className: 'viewer-side' })
  const layout = h('div', { className: 'viewer-layout' }, [canvasWrap, side])
  container.append(header, layout)

  let frames: AnimationFrame[] = []
  let tracks: CellTrack[] = []
  let index = 0
  let playing = false
  let timer = 0
  let disposed = false

  function panel(title: string, children: HTMLElement[]): HTMLElement {
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, [title]),
      ...children,
    ])
  }

  const timeLabel = h('div', { className: 'stat-value', style: 'font-size:16px' }, ['-'])
  const cellLabel = h('div', { className: 'stat-label' }, ['单体数 -'])
  const playBtn = h('button', { className: 'btn btn-primary', style: 'flex:1' }, [icon('play'), '播放'])
  const prevBtn = h('button', { className: 'btn' }, ['上一帧'])
  const nextBtn = h('button', { className: 'btn' }, ['下一帧'])
  const speedSelect = h('select', {}, [
    h('option', { value: '0.5' }, ['0.5x']),
    h('option', { value: '1' }, ['1x']),
    h('option', { value: '2' }, ['2x']),
    h('option', { value: '4' }, ['4x']),
  ]) as HTMLSelectElement
  speedSelect.value = String(appStore.getState().animationSpeed)

  const trackList = h('div', { style: 'max-height:240px;overflow:auto;font-size:14px' })

  function buildSidePanel(): void {
    clear(side)
    side.append(
      panel('回放', [
        timeLabel,
        h('div', { style: 'height:8px' }),
        cellLabel,
        h('div', { style: 'height:12px' }),
        h('div', { className: 'toolbar' }, [prevBtn, playBtn, nextBtn]),
        h('div', { style: 'height:8px' }),
        h('div', { className: 'form-row' }, [h('span', { className: 'form-label' }, ['播放速度']), speedSelect]),
      ]),
      panel('追踪到的单体', [trackList]),
    )
  }

  playBtn.addEventListener('click', () => {
    if (frames.length === 0) return
    playing = !playing
    playBtn.replaceChildren(document.createTextNode(playing ? '暂停' : '播放'))
    if (playing) scheduleTick()
    else window.clearTimeout(timer)
  })
  prevBtn.addEventListener('click', () => jumpTo(index - 1))
  nextBtn.addEventListener('click', () => jumpTo(index + 1))
  speedSelect.addEventListener('change', () => {
    appStore.setState({ animationSpeed: Number(speedSelect.value) })
  })

  function scheduleTick(): void {
    window.clearTimeout(timer)
    if (!playing) return
    const interval = 1200 / Number(speedSelect.value)
    timer = window.setTimeout(() => {
      if (disposed) return
      jumpTo(index + 1)
      scheduleTick()
    }, interval)
  }

  function jumpTo(i: number): void {
    if (frames.length === 0) return
    index = (i + frames.length) % frames.length
    renderFrame()
  }

  function renderFrame(): void {
    if (!gl || !renderer || frames.length === 0) return
    const frame = frames[index]
    const size = resizeCanvas(canvas)
    gl.viewport(0, 0, size.width, size.height)
    renderer.render(frame.cr)
    overlay.width = size.width
    overlay.height = size.height
    timeLabel.textContent = frame.meta.scanTimeIso.replace('T', ' ').slice(0, 19)
    cellLabel.textContent = `单体数 ${frame.cells.length}`
    drawTrackOverlay(frame)
  }

  // 单体编号与历史轨迹叠加
  function drawTrackOverlay(frame: AnimationFrame): void {
    const ctx = overlay.getContext('2d')
    if (!ctx) return
    const w = overlay.width
    const h = overlay.height
    ctx.clearRect(0, 0, w, h)
    const cr = frame.cr
    const toPx = (xM: number, yM: number): [number, number] => {
      const nx = (xM - cr.originXM) / (cr.nx * cr.dxM)
      const ny = (yM - cr.originYM) / (cr.ny * cr.dyM)
      return [nx * w, h - ny * h]
    }
    // 轨迹线
    ctx.lineWidth = 1.5
    for (const track of tracks) {
      if (track.points.length < 2) continue
      ctx.strokeStyle = 'rgba(56,189,248,0.7)'
      ctx.beginPath()
      track.points.forEach((p, i) => {
        const [x, y] = toPx(p.xM, p.yM)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    // 当前帧单体编号
    ctx.font = 'bold 13px sans-serif'
    ctx.fillStyle = '#f8fafc'
    ctx.strokeStyle = 'rgba(2,6,23,0.9)'
    for (const cell of frame.cells) {
      const [x, y] = toPx(cell.xM, cell.yM)
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#fbbf24'
      ctx.fill()
      ctx.stroke()
      ctx.strokeText(`#${cell.id}`, x + 8, y - 6)
      ctx.fillText(`#${cell.id}`, x + 8, y - 6)
    }
  }

  async function preprocess(): Promise<void> {
    const state = appStore.getState()
    const all = await refreshList()
    const stationId = all.find((m) => m.id === state.selectedVolumeId)?.stationId
    const sequence = all
      .filter((m) => (stationId ? m.stationId === stationId : true))
      .sort((a, b) => a.scanTimeIso.localeCompare(b.scanTimeIso))
      .slice(-12)
    if (sequence.length < 2) {
      toast('至少需要 2 个体扫才能播放动画，先去合成一组序列', 'error', 5000)
      loading.remove()
      return
    }

    const built: AnimationFrame[] = []
    for (let i = 0; i < sequence.length; i++) {
      const meta = sequence[i]
      loading.querySelector('span')!.textContent = `预处理 ${i + 1}/${sequence.length}：${meta.scanTimeIso.slice(11, 19)}`
      let processed = getCached(meta.id)?.processed
      if (!processed) {
        const result = await runPipeline(meta.id, getSyntheticClutterMaps(), {
          clutterFilterEnabled: state.clutterFilterEnabled,
          dxM: state.gridDxM,
        })
        processed = result.processed
      }
      const cells = identifyCells(processed.products.cr)
      built.push({ meta, cr: processed.products.cr, cells })
    }

    const linked = linkTracks(
      built.map((f) => ({ timeIso: f.meta.scanTimeIso, cells: f.cells })),
    )
    linked.labeledFrames.forEach((labeled, i) => {
      built[i].cells = labeled
    })
    tracks = linked.tracks
    frames = built
    index = 0

    gl = createGl(canvas)
    renderer = new ProductRenderer(gl)
    buildSidePanel()
    renderTrackList()
    renderFrame()
    loading.remove()
    toast(`序列就绪：${frames.length} 帧，识别 ${tracks.length} 条单体轨迹`, 'success')
  }

  function renderTrackList(): void {
    clear(trackList)
    if (tracks.length === 0) {
      trackList.append(h('div', { className: 'stat-label' }, ['未发现达到阈值的单体']))
      return
    }
    tracks.forEach((track) => {
      const first = track.points[0]
      const last = track.points[track.points.length - 1]
      const dist = Math.hypot(last.xM - first.xM, last.yM - first.yM) / 1000
      const row = h('div', {
        style: 'display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)',
      }, [
        h('span', { style: 'color:var(--primary);font-weight:600' }, [`#${track.id}`]),
        h('span', { className: 'stat-label' }, [
          `${track.points.length} 帧 · 移动 ${dist.toFixed(1)} km`,
        ]),
      ])
      trackList.append(row)
    })
  }

  const onResize = (): void => renderFrame()
  window.addEventListener('resize', onResize)
  buildSidePanel()
  void preprocess()

  return {
    dispose() {
      disposed = true
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      renderer?.dispose()
    },
  }
}
