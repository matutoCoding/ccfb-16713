import { h } from './components'

type ToastKind = 'info' | 'error' | 'success'

let host: HTMLDivElement | null = null

function ensureHost(): HTMLDivElement {
  if (host) return host
  host = h('div', { className: 'toast-host' })
  document.body.append(host)
  return host
}

export function toast(message: string, kind: ToastKind = 'info', durationMs = 3600): void {
  const el = h('div', { className: `toast ${kind === 'info' ? '' : kind}` }, [message])
  ensureHost().append(el)
  window.setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity 0.2s'
    window.setTimeout(() => el.remove(), 220)
  }, durationMs)
}
