import { DB_NAME, DB_VERSION } from '../config.js'

let _db = null

export async function openDB() {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => { _db = req.result; resolve(_db) }
    req.onupgradeneeded = e => {
      const db = e.target.result

      // Fotos: índice principal
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' })
        store.createIndex('sourceId', 'sourceId', { unique: false })
        store.createIndex('takenAt', 'takenAt', { unique: false })
        store.createIndex('projectId', 'projectId', { unique: false })
      }

      // Proyectos
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }

      // Etiquetas
      if (!db.objectStoreNames.contains('tags')) {
        db.createObjectStore('tags', { keyPath: 'id' })
      }

      // Fuentes (OneDrive carpeta / carpeta local)
      if (!db.objectStoreNames.contains('sources')) {
        db.createObjectStore('sources', { keyPath: 'id' })
      }

      // Miniaturas de fotos locales (blobs)
      if (!db.objectStoreNames.contains('thumbnails')) {
        db.createObjectStore('thumbnails', { keyPath: 'photoId' })
      }

      // Config general (deltaLinks, lastSync, etc.)
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' })
      }
    }
  })
}

// ── Helpers genéricos ──────────────────────────────────────────────────────

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName)
}

function promisify(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

export async function getAll(storeName) {
  await openDB()
  return promisify(tx(storeName).getAll())
}

export async function getOne(storeName, key) {
  await openDB()
  return promisify(tx(storeName).get(key))
}

export async function put(storeName, record) {
  await openDB()
  return promisify(tx(storeName, 'readwrite').put(record))
}

export async function putAll(storeName, records) {
  if (!records.length) return
  await openDB()
  const store = tx(storeName, 'readwrite')
  await Promise.all(records.map(r => promisify(store.put(r))))
}

export async function del(storeName, key) {
  await openDB()
  return promisify(tx(storeName, 'readwrite').delete(key))
}

export async function clearStore(storeName) {
  await openDB()
  return promisify(tx(storeName, 'readwrite').clear())
}

export async function getAllByIndex(storeName, indexName, value) {
  await openDB()
  return promisify(tx(storeName).index(indexName).getAll(value))
}

// ── Fotos ──────────────────────────────────────────────────────────────────

export async function getPhotos() { return getAll('photos') }

export async function savePhotos(photos) { return putAll('photos', photos) }

export async function savePhoto(photo) { return put('photos', photo) }

export async function deletePhoto(id) { return del('photos', id) }

export async function deletePhotosBySource(sourceId) {
  await openDB()
  const photos = await getAllByIndex('photos', 'sourceId', sourceId)
  const store = tx('photos', 'readwrite')
  await Promise.all(photos.map(p => promisify(store.delete(p.id))))
  return photos.length
}

// ── Proyectos ──────────────────────────────────────────────────────────────

export async function getProjects() { return getAll('projects') }

export async function saveProject(project) { return put('projects', project) }

export async function deleteProject(id) { return del('projects', id) }

// ── Etiquetas ──────────────────────────────────────────────────────────────

export async function getTags() { return getAll('tags') }

export async function saveTag(tag) { return put('tags', tag) }

export async function deleteTag(id) { return del('tags', id) }

// ── Fuentes ────────────────────────────────────────────────────────────────

export async function getSources() { return getAll('sources') }

export async function saveSource(source) { return put('sources', source) }

export async function deleteSource(id) {
  await del('sources', id)
  await deletePhotosBySource(id)
}

// ── Miniaturas ────────────────────────────────────────────────────────────

export async function getThumbnail(photoId) {
  await openDB()
  const r = await promisify(tx('thumbnails').get(photoId))
  return r?.blob || null
}

export async function saveThumbnail(photoId, blob) {
  return put('thumbnails', { photoId, blob })
}

// ── Config ────────────────────────────────────────────────────────────────

export async function getConfig(key) {
  await openDB()
  const r = await promisify(tx('config').get(key))
  return r?.value ?? null
}

export async function setConfig(key, value) {
  return put('config', { key, value })
}
