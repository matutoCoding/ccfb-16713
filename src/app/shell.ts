import { icon, h } from '../ui/components'
import { currentRoute, navigate, onRouteChange, type RouteName } from './router'

const NAV: { name: RouteName; label: string; icon: string }[] = [
  { name: 'data', label: '数据管理', icon: 'data' },
  { name: 'ppi', label: 'PPI / RHI', icon: 'ppi' },
  { name: 'volume', label: '三维体渲染', icon: 'cube' },
  { name: 'profile', label: '剖面分析', icon: 'slice' },
  { name: 'product', label: '产品计算', icon: 'chart' },
  { name: 'animation', label: '动画回放', icon: 'play' },
  { name: 'settings', label: '设置与自检', icon: 'settings' },
]

export function mountShell(root: HTMLElement): HTMLElement {
  const navButtons = NAV.map((item) => {
    const btn = h(
      'button',
      { className: 'nav-item', 'data-route': item.name },
      [icon(item.icon), h('span', {}, [item.label])],
    )
    btn.addEventListener('click', () => navigate(item.name))
    return btn
  })

  const sidebar = h('aside', { className: 'sidebar' }, [
    h('div', { className: 'sidebar-title' }, [
      document.createTextNode('雷达'),
      h('span', { className: 'accent' }, ['三维工作台']),
    ]),
    ...navButtons,
    h('div', { className: 'sidebar-footer' }, ['WebGL2 体渲染 · 本地数据不出浏览器']),
  ])

  const pageContainer = h('main', { className: 'page' })
  const shell = h('div', { className: 'app-shell' }, [sidebar, pageContainer])
  root.append(shell)

  const highlight = (): void => {
    const active = currentRoute()
    navButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.route === active)
    })
  }
  onRouteChange(highlight)
  highlight()
  return pageContainer
}
