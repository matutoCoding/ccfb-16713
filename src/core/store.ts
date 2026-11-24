// 极简发布订阅状态容器，不引第三方库
export interface AppState {
  selectedVolumeId: string | null
  selectedField: 'dbz' | 'vel' | 'width'
  clutterFilterEnabled: boolean
  terrainEnabled: boolean
  cityEnabled: boolean
  gridDxM: number
  isoThresholdDbz: number
  volumeOpacity: number
  animationSpeed: number
  autoDealias: boolean
}

const STORAGE_KEY = 'radar-workbench-settings'

const DEFAULT_STATE: AppState = {
  selectedVolumeId: null,
  selectedField: 'dbz',
  clutterFilterEnabled: true,
  terrainEnabled: true,
  cityEnabled: true,
  gridDxM: 200,
  isoThresholdDbz: 35,
  volumeOpacity: 0.55,
  animationSpeed: 1,
  autoDealias: true,
}

type Listener = (state: AppState) => void

class Store {
  private state: AppState
  private listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULT_STATE, ...this.loadPersisted() }
  }

  private loadPersisted(): Partial<AppState> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as Partial<AppState>) : {}
    } catch {
      return {}
    }
  }

  getState(): AppState {
    return this.state
  }

  setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    const persist: Record<string, unknown> = { ...this.state }
    delete persist.selectedVolumeId
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist))
    this.listeners.forEach((l) => l(this.state))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const appStore = new Store()
