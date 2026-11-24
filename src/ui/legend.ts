import { DBZ_COLOR_LEVELS, VEL_COLOR_LEVELS, WIDTH_COLOR_LEVELS } from '../core/constants'
import type { FieldType } from '../core/types'
import { h } from './components'

function cssColor(c: readonly number[]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

// 反射率/速度/谱宽分级色标条
export function fieldLegend(field: FieldType): HTMLElement {
  const levels =
    field === 'dbz'
      ? DBZ_COLOR_LEVELS
      : field === 'vel'
        ? VEL_COLOR_LEVELS
        : WIDTH_COLOR_LEVELS
  const gradient = levels.map((l, i) => {
    const pct = (i / (levels.length - 1)) * 100
    return `${cssColor(l.color)} ${pct.toFixed(1)}%`
  })
  const bar = h('div', {
    className: 'legend-bar',
    style: `background: linear-gradient(90deg, ${gradient.join(',')})`,
  })
  const ticks = h(
    'div',
    { className: 'legend-ticks' },
    [
      String(levels[0].value),
      String(levels[Math.floor(levels.length / 2)].value),
      String(levels[levels.length - 1].value),
    ].map((t) => h('span', {}, [t])),
  )
  return h('div', { className: 'legend' }, [bar, ticks])
}
