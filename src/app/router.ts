import type { Disposable } from '../ui/components'

export type RouteName =
  | 'data'
  | 'ppi'
  | 'volume'
  | 'profile'
  | 'product'
  | 'animation'
  | 'settings'

export interface RouteTarget {
  name: RouteName
  mount(container: HTMLElement): Disposable | Promise<Disposable>
}

const routes = new Map<RouteName, RouteTarget>()
let current: Disposable | null = null
let container: HTMLElement | null = null
const changeListeners = new Set<(name: RouteName) => void>()

export function registerRoute(target: RouteTarget): void {
  routes.set(target.name, target)
}

export function navigate(name: RouteName): void {
  window.location.hash = name
}

export function currentRoute(): RouteName {
  const name = window.location.hash.replace('#', '') as RouteName
  return routes.has(name) ? name : 'data'
}

export function onRouteChange(fn: (name: RouteName) => void): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

async function render(): Promise<void> {
  if (!container) return
  const name = currentRoute()
  const target = routes.get(name)
  if (!target) return
  current?.dispose()
  current = null
  container.replaceChildren()
  const instance = await target.mount(container)
  current = instance
  changeListeners.forEach((fn) => fn(name))
}

export function startRouter(mountPoint: HTMLElement): void {
  container = mountPoint
  window.addEventListener('hashchange', () => {
    void render()
  })
  if (!window.location.hash) window.location.hash = 'data'
  void render()
}
