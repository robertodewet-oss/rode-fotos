import { getAccessToken } from './auth.js'
import { VIDEO_NAME } from './store.js'
import { logError } from './ui.js'

const BASE = 'https://graph.microsoft.com/v1.0'

// ── Límites de Microsoft ──────────────────────────────────────────────────
// Si Graph o el servidor de miniaturas responden 429/503, toda la app espera
// antes de volver a pedir: insistir solo alarga el bloqueo.
let _throttledUntil = 0

export function throttledUntil() { return _throttledUntil }

export function noteThrottle(seconds, where = '') {
  const until = Date.now() + seconds * 1000
  if (until > _throttledUntil) {
    _throttledUntil = until
    logError(`OneDrive pidió esperar ${Math.round(seconds)} s por exceso de peticiones${where ? ` (${where})` : ''}`)
  }
}

export async function waitIfThrottled() {
  const ms = _throttledUntil - Date.now()
  if (ms > 0) await sleep(ms)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// fetch a Graph con espera y reintento ante límites (hasta ~15 min en total)
async function gfetch(url, init = {}, where = '') {
  for (let attempt = 0; ; attempt++) {
    await waitIfThrottled()
    const token = await getAccessToken()
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    if ((res.status === 429 || res.status === 503) && attempt < 6) {
      const retryAfter = Number(res.headers.get('Retry-After')) || Math.min(30 * 2 ** attempt, 300)
      noteThrottle(retryAfter, where)
      continue
    }
    return res
  }
}

async function g(path, opts = {}) {
  const url = path.startsWith('http') ? path : BASE + path
  const res = await gfetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': opts.contentType || 'application/json' } : {},
    body: opts.body,
  }, opts.where)
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
export async function getDelta(driveId, folderId, deltaLink = null, onPage = null) {
  const items = []
  let url = deltaLink || `${BASE}/drives/${driveId}/items/${folderId}/delta?$select=id,name,file,photo,video,location,fileSystemInfo,deleted,size&$top=200`

  while (url) {
    const res = await gfetch(url, {}, 'indexar')
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
    onPage?.(items.length)
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
  return VIDEO_NAME.test(name)
}

// Dirección web del archivo en OneDrive (se abre dentro de su carpeta)
export async function getItemWebUrl(driveId, itemId) {
  const data = await g(`/drives/${driveId}/items/${itemId}?$select=id,webUrl`)
  return data?.webUrl || null
}

// URL temporal pre-autenticada para reproducir un video sin descargarlo completo
export async function getDownloadUrl(driveId, itemId) {
  const data = await g(`/drives/${driveId}/items/${itemId}`)
  return data?.['@microsoft.graph.downloadUrl'] || null
}

// URLs de miniatura de muchos items en peticiones $batch de 20 (el máximo de Graph), en paralelo. Devuelve Map itemId → url
export async function getThumbnailUrls(items, size = 'medium') {
  const urls = new Map()
  const chunks = []
  for (let i = 0; i < items.length; i += 20) chunks.push(items.slice(i, i + 20))
  // Si falla una petición, las demás siguen; solo es error si fallan todas
  let failures = 0, lastError = null
  await Promise.all(chunks.map(first => getThumbChunk(first).catch(e => { failures++; lastError = e })))
  if (failures && failures === chunks.length) throw lastError
  return urls

  async function getThumbChunk(first) {
    let chunk = first
    // Dentro del lote, Graph puede limitar solo algunas: reintentar esas tras la espera
    for (let attempt = 0; attempt < 4 && chunk.length; attempt++) {
      const data = await g('/$batch', {
        method: 'POST',
        where: 'clasificar',
        body: JSON.stringify({
          requests: chunk.map((it, k) => ({ id: String(k), method: 'GET', url: `/drives/${it.driveId}/items/${it.itemId}/thumbnails/0/${size}` })),
        }),
      })
      const retry = []
      let waitSec = 0
      for (const r of data?.responses || []) {
        const it = chunk[Number(r.id)]
        if (r.status === 200 && r.body?.url) urls.set(it.itemId, r.body.url)
        else if (r.status === 429 || r.status === 503) {
          retry.push(it)
          waitSec = Math.max(waitSec, Number(r.headers?.['Retry-After']) || 30)
        }
      }
      chunk = retry
      if (chunk.length) noteThrottle(waitSec, 'clasificar')
    }
  }
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

// eTag del archivo en el approot (cambia cada vez que algún dispositivo lo escribe); null si no existe
export async function getAppFileETag(filename) {
  try {
    const item = await g(`/me/drive/special/approot:/${encodeURIComponent(filename)}?$select=id,eTag`)
    return item?.eTag || null
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('itemNotFound')) return null
    throw e
  }
}

// Sube/reemplaza un archivo JSON en el approot; devuelve el eTag nuevo
export async function writeAppFile(filename, data) {
  const res = await gfetch(`${BASE}/me/drive/special/approot:/${encodeURIComponent(filename)}:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, 'guardar índice')
  if (!res.ok) throw new Error(`Graph write ${res.status}`)
  const item = await res.json().catch(() => null)
  return item?.eTag || null
}

// Obtiene info del drive personal
export async function getMyDrive() {
  return g('/me/drive?$select=id,driveType,quota')
}

// Descarga el contenido real de un item (para exportar)
export async function downloadItem(driveId, itemId) {
  const res = await gfetch(`${BASE}/drives/${driveId}/items/${itemId}/content`, {}, 'exportar')
  if (!res.ok) throw new Error(`Download ${res.status}`)
  return res.blob()
}
