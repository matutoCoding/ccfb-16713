import type { ClutterMap, VolumeMeta } from './types'

const DB_NAME = 'radar-workbench-db'
const DB_VERSION = 1
const STORE_VOLUME = 'volumes'
const STORE_META = 'meta'
const STORE_CLUTTER = 'clutter'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_VOLUME)) db.createObjectStore(STORE_VOLUME)
      if (!db.objectStoreNames.contains(STORE_META)) {
        const store = db.createObjectStore(STORE_META, { keyPath: 'id' })
        store.createIndex('scanTimeIso', 'scanTimeIso')
        store.createIndex('stationId', 'stationId')
      }
      if (!db.objectStoreNames.contains(STORE_CLUTTER)) db.createObjectStore(STORE_CLUTTER)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode)
        const req = fn(t.objectStore(storeName))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function saveVolume(id: string, buf: ArrayBuffer, meta: VolumeMeta): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_VOLUME, STORE_META], 'readwrite')
    t.objectStore(STORE_VOLUME).put(buf, id)
    t.objectStore(STORE_META).put(meta)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function loadVolumeBytes(id: string): Promise<ArrayBuffer | undefined> {
  return tx(STORE_VOLUME, 'readonly', (s) => s.get(id) as IDBRequest<ArrayBuffer | undefined>)
}

export async function listVolumeMeta(): Promise<VolumeMeta[]> {
  return tx(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<VolumeMeta[]>)
}

export async function deleteVolume(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_VOLUME, STORE_META], 'readwrite')
    t.objectStore(STORE_VOLUME).delete(id)
    t.objectStore(STORE_META).delete(id)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function saveClutter(map: ClutterMap): Promise<void> {
  await tx(STORE_CLUTTER, 'readwrite', (s) =>
    s.put(map, `${map.stationId}:${map.elevationDeg}`),
  )
}

export async function loadClutter(
  stationId: string,
  elevationDeg: number,
): Promise<ClutterMap | undefined> {
  return tx(STORE_CLUTTER, 'readonly', (s) =>
    s.get(`${stationId}:${elevationDeg}`) as IDBRequest<ClutterMap | undefined>,
  )
}

export async function dbEstimateBytes(): Promise<number> {
  if (!navigator.storage?.estimate) return 0
  const est = await navigator.storage.estimate()
  return est.usage ?? 0
}
