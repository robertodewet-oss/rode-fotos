import { readAppFile, writeAppFile } from './graph.js'
import { getAccount } from './auth.js'
import {
  getPhotos, savePhotos, getProjects, saveProject, getTags, saveTag,
  getSources, saveSource, clearStore
} from './db.js'
import { APP_INDEX_FILE, APP_PROJECTS_FILE, APP_TAGS_FILE, APP_SOURCES_FILE } from '../config.js'

let _saveTimer = null

// Descarga el índice completo desde OneDrive approot (al iniciar)
export async function loadFromCloud() {
  if (!getAccount()) return false
  try {
    const [idxData, projData, tagsData] = await Promise.all([
      readAppFile(APP_INDEX_FILE),
      readAppFile(APP_PROJECTS_FILE),
      readAppFile(APP_TAGS_FILE),
    ])

    if (idxData?.photos?.length) {
      await clearStore('photos')
      await savePhotos(idxData.photos)
    }
    if (projData?.projects?.length) {
      await clearStore('projects')
      for (const p of projData.projects) await saveProject(p)
    }
    if (tagsData?.tags?.length) {
      await clearStore('tags')
      for (const t of tagsData.tags) await saveTag(t)
    }
    return true
  } catch (e) {
    console.warn('[sync] loadFromCloud error:', e.message)
    return false
  }
}

// Sube el índice completo a OneDrive approot
export async function saveToCloud() {
  if (!getAccount()) return
  try {
    const [photos, projects, tags] = await Promise.all([
      getPhotos(), getProjects(), getTags()
    ])
    // Guardar sin los fileHandles (no serializables en JSON)
    const cleanPhotos = photos.map(p => {
      const { fileHandle, ...rest } = p
      return rest
    })
    await Promise.all([
      writeAppFile(APP_INDEX_FILE, { photos: cleanPhotos, savedAt: Date.now() }),
      writeAppFile(APP_PROJECTS_FILE, { projects, savedAt: Date.now() }),
      writeAppFile(APP_TAGS_FILE, { tags, savedAt: Date.now() }),
    ])
  } catch (e) {
    console.warn('[sync] saveToCloud error:', e.message)
  }
}

// Programa un guardado en nube con debounce de 5 s
export function scheduleSave() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => saveToCloud(), 5000)
}
