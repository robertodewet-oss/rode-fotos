import { getAccessToken } from './auth.js'

const BASE = 'https://graph.microsoft.com/v1.0'

async function g(path, opts = {}) {
  const token = await getAccessToken()
  const isAbsolute = path.startsWith('http')
  const url = isAbsolute ? path : BASE + path
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': opts.contentType || 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body,
  })
  if (res.status === 204) return null
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Graph ${res.status}: ${txt.slice(0, 200)}`)
  }
  if (opts.raw) return res
  return res.json()
}

export async function getMe() {
  return g('/me?$select=id,displayName,mail,userPrincipalName')
}

// Lista carpetas y archivos en la raíz del OneDrive personal
export async function listRootChildren() {
  return g('/me/drive/root/children?$select=id,name,folder&$top=200&$filter=folder ne null')
}

// Lista carpetas hijas de una carpeta específica
export async function listFolderChildren(driveId, folderId) {
  return g(`/drives/${driveId}/items/${folderId}/children?$select=id,name,folder&$top=200&$filter=folder ne null`)
}

// Delta query para obtener todos los archivos de imagen en una carpeta
// Retorna { items, deltaLink }
export async function getDelta(driveId, folderId, deltaLink = null) {
  const items = []
  let url = deltaLink || `${BASE}/drives/${driveId}/items/${folderId}/delta?$select=id,name,file,photo,video,location,fileSystemInfo,deleted,size&$top=200`

  while (url) {
    const token = await getAccessToken()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Graph delta ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    if (data.value) {
      for (const item of data.value) {
        if (item.deleted) continue
        if (!item.photo && !item.video && !isImageFile(item.name) && !isVideoFile(item.name)) continue
        if (!item.file) continue // es carpeta
        items.push(item)
      }
    }
    if (data['@odata.nextLink']) url = data['@odata.nextLink']
    else if (data['@odata.deltaLink']) return { items, deltaLink: data['@odata.deltaLink'] }
    else break
  }
  return { items, deltaLink: null }
}

function isImageFile(name = '') {
  return /\.(jpe?g|png|heic|heif|webp|tiff?|gif|bmp|raw|cr2|nef|arw)$/i.test(name)
}

export function isVideoFile(name = '') {
  return /\.(mp4|mov|m4v|3gp|webm|avi|mkv)$/i.test(name)
}

// URL temporal pre-autenticada para reproducir un video sin descargarlo completo
export async function getDownloadUrl(driveId, itemId) {
  const data = await g(`/drives/${driveId}/items/${itemId}`)
  return data?.['@microsoft.graph.downloadUrl'] || null
}

// Obtiene la URL de miniatura (medium) de un item de OneDrive
export async function getThumbnailUrl(driveId, itemId, size = 'medium') {
  try {
    const data = await g(`/drives/${driveId}/items/${itemId}/thumbnails/0/${size}`)
    return data?.url || null
  } catch { return null }
}

// Descarga el contenido de un archivo del approot
export async function readAppFile(filename) {
  try {
    const res = await g(`/me/drive/special/approot:/${encodeURIComponent(filename)}:/content`, { raw: true })
    if (!res) return null
    return res.json()
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('itemNotFound')) return null
    throw e
  }
}

// Sube/reemplaza un archivo JSON en el approot
export async function writeAppFile(filename, data) {
  const token = await getAccessToken()
  const res = await fetch(`${BASE}/me/drive/special/approot:/${encodeURIComponent(filename)}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Graph write ${res.status}`)
}

// Obtiene info del drive personal
export async function getMyDrive() {
  return g('/me/drive?$select=id,driveType,quota')
}

// Descarga el contenido real de un item (para exportar)
export async function downloadItem(driveId, itemId) {
  const token = await getAccessToken()
  const res = await fetch(`${BASE}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Download ${res.status}`)
  return res.blob()
}
