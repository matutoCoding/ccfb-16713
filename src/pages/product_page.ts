import { appStore } from '../core/store'
import { MISSING_U8, decodeDbz, decodeEt, decodeVil } from '../core/codec'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import { runPipeline } from '../services/pipeline'
import { resizeCanvas } from '../services/view_helper'
import { getSyntheticClutterMaps } from '../services/clutter_service'
import { createGl } from '../webgl/gl_utils'
import { ProductRenderer } from '../webgl/product_renderer'
import type { ProcessedVolume, ProductGrid } from '../core/types'

type ProductKind = 'cr' | 'et' | 'vil'

const TITLES: Record<ProductKind, string> = {
  cr: '组合反射率 CR',
  et: '回波顶高 ET（18.3dBZ）',
  vil: '垂直积分液态水 VIL',
}

export function productPage(container: HTMLElement): Disposable {
  let gl: WebGL2RenderingContext | null = null
  let renderer: ProductRenderer | null = null
  let processed: ProcessedVolume | null = null
  let kind: ProductKind = 'cr'
  const canvas = h('canvas', {}) as HTMLCanvasElement
  const canvasWrap = h('div', { className: 'viewer-canvas-wrap' }, [canvas])
  const loading = h('div', { className: 'loading-mask' }, [
    h('div', { className: 'spinner' }),
    h('span', {}, ['计算产品中...']),
  ])
  canvasWrap.append(loading)

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['产品计算']),
      h('p', { className: 'page-subtitle' }, ['重采样同一趟计算组合反射率、回波顶高与垂直积分液态水含量']),
    ]),
  ])

  const side = h('div', { className: 'viewer-side' })
  const layout = h('div', { className: 'viewer-layout' }, [canvasWrap, side])
  container.append(header, layout)

  function panel(title: string, children: HTMLElement[]): HTMLElement {
    return h('div', { className: 'panel', style: 'padding:16px' }, [
      h('div', { className: 'panel-title', style: 'font-size:16px;margin-bottom:12px' }, [title]),
      ...children,
    ])
  }

  function buildSidePanel(): void {
    clear(side)
    const tabs = (['cr', 'et', 'vil'] as ProductKind[]).map((k) => {
      const btn = h(
        'button',
        { className: `btn btn-sm ${kind === k ? 'btn-primary' : ''}`, style: 'flex:1' },
        [k.toUpperCase()],
      )
      btn.addEventListener('click', () => {
        kind = k
        buildSidePanel()
        draw()
      })
      return btn
    })

    const exportPng = h('button', { className: 'btn', style: 'width:100%' }, [icon('download'), '导出产品图 PNG'])
    exportPng.addEventListener('click', () => {
      const a = h('a', { href: canvas.toDataURL('image/png'), download: `${kind}-${Date.now()}.png` }) as HTMLAnchorElement
      a.click()
    })
    const exportCsv = h('button', { className: 'btn', style: 'width:100%' }, [icon('download'), '导出格点数据 CSV'])
    exportCsv.addEventListener('click', () => exportGridCsv())

    side.append(
      panel('产品切换', [h('div', { className: 'toolbar' }, tabs)]),
      panel('当前产品', [h('div', { className: 'stat-label', style: 'line-height:1.8' }, [TITLES[kind]])]),
      panel('导出', [exportPng, h('div', { style: 'height:8px' }), exportCsv]),
      processed ? buildStatsPanel() : h('span'),
    )
  }

  function buildStatsPanel(): HTMLElement {
    const product = processed?.products[kind]
    if (!product) return h('span')
    let max = -Infinity
    let valid = 0
    for (const code of product.values) {
      if (code === MISSING_U8) continue
      valid++
      const v =
        kind === 'cr' ? decodeDbz(code) : kind === 'et' ? decodeEt(code) : decodeVil(code)
      if (Number.isFinite(v) && v > max) max = v
    }
    const unit = kind === 'cr' ? 'dBZ' : kind === 'et' ? 'm' : 'kg/m2'
    return panel('统计', [
      h('div', { className: 'stat-grid' }, [
        stat('有效格点', String(valid)),
        stat(`最大值（${unit}）`, Number.isFinite(max) ? max.toFixed(1) : '-'),
        stat('格距', `${product.dxM} m`),
      ]),
    ])
  }

  function stat(label: string, value: string): HTMLElement {
    return h('div', { className: 'stat-card' }, [
      h('div', { className: 'stat-label' }, [label]),
      h('div', { className: 'stat-value', style: 'font-size:18px' }, [value]),
    ])
  }

  function draw(): void {
    if (!gl || !renderer || !processed) return
    const size = resizeCanvas(canvas)
    gl.viewport(0, 0, size.width, size.height)
    renderer.render(processed.products[kind])
  }

  function exportGridCsv(): void {
    if (!processed) return
    const product: ProductGrid = processed.products[kind]
    const decode =
      kind === 'cr' ? decodeDbz : kind === 'et' ? decodeEt : decodeVil
    const lines: string[] = ['index_x,index_y,x_m,y_m,value']
    for (let y = 0; y < product.ny; y++) {
      for (let x = 0; x < product.nx; x++) {
        const code = product.values[y * product.nx + x]
        if (code === MISSING_U8) continue
        const xM = product.originXM + (x + 0.5) * product.dxM
        const yM = product.originYM + (y + 0.5) * product.dyM
        lines.push(`${x},${y},${xM.toFixed(1)},${yM.toFixed(1)},${decode(code).toFixed(2)}`)
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: `${kind}-grid-${Date.now()}.csv` }) as HTMLAnchorElement
    a.click()
    URL.revokeObjectURL(url)
    toast('格点 CSV 已导出', 'success')
  }

  const onResize = (): void => draw()
  window.addEventListener('resize', onResize)

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
      renderer = new ProductRenderer(gl)
      buildSidePanel()
      draw()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      loading.remove()
    }
  }

  buildSidePanel()
  void init()

  return {
    dispose() {
      window.removeEventListener('resize', onResize)
      renderer?.dispose()
    },
  }
}
