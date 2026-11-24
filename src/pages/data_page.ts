import { appStore } from '../core/store'
import type { Disposable } from '../ui/components'
import { h, icon, clear } from '../ui/components'
import { toast } from '../ui/toast'
import {
  importRvfFile,
  refreshList,
  removeVolume,
  storageUsageText,
  synthesizeAndStore,
} from '../services/data_service'
import { navigate } from '../app/router'
import type { VolumeMeta } from '../core/types'

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function dataPage(container: HTMLElement): Disposable {
  const state = appStore.getState()
  let list: VolumeMeta[] = []

  const header = h('div', { className: 'page-header' }, [
    h('div', {}, [
      h('h1', { className: 'page-title' }, ['数据管理']),
      h('p', { className: 'page-subtitle' }, ['导入 RVF 体扫文件，或合成已知结构的测试数据；全部存储在本地 IndexedDB']),
    ]),
  ])

  const fileInput = h('input', {
    type: 'file',
    accept: '.rvf',
    multiple: 'true',
    style: 'display:none',
  }) as HTMLInputElement

  const importBtn = h('button', { className: 'btn btn-primary' }, [icon('upload'), '导入 RVF 文件'])
  importBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files ?? [])
    for (const file of files) {
      try {
        const meta = await importRvfFile(file)
        if (files.length === 1) appStore.setState({ selectedVolumeId: meta.id })
      } catch (err) {
        toast(`${file.name} 导入失败：${(err as Error).message}`, 'error', 6000)
      }
    }
    fileInput.value = ''
    await loadTable()
  })

  const synthSelect = h('select', {}, [
    h('option', { value: 'supercell' }, ['超级单体（含悬垂/BWER）']),
    h('option', { value: 'squall' }, ['飑线']),
    h('option', { value: 'mixed' }, ['混合对流']),
    h('option', { value: 'broken' }, ['缺仰角容错场景']),
  ]) as HTMLSelectElement

  const countInput = h('input', { type: 'number', min: '1', max: '15', value: '12', style: 'width:80px' }) as HTMLInputElement
  const synthBtn = h('button', { className: 'btn' }, [icon('refresh'), '合成体扫序列'])
  synthBtn.addEventListener('click', async () => {
    synthBtn.setAttribute('disabled', 'true')
    try {
      const kind = synthSelect.value as VolumeMeta['note'] & string
      const n = Math.max(1, Math.min(15, Number(countInput.value) || 12))
      const stored = await synthesizeAndStore(
        kind as never,
        new Date().toISOString(),
        n,
      )
      toast(`已合成 ${stored} 个体扫并入库`, 'success')
      await loadTable()
    } catch (err) {
      toast(`合成失败：${(err as Error).message}`, 'error')
    } finally {
      synthBtn.removeAttribute('disabled')
    }
  })

  const toolbar = h('div', { className: 'panel' }, [
    h('div', { className: 'toolbar' }, [importBtn, fileInput, synthSelect, countInput, synthBtn]),
  ])

  const tableHost = h('div', { className: 'panel' })
  const storageEl = h('span', {}, ['统计中...'])

  async function loadTable(): Promise<void> {
    list = await refreshList()
    clear(tableHost)
    tableHost.append(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' }, [
        h('h2', { className: 'panel-title', style: 'margin:0' }, [`体扫列表（${list.length}）`]),
        storageEl,
      ]),
    )
    storageEl.textContent = `占用 ${await storageUsageText()}`

    if (list.length === 0) {
      tableHost.append(
        h('div', { className: 'empty-state' }, [
          icon('data', 48),
          h('div', { className: 'empty-title' }, ['还没有体扫数据']),
          h('div', { className: 'empty-desc' }, ['先合成一组已知结构的超级单体或飑线，再到 PPI、三维体渲染页面查看效果']),
        ]),
      )
      return
    }

    const rows = list.map((meta) => {
      const selected = state.selectedVolumeId === meta.id
      const tr = h('tr', { className: selected ? 'selected' : '' })
      const missingBadge =
        meta.missingElevations.length > 0
          ? h('span', { className: 'badge badge-warn' }, [`缺 ${meta.missingElevations.length} 仰角`])
          : h('span', { className: 'badge badge-ok' }, ['完整'])
      tr.append(
        h('td', {}, [meta.stationId]),
        h('td', {}, [formatTime(meta.scanTimeIso)]),
        h('td', {}, [`${meta.elevationCount}/${meta.expectedElevationCount}`]),
        h('td', {}, [missingBadge]),
        h('td', {}, [formatSize(meta.sizeBytes)]),
        h('td', {}, [meta.note ?? '-']),
      )
      const actionTd = h('td', {})
      const useBtn = h('button', { className: 'btn btn-sm btn-primary' }, ['选用'])
      useBtn.addEventListener('click', () => {
        appStore.setState({ selectedVolumeId: meta.id })
        void loadTable()
        toast(`已选用 ${formatTime(meta.scanTimeIso)} 的体扫`)
      })
      const delBtn = h('button', { className: 'btn btn-sm btn-danger' }, [icon('trash'), '删除'])
      delBtn.addEventListener('click', async () => {
        await removeVolume(meta.id)
        if (appStore.getState().selectedVolumeId === meta.id) {
          appStore.setState({ selectedVolumeId: null })
        }
        await loadTable()
      })
      actionTd.append(useBtn, h('span', { style: 'width:8px;display:inline-block' }), delBtn)
      tr.append(actionTd)
      tr.addEventListener('dblclick', () => {
        appStore.setState({ selectedVolumeId: meta.id })
        navigate('volume')
      })
      return tr
    })

    tableHost.append(
      h('div', { className: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', {}, ['站号']),
              h('th', {}, ['扫描时间']),
              h('th', {}, ['仰角']),
              h('th', {}, ['完整性']),
              h('th', {}, ['大小']),
              h('th', {}, ['场景']),
              h('th', {}, ['操作']),
            ]),
          ]),
          h('tbody', {}, rows),
        ]),
      ]),
    )
  }

  const hint = h('div', { className: 'panel' }, [
    h('h2', { className: 'panel-title' }, ['数据约定']),
    h('p', { style: 'color:var(--text-muted);line-height:1.9' }, [
      'RVF 为系统自定义二进制体扫格式（文件头 + 仰角目录 + 径向数据）。缺少仰角的文件会在完整性列标黄，但不影响其他仰角正常显示与重采样。双击行可直接跳转到三维体渲染。',
    ]),
  ])

  container.append(header, toolbar, tableHost, hint)
  void loadTable()

  return {
    dispose() {
      fileInput.remove()
    },
  }
}
