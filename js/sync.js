import { readAppFile, writeAppFile, getAppFileETag } from './graph.js'
import { getAccount } from './auth.js'
import {
  getPhotos, savePhotos, getProjects, saveProject, getTags, saveTag,
  getSources, saveSource, deleteSource, clearStore, getConfig, setConfig
} from './db.js'
import { setState, applyFilters } from './store.js'
import { APP_INDEX_FILE, APP_PROJECTS_FILE, APP_TAGS_FILE, APP_SOURCES_FILE } from '../config.js'

// eTag del índice en OneDrive la última vez que este dispositivo lo leyó o escribió
const ETAG_KEY = 'cloudIndexETag'

let _saveTimer = null
let _saving = null

// Trae del approot lo que otros dispositivos guardaron y lo combina con lo local.
// Devuelve true si cambió algo (el llamador decide si refrescar la vista).
export async function syncFromCloud() {
  if (!getAccount()) return false
  try {
    const etag = await getAppFileETag(APP_INDEX_FILE)
    if (!etag || etag === await getConfig(ETAG_KEY)) return false
    await mergeCloud()
    await setConfig(ETAG_KEY, etag)
    return true
  } catch (e) {
    console.warn('[sync] syncFromCloud error:', e.message)
    return false
  }
}

export async function reloadState() {
  const [photos, projects, tags, sources] = await Promise.all([getPhotos(), getProjects(), getTags(), getSources()])
  setState({ photos, projects, tags, sources })
  applyFilters()
}

async function mergeCloud() {
  const [idxData, projData, tagsData, srcData] = await Promise.all([
    readAppFile(APP_INDEX_FILE),
    readAppFile(APP_PROJECTS_FILE),
    readAppFile(APP_TAGS_FILE),
    readAppFile(APP_SOURCES_FILE),
  ])

  // Fuentes de OneDrive: la misma carpeta conectada en dos dispositivos debe ser una sola fuente
  const localSources = await getSources()
  for (const cs of srcData?.sources || []) {
    const same = localSources.find(s => s.type === 'onedrive' && s.driveId === cs.driveId && s.folderId === cs.folderId)
    if (!same) {
      await saveSource({ ...cs, status: 'ok' })
    } else if (same.id !== cs.id) {
      // Sus fotos vienen en el índice de la nube con el id de la otra fuente
      await deleteSource(same.id)
      await saveSource({ ...same, id: cs.id })
    }
  }

  // Tras unificar fuentes, toda fuente de OneDrive válida existe aquí; lo demás son copias huérfanas.
  // Un índice guardado por una versión anterior no trae fuentes: en ese caso no se descarta nada.
  const known = new Set((await getSources()).map(s => s.id))
  const merged = mergePhotos(await getPhotos(), idxData?.photos || [])
    .filter(p => !srcData || p.sourceType !== 'onedrive' || known.has(p.sourceId))
  await clearStore('photos')
  await savePhotos(merged)

  for (const p of mergeById(await getProjects(), projData?.projects || [])) await saveProject(p)
  for (const t of mergeById(await getTags(), tagsData?.tags || [])) await saveTag(t)
}

// Unión por id; si una foto está en ambos lados se conserva lo más reciente de cada dato editable
function mergePhotos(local, cloud) {
  const byId = new Map(local.map(p => [p.id, p]))
  for (const c of cloud) {
    const l = byId.get(c.id)
    if (!l) { byId.set(c.id, c); continue }
    const lk = l.kindV || 0, ck = c.kindV || 0
    const kindSrc = lk > ck || (lk === ck && l.kind) ? l : c
    const tagSrc = (l.tagsAt || 0) >= (c.tagsAt || 0) ? l : c
    byId.set(c.id, {
      ...l,
      kind: kindSrc.kind, kindV: kindSrc.kindV,
      tags: tagSrc.tags || [], tagsAt: tagSrc.tagsAt,
    })
  }
  return [...byId.values()]
}

function mergeById(local, cloud) {
  const byId = new Map(local.map(x => [x.id, x]))
  for (const c of cloud) {
    const l = byId.get(c.id)
    if (!l || (c.updatedAt || 0) > (l.updatedAt || 0)) byId.set(c.id, c)
  }
  return [...byId.values()]
}

// Sube el índice completo a OneDrive approot, combinando antes lo que otro dispositivo haya guardado
export function saveToCloud() {
  if (!_saving) _saving = doSave().finally(() => { _saving = null })
  return _saving
}

async function doSave() {
  if (!getAccount()) return
  try {
    if (await syncFromCloud()) await reloadState()

    const [photos, projects, tags, sources] = await Promise.all([getPhotos(), getProjects(), getTags(), getSources()])
    const cleanPhotos = photos.map(p => {
      const { fileHandle, thumbnailUrl, ...rest } = p
      return rest
    })
    // Las carpetas locales solo existen en su dispositivo
    const cloudSources = sources
      .filter(s => s.type === 'onedrive')
      .map(({ id, type, name, driveId, folderId, addedAt }) => ({ id, type, name, driveId, folderId, addedAt }))

    const savedAt = Date.now()
    await Promise.all([
      writeAppFile(APP_PROJECTS_FILE, { projects, savedAt }),
      writeAppFile(APP_TAGS_FILE, { tags, savedAt }),
      writeAppFile(APP_SOURCES_FILE, { sources: cloudSources, savedAt }),
    ])
    // El índice al final: su eTag es la señal de "hay cambios" para los demás dispositivos
    const etag = await writeAppFile(APP_INDEX_FILE, { photos: cleanPhotos, savedAt })
    if (etag) await setConfig(ETAG_KEY, etag)
  } catch (e) {
    console.warn('[sync] saveToCloud error:', e.message)
  }
}

// Programa un guardado en nube con debounce de 5 s
export function scheduleSave() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => saveToCloud(), 5000)
}
