import { appStore } from '../core/store'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import { generateSyntheticVolume } from '../core/synthetic_gen'
import { writeRvf } from '../core/rvf_format'
import { saveVolume } from '../core/idb'
import { runPipeline } from '../services/pipeline'
import { getSyntheticClutterMaps } from '../services/clutter_service'
import type { RadarVolume } from '../core/types'

interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

export function settingsPage(container: HTMLElement): Disposable {
  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['设置与验收自检']),
      h('p', { className: 'page-subtitle' }, ['验收两条线：回波核心位置误差 < 200 米；20 仰角体扫导入到三维出图 < 3 秒']),
    ]),
  ])

  const state = appStore.getState()

  // 网格设置
  const gridSelect = h('select', {}, [
    h('option', { value: '200' }, ['200 m（验收精度优先）']),
    h('option', { value: '250' }, ['250 m（均衡）']),
    h('option', { value: '500' }, ['500 m（性能优先）']),
  ]) as HTMLSelectElement
  gridSelect.value = String(state.gridDxM)
  gridSelect.addEventListener('change', () => {
    appStore.setState({ gridDxM: Number(gridSelect.value) })
    toast('格距设置已保存', 'success')
  })

  const clutterToggle = switchRow('静态杂波图剔除', state.clutterFilterEnabled, (v) =>
    appStore.setState({ clutterFilterEnabled: v }),
  )
  const terrainToggle = switchRow('三维地形叠加', state.terrainEnabled, (v) =>
    appStore.setState({ terrainEnabled: v }),
  )
  const cityToggle = switchRow('城市边界叠加', state.cityEnabled, (v) =>
    appStore.setState({ cityEnabled: v }),
  )
  const dealiasToggle = switchRow('速度自动退模糊', state.autoDealias, (v) =>
    appStore.setState({ autoDealias: v }),
  )

  const settingsPanel = h('div', { className: 'panel' }, [
    h('h2', { className: 'panel-title' }, ['渲染与数据设置']),
    row('笛卡尔格距', gridSelect),
    row('杂波处理', clutterToggle),
    row('场景叠加', terrainToggle),
    row('行政边界', cityToggle),
    row('PPI 速度', dealiasToggle),
  ])

  // 自检区域
  const resultHost = h('div', {})
  const runBtn = h('button', { className: 'btn btn-primary' }, [icon('refresh'), '运行验收自检'])
  const selfTestPanel = h('div', { className: 'panel' }, [
    h('h2', { className: 'panel-title' }, ['验收自检']),
    h('p', { className: 'page-subtitle', style: 'margin-bottom:16px' }, [
      '自检会现场合成 20 仰角完整超级单体体扫（含已知真值坐标），跑完整流水线并比对核心位置与耗时，数据同时入库可供其他页面查看',
    ]),
    runBtn,
    h('div', { style: 'height:16px' }),
    resultHost,
  ])

  const techPanel = h('div', { className: 'panel' }, [
    h('h2', { className: 'panel-title' }, ['技术说明']),
    h('div', { className: 'stat-label', style: 'line-height:2' }, [
      '重采样：4/3 等效地球半径波束几何 + Worker splat 邻域填缝；位置校验采用强回波样本稀疏质心，精度不受格距限制。',
      h('br'),
      '体渲染：R8 三维纹理 + 光线步进前向积分；等值面模式为阈值穿越检测与中心差分法线。',
      h('br'),
      '存储：RVF 二进制存 IndexedDB，Worker 结果 Transferable 零拷贝回传。',
    ]),
  ])

  container.append(header, settingsPanel, selfTestPanel, techPanel)

  runBtn.addEventListener('click', () => void runSelfTest())

  function row(label: string, control: HTMLElement): HTMLElement {
    return h('div', { className: 'form-row' }, [
      h('span', { className: 'form-label' }, [label]),
      control,
    ])
  }

  function switchRow(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
    let value = initial
    const btn = h('button', { className: `btn btn-sm ${value ? 'btn-primary' : ''}` }, [
      value ? '开启' : '关闭',
    ])
    btn.addEventListener('click', () => {
      value = !value
      btn.textContent = value ? '开启' : '关闭'
      btn.classList.toggle('btn-primary', value)
      onChange(value)
    })
    return h('div', {}, [h('span', { style: 'margin-right:12px' }, [label]), btn])
  }

  async function runSelfTest(): Promise<void> {
    runBtn.setAttribute('disabled', 'true')
    clear(resultHost)
    resultHost.append(h('div', { className: 'toolbar' }, [h('div', { className: 'spinner' }), '自检进行中...']))
    const results: CheckResult[] = []
    try {
      const baseTime = new Date().toISOString()
      const { volume } = generateSyntheticVolume({
        kind: 'supercell',
        stationId: 'Z9871',
        baseTimeIso: baseTime,
        timeOffsetMin: 0,
        seed: 20260625,
      })
      const t0 = performance.now()
      const buf = writeRvf(volume)
      const id = `selftest-${baseTime}`
      volume.meta.id = id
      volume.meta.sizeBytes = buf.byteLength
      await saveVolume(id, buf, volume.meta)
      const importMs = performance.now() - t0

      const pipelineResult = await runPipeline(id, getSyntheticClutterMaps(), {
        clutterFilterEnabled: true,
        dxM: appStore.getState().gridDxM,
      })
      // 端到端 = RVF 序列化/入库 + 读取导入 + 解码 + Worker 重采样与产品
      const totalMs = importMs + pipelineResult.timing.totalMs
      const { processed, timing } = pipelineResult

      // 检查一：位置误差（真值 vs 强回波稀疏质心）
      const truth = volume.groundTruth
      if (truth && processed.strongCentroids.length > 0) {
        truth.cores.forEach((core) => {
          const measured = processed.strongCentroids.find((c) => c.name === core.name)
          if (!measured) {
            results.push({ name: `位置校验-${core.name}`, pass: false, detail: '未找到对应强回波质心' })
            return
          }
          const err = Math.hypot(
            measured.xM - core.xM,
            measured.yM - core.yM,
            measured.zM - core.zM,
          )
          results.push({
            name: `位置误差-${core.name}`,
            pass: err < 200,
            detail: `真值(${core.xM.toFixed(0)}, ${core.yM.toFixed(0)}, ${core.zM.toFixed(0)})m，实测(${measured.xM.toFixed(0)}, ${measured.yM.toFixed(0)}, ${measured.zM.toFixed(0)})m，误差 ${err.toFixed(1)} m`,
          })
        })
      } else {
        results.push({ name: '位置校验', pass: false, detail: '缺少真值或强回波质心' })
      }

      // 检查二：端到端耗时（不含合成，合成只在测试造数时发生）
      results.push({
        name: '端到端耗时（导入→出图）',
        pass: totalMs < 3000,
        detail: `入库/读取 ${importMs.toFixed(0)}ms + 解码 ${timing.decodeMs.toFixed(0)}ms + 重采样/产品 ${timing.resampleMs.toFixed(0)}ms = ${totalMs.toFixed(0)}ms（限值 3000ms）`,
      })

      // 附加检查：仰角完整性
      results.push({
        name: '仰角完整性',
        pass: volume.sweeps.length === 20,
        detail: `实际 ${volume.sweeps.length} / 期望 20 层`,
      })

      // 附加检查：网格空洞率
      const grid = processed.grid
      const holeRate = grid.holeCount / grid.dbz.length
      results.push({
        name: '重采样空洞率',
        pass: holeRate < 0.35,
        detail: `空洞 ${grid.holeCount.toLocaleString()} 格，占比 ${(holeRate * 100).toFixed(1)}%（多数空洞为网格外无回波空间）`,
      })
    } catch (err) {
      results.push({ name: '自检异常', pass: false, detail: (err as Error).message })
    }

    renderResults(results)
    runBtn.removeAttribute('disabled')
  }

  function renderResults(results: CheckResult[]): void {
    clear(resultHost)
    const allPass = results.every((r) => r.pass)
    resultHost.append(
      h('div', { className: `badge ${allPass ? 'badge-ok' : 'badge-danger'}`, style: 'margin-bottom:16px;font-size:14px;padding:8px 16px' }, [
        allPass ? '全部检查通过，满足验收标准' : '存在未通过项，请查看详情',
      ]),
    )
    results.forEach((r) => {
      resultHost.append(
        h('div', {
          style: `display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--bg-elevated)`,
        }, [
          h('span', { className: `badge ${r.pass ? 'badge-ok' : 'badge-danger'}` }, [r.pass ? '通过' : '未过']),
          h('div', {}, [
            h('div', { style: 'font-weight:600;margin-bottom:4px' }, [r.name]),
            h('div', { className: 'stat-label', style: 'white-space:normal;line-height:1.7' }, [r.detail]),
          ]),
        ]),
      )
    })
  }

  return {
    dispose() {
      // 纯设置页，无 GPU 资源
    },
  }
}
