// 统一 1.7 线宽线性图标，禁 emoji
const PATHS: Record<string, string> = {
  data: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ppi: 'M12 3v18M3 12h18M5.6 5.6a9 9 0 1 0 12.8 0M8.5 8.5a5 5 0 1 0 7 0',
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5',
  slice: 'M4 20 20 4M4 20h6M4 20v-6M14 10l4 4',
  chart: 'M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-8',
  play: 'M6 4l14 8-14 8V4Z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2L15 3H9l-.5 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2L9 21h6l.5-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 11V5m0 6h-6',
  download: 'M12 4v12m0 0 5-5m-5 5-5-5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  warning: 'M12 3 2 20h20L12 3Zm0 7v4m0 3v.5',
}

export function icon(name: keyof typeof PATHS | string, size = 18): string {
  const path = PATHS[name]
  if (!path) return ''
  return `<svg class="nav-icon" width="${size}" height="${size}" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
}

// 极简 DOM 构造
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v
    else el.setAttribute(k, v)
  }
  for (const child of children) {
    el.append(child instanceof Node ? child : document.createTextNode(child))
  }
  return el
}

export function clear(el: HTMLElement): void {
  el.replaceChildren()
}

// 卸载保护：页面切换时统一回收 WebGL 资源与事件
export interface Disposable {
  dispose(): void
}
