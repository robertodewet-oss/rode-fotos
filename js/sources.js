import { getAccount, signIn } from './auth.js'
import { getMyDrive, listRootChildren, listFolderChildren, getDelta, isVideoFile, getItemWebUrl } from './graph.js'
import { getSources, saveSource, deleteSource, savePhotos, deletePhotosBySource, savePhoto, saveThumbnail, getConfig, setConfig, getPhotos, getProjects, getTags } from './db.js'
import { getState, setState, autoAssignProject, applyFilters, bestDate, uploadSafeTaken } from './store.js'
import { scheduleSave } from './sync.js'
import { notify, escHtml, getErrorLog, clearErrorLog } from './ui.js'
import { getDiagnostics, clearDiagnostics } from './classify.js'

// ── Colores disponibles para proyectos/fuentes ─────────────────────────────
export const SOURCE_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

// ── Renderizar vista de fuentes ────────────────────────────────────────────

export function renderSourcesView(container) {
  const { sources } = getState()
  container.innerHTML = `
    <div id="sources-view">
      <h1>Fuentes de fotos</h1>
      <div class="source-grid" id="sources-grid"></div>
      <div class="error-log">
        <div class="error-log-header">
          <h2>Registro de errores <small>(este dispositivo)</small></h2>
          <button class="btn btn--secondary btn--sm" id="log-copy">📋 Copiar</button>
          <button class="btn btn--sm" id="log-clear" style="color:var(--text-sm)">Borrar</button>
        </div>
        <div id="error-log-list"></div>
      </div>
      <div class="error-log">
        <div class="error-log-header">
          <h2>Diagnóstico de la IA <small>(por minuto, este dispositivo)</small></h2>
          <button class="btn btn--secondary btn--sm" id="diag-copy">📋 Copiar</button>
          <button class="btn btn--sm" id="diag-clear" style="color:var(--text-sm)">Borrar</button>
        </div>
        <div id="diag-list"></div>
      </div>
    </div>`
  renderSourceCards(container.querySelector('#sources-grid'))
  renderErrorLog()
  renderDiagnostics()
  container.querySelector('#diag-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(diagText() || 'Sin datos'); notify('Diagnóstico copiado', 'success') }
    catch { notify('No se pudo copiar', 'error') }
  })
  container.querySelector('#diag-clear').addEventListener('click', clearDiagnostics)

  container.querySelector('#log-copy').addEventListener('click', async () => {
    const text = getErrorLog().map(e => `${new Date(e.at).toLocaleString('es-MX')}  ${e.message}${e.detail ? ' — ' + e.detail : ''}`).join('\n')
    try { await navigator.clipboard.writeText(text || 'Sin errores'); notify('Registro copiado', 'success') }
    catch { notify('No se pudo copiar; selecciona el texto manualmente', 'error') }
  })
  container.querySelector('#log-clear').addEventListener('click', () => {
    if (confirm('¿Borrar el registro de errores de este dispositivo?')) clearErrorLog()
  })
}

function renderErrorLog() {
  const list = document.getElementById('error-log-list')
  if (!list) return
  const log = getErrorLog().slice().reverse()
  list.innerHTML = log.length
    ? log.map(e => `
      <div class="error-log-row">
        <span class="error-log-time">${new Date(e.at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' })}</span>
        <span class="error-log-msg">${escHtml(e.message)}${e.detail ? `<br><small>${escHtml(e.detail)}</small>` : ''}</span>
      </div>`).join('')
    : '<div class="error-log-empty">Sin errores registrados</div>'
}

document.addEventListener('rode:errorlog', renderErrorLog)
document.addEventListener('rode:diag', renderDiagnostics)

// Una fila por minuto: cuántas fotos salieron y en qué se fue el tiempo
const DIAG_COLS = [
  ['Hora', d => new Date(d.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })],
  ['Fotos', d => d.fotos, 'Fotos clasificadas en ese minuto'],
  ['Fotos/s', d => (d.fotos / ((d.duracionMs || 60000) / 1000)).toFixed(1), 'Velocidad real en ese minuto'],
  ['Ritmo / techo', d => `${d.ritmo} / ${d.techo}`, 'Fotos/s que la app se permite pedir / máximo aprendido'],
  ['Espera bloqueo', d => secs(d.esperaBloqueoMs / Math.max(1, d.lotes)), 'Promedio por lote esperando a que OneDrive levante un bloqueo'],
  ['Espera ritmo', d => secs(d.esperaRitmoMs / Math.max(1, d.lotes)), 'Promedio por lote esperando para no pasar del ritmo'],
  ['Graph', d => d.graphLlamadas ? `${d.graphLlamadas} · ${secs(d.graphMs / d.graphLlamadas)}` : '—', 'Peticiones de direcciones de miniaturas · tiempo promedio'],
  ['Sin dirección', d => d.sinUrl, 'Fotos a las que OneDrive no les dio dirección de miniatura'],
  ['Bloq. Graph', d => d.bloqueosGraph, 'Lotes en que Graph pidió esperar'],
  ['Descargas', d => d.descOk ? `${d.descOk} · ${secs(d.descMs / d.descOk)}` : '0', 'Miniaturas descargadas · tiempo promedio'],
  ['429', d => d.desc429, 'Miniaturas rechazadas por exceso de peticiones'],
  ['Error red', d => d.descRed, 'Miniaturas que fallaron sin respuesta (a veces es un bloqueo)'],
  ['No disp.', d => d.descNoDisp, 'Miniaturas que OneDrive no pudo generar'],
  ['IA', d => secs(d.iaMs), 'Tiempo total de la IA en ese minuto'],
  ['Oculta', d => d.ocultaMs == null ? '—' : secs(d.ocultaMs), 'Tiempo con la pestaña oculta o minimizada'],
]
function secs(ms) { return (ms / 1000).toFixed(1) + ' s' }

function diagText() {
  const rows = getDiagnostics()
  return [DIAG_COLS.map(c => c[0]).join('\t'), ...rows.map(d => DIAG_COLS.map(c => c[1](d)).join('\t'))].join('\n')
}

function renderDiagnostics() {
  const el = document.getElementById('diag-list')
  if (!el) return
  const rows = getDiagnostics().slice().reverse()
  el.innerHTML = rows.length
    ? `<table class="diag-table"><thead><tr>${DIAG_COLS.map(c => `<th title="${c[2] || ''}">${c[0]}</th>`).join('')}</tr></thead>
       <tbody>${rows.map(d => `<tr>${DIAG_COLS.map(c => `<td>${escHtml(String(c[1](d)))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<div class="error-log-empty">Aún sin datos: aparecen mientras la IA clasifica</div>'
}

function renderSourceCards(grid) {
  const { sources } = getState()
  grid.innerHTML = ''

  for (const src of sources) {
    const card = document.createElement('div')
    card.className = 'source-card'
    card.innerHTML = `
      <div class="source-card-header">
        <div class="source-icon">${src.type === 'onedrive' ? '☁️' : '💾'}</div>
        <div class="source-info">
          <div class="source-name">${escHtml(src.name)}</div>
          <div class="source-meta">${src.photoCount || 0} fotos · ${src.type === 'onedrive' ? 'OneDrive' : 'Carpeta local'}</div>
        </div>
      </div>
      <div class="source-status">
        <div class="status-dot ${src.status || 'ok'}"></div>
        <span>${statusLabel(src.status)}</span>
      </div>
      <div class="source-actions">
        <button class="btn btn--secondary btn--sm" data-action="sync" data-id="${src.id}">🔄 Sincronizar</button>
        <button class="btn btn--sm" style="color:var(--danger)" data-action="remove" data-id="${src.id}">Eliminar</button>
      </div>`
    grid.appendChild(card)
  }

  // Botones para agregar
  const addOD = document.createElement('div')
  addOD.className = 'source-add-card'
  addOD.innerHTML = `<div class="add-icon">☁️</div><span>Conectar OneDrive</span><small>Fotos del celular y PC</small>`
  addOD.addEventListener('click', connectOneDrive)
  grid.appendChild(addOD)

  if ('showDirectoryPicker' in window) {
    const addLocal = document.createElement('div')
    addLocal.className = 'source-add-card'
    addLocal.innerHTML = `<div class="add-icon">💾</div><span>Agregar carpeta local</span><small>Solo en esta PC</small>`
    addLocal.addEventListener('click', addLocalFolder)
    grid.appendChild(addLocal)
  }

  grid.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = btn.dataset.id
    if (btn.dataset.action === 'sync') syncSource(id)
    if (btn.dataset.action === 'remove') confirmRemoveSource(id)
  })
}

function statusLabel(status) {
  return {
    ok: 'Sincronizada',
    indexing: 'Indexando…',
    pending: 'Pendiente',
    error: 'Error al sincronizar (ver registro abajo)',
  }[status] || 'Sincronizada'
}

// ── Conectar OneDrive ──────────────────────────────────────────────────────

export async function connectOneDrive() {
  try {
    if (!getAccount()) await signIn()
    const drive = await getMyDrive()
    const folder = await showFolderPicker(drive.id)
    if (!folder) return

    // Id derivado de la carpeta: así es la misma fuente en todos tus dispositivos
    const id = `od-${drive.id}-${folder.id}`
    if (getState().sources.some(s => s.id === id)) {
      notify(`"${folder.name}" ya está conectada; buscando fotos nuevas…`)
      await syncSource(id)
      return
    }
    const source = {
      id,
      type: 'onedrive',
      name: folder.name,
      driveId: drive.id,
      folderId: folder.id,
      status: 'pending',
      photoCount: 0,
      addedAt: Date.now(),
      lastSync: null,
      deltaLink: null,
    }
    await saveSource(source)
    setState({ sources: await getSources() })
    renderActiveView()
    await indexOneDriveSource(source)
  } catch (e) {
    if (e.message.includes('user_cancelled') || e.message.includes('popup')) return
    notify('Error al conectar OneDrive: ' + e.message, 'error')
  }
}

// ── Selector de carpeta de OneDrive ───────────────────────────────────────

function showFolderPicker(driveId) {
  return new Promise((resolve) => {
    let currentId = 'root'
    let breadcrumb = [{ id: 'root', name: 'Mi OneDrive' }]

    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Elegir carpeta de OneDrive</h2>
          <button class="btn btn--icon" id="fp-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="folder-breadcrumb" id="fp-bread"></div>
          <div class="folder-picker" id="fp-list"><div style="padding:16px;text-align:center"><div class="spinner"></div></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn--secondary" id="fp-cancel">Cancelar</button>
          <button class="btn btn--primary" id="fp-select">Elegir esta carpeta</button>
        </div>
      </div>`
    document.body.appendChild(overlay)

    const fpList = overlay.querySelector('#fp-list')
    const fpBread = overlay.querySelector('#fp-bread')

    function renderBread() {
      fpBread.innerHTML = breadcrumb.map((b, i) =>
        `<span data-idx="${i}">${escHtml(b.name)}</span>${i < breadcrumb.length - 1 ? ' / ' : ''}`
      ).join('')
      fpBread.querySelectorAll('span').forEach(s => {
        s.addEventListener('click', () => {
          const idx = +s.dataset.idx
          breadcrumb = breadcrumb.slice(0, idx + 1)
          currentId = breadcrumb[breadcrumb.length - 1].id
          loadFolder(currentId)
        })
      })
    }

    async function loadFolder(folderId) {
      fpList.innerHTML = '<div style="padding:16px;text-align:center"><div class="spinner" style="margin:0 auto"></div></div>'
      try {
        let data
        if (folderId === 'root') {
          data = await listRootChildren()
        } else {
          data = await listFolderChildren(driveId, folderId)
        }
        const folders = (data.value || []).filter(i => i.folder)
        fpList.innerHTML = ''
        if (!folders.length) {
          fpList.innerHTML = '<div style="padding:12px 16px;color:var(--text-sm);font-size:13px">Sin subcarpetas</div>'
          return
        }
        for (const f of folders) {
          const item = document.createElement('div')
          item.className = 'folder-item'
          item.innerHTML = `<span>📁</span><span>${escHtml(f.name)}</span>`
          item.addEventListener('click', () => {
            breadcrumb.push({ id: f.id, name: f.name })
            currentId = f.id
            renderBread()
            loadFolder(f.id)
          })
          fpList.appendChild(item)
        }
      } catch (e) {
        fpList.innerHTML = `<div style="padding:12px;color:var(--danger)">${e.message}</div>`
      }
      renderBread()
    }

    overlay.querySelector('#fp-close').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#fp-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#fp-select').addEventListener('click', () => {
      const cur = breadcrumb[breadcrumb.length - 1]
      overlay.remove()
      resolve({ id: cur.id === 'root' ? 'root' : cur.id, name: cur.name })
    })

    loadFolder(currentId)
  })
}

// ── Indexar fuente OneDrive ───────────────────────────────────────────────

export async function indexOneDriveSource(source, incremental = false) {
  const { projects } = getState()
  updateSourceStatus(source.id, 'indexing')
  setIndexingState(true, source.id, 0, 0, 'Iniciando...')

  try {
    // Cambiar el prefijo fuerza un escaneo completo (p. ej. "delta5_": guardar la fecha de modificación)
    const deltaLink = incremental ? (await getConfig(`delta5_${source.id}`)) : null
    const { items, deltaLink: newDelta } = await getDelta(source.driveId, source.folderId, deltaLink,
      n => setIndexingState(true, source.id, 0, 0, `Revisando OneDrive… ${n.toLocaleString('es-MX')} archivos`))

    setIndexingState(true, source.id, 0, items.length, `Indexando ${items.length} archivos...`)

    const existing = new Map(getState().photos.map(p => [p.id, p]))
    const photos = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      setIndexingState(true, source.id, i + 1, items.length, `${item.name}`)

      const photo = keepUserData(buildOneDrivePhoto(item, source.id, source.driveId, projects), existing)
      photos.push(photo)

      // Guardar en lotes de 50
      if (photos.length >= 50 || i === items.length - 1) {
        await savePhotos([...photos])
        photos.length = 0
      }
    }

    if (newDelta) await setConfig(`delta5_${source.id}`, newDelta)

    // Actualizar fuente
    const updSource = { ...source, status: 'ok', photoCount: items.length, lastSync: Date.now() }
    await saveSource(updSource)
    await refreshState()
    scheduleSave()
    notify(`${items.length} fotos indexadas de "${source.name}"`, 'success')
  } catch (e) {
    updateSourceStatus(source.id, 'error')
    notify('Error al indexar: ' + e.message, 'error')
  } finally {
    setIndexingState(false)
  }
}

function keepUserData(photo, existing) {
  const old = existing.get(photo.id)
  if (!old) return photo
  return { ...photo, tags: old.tags || [], kind: old.kind, kindV: old.kindV, projectId: photo.projectId ?? old.projectId ?? null }
}

function buildOneDrivePhoto(item, sourceId, driveId, projects) {
  const photo = item.photo || {}
  const loc = item.location || {}
  const fsi = item.fileSystemInfo || {}
  const lat = loc.latitude || null
  const lng = loc.longitude || null
  const ms = s => (s ? new Date(s).getTime() : null)
  const noCamera = !photo.cameraMake && !photo.cameraModel
  const takenAt = bestDate(uploadSafeTaken(ms(photo.takenDateTime), ms(fsi.lastModifiedDateTime), noCamera),
    item.name, ms(fsi.createdDateTime), ms(fsi.lastModifiedDateTime))
  const isVideo = !!item.video || item.file?.mimeType?.startsWith('video/') || isVideoFile(item.name)

  const p = {
    id: `od_${sourceId}_${item.id}`,
    sourceType: 'onedrive',
    sourceId,
    driveId,
    itemId: item.id,
    name: item.name,
    mediaType: isVideo ? 'video' : 'image',
    duration: item.video?.duration || null,
    takenAt,
    lat,
    lng,
    cameraMake: photo.cameraMake || null,
    cameraModel: photo.cameraModel || null,
    projectId: null,
    tags: [],
    size: item.size || 0,
    createdAt: ms(fsi.createdDateTime),
    modifiedAt: ms(fsi.lastModifiedDateTime),
    indexedAt: Date.now(),
  }
  p.projectId = autoAssignProject(p, projects)
  return p
}

// ── Agregar carpeta local ─────────────────────────────────────────────────

export async function addLocalFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' })
    const id = crypto.randomUUID()
    const source = {
      id,
      type: 'local',
      name: dirHandle.name,
      dirHandle,          // FileSystemDirectoryHandle, almacenable en IndexedDB
      status: 'pending',
      photoCount: 0,
      addedAt: Date.now(),
      lastSync: null,
    }
    await saveSource(source)
    setState({ sources: await getSources() })
    renderActiveView()
    await indexLocalSource(source)
  } catch (e) {
    if (e.name === 'AbortError') return
    notify('Error al agregar carpeta: ' + e.message, 'error')
  }
}

// ── Indexar fuente local ──────────────────────────────────────────────────

export async function indexLocalSource(source) {
  const { projects } = getState()
  updateSourceStatus(source.id, 'indexing')
  setIndexingState(true, source.id, 0, 0, 'Escaneando archivos...')

  try {
    // Importar exifr de forma diferida
    const exifrMod = await import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.js')
    const exifr = exifrMod.default || exifrMod

    const dirHandle = source.dirHandle
    const perm = await dirHandle.requestPermission({ mode: 'read' })
    if (perm !== 'granted') throw new Error('Permiso denegado para leer la carpeta')

    // Recopilar todos los archivos imagen recursivamente
    const files = await collectImageFiles(dirHandle)
    setIndexingState(true, source.id, 0, files.length, `${files.length} imágenes encontradas`)

    const existing = new Map(getState().photos.map(p => [p.id, p]))
    const photos = []
    for (let i = 0; i < files.length; i++) {
      const { file, path } = files[i]
      setIndexingState(true, source.id, i + 1, files.length, path)
      const isVideo = isVideoFile(file.name)

      let exif = {}
      if (!isVideo) {
        try {
          exif = await exifr.parse(file, {
            pick: ['DateTimeOriginal', 'latitude', 'longitude', 'Make', 'Model'],
          }) || {}
        } catch {}
      }

      const lat = exif.latitude ?? null
      const lng = exif.longitude ?? null
      const takenAt = bestDate(exif.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : null, file.name, file.lastModified)

      const photoId = `loc_${source.id}_${btoa(unescape(encodeURIComponent(path))).replace(/=/g, '')}`
      let photo = {
        id: photoId,
        sourceType: 'local',
        sourceId: source.id,
        localPath: path,
        name: file.name,
        mediaType: isVideo ? 'video' : 'image',
        takenAt,
        lat,
        lng,
        cameraMake: exif.Make || null,
        cameraModel: exif.Model || null,
        projectId: null,
        tags: [],
        size: file.size,
        // El navegador no da la fecha de creación de archivos locales; la de modificación es lo más cercano
        createdAt: file.lastModified || null,
        indexedAt: Date.now(),
      }
      photo.projectId = autoAssignProject(photo, projects)
      photo = keepUserData(photo, existing)

      // Generar miniatura y guardarla en IndexedDB
      try {
        const thumbBlob = isVideo ? await generateVideoThumbnail(file) : await generateThumbnail(file)
        await saveThumbnail(photoId, thumbBlob)
      } catch {}

      photos.push(photo)
      if (photos.length >= 20 || i === files.length - 1) {
        await savePhotos([...photos])
        photos.length = 0
      }
    }

    const updSource = { ...source, status: 'ok', photoCount: files.length, lastSync: Date.now() }
    await saveSource(updSource)
    await refreshState()
    scheduleSave()
    notify(`${files.length} fotos indexadas de "${source.name}"`, 'success')
  } catch (e) {
    updateSourceStatus(source.id, 'error')
    notify('Error al indexar carpeta: ' + e.message, 'error')
  } finally {
    setIndexingState(false)
  }
}

async function collectImageFiles(dirHandle, basePath = '') {
  const files = []
  for await (const entry of dirHandle.values()) {
    const path = basePath ? `${basePath}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      const sub = await collectImageFiles(entry, path)
      files.push(...sub)
    } else if (isImageFile(entry.name) || isVideoFile(entry.name)) {
      const file = await entry.getFile()
      files.push({ file, path })
    }
  }
  return files
}

function isImageFile(name = '') {
  return /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(name)
}

async function generateThumbnail(file, maxSize = 640) {
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  const scale = Math.min(maxSize / width, maxSize / height, 1)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
}

async function generateVideoThumbnail(file, maxSize = 640) {
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.src = url
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej })
    video.currentTime = Math.min(1, (video.duration || 0) / 2)
    await new Promise((res, rej) => { video.onseeked = res; video.onerror = rej })
    const scale = Math.min(maxSize / video.videoWidth, maxSize / video.videoHeight, 1)
    const canvas = new OffscreenCanvas(Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale))
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function openFileLocation(photo) {
  if (photo.sourceType === 'onedrive') {
    // Abrir la pestaña ya, dentro del clic: si se abre después de esperar a OneDrive, el navegador la bloquea
    const win = window.open('about:blank', '_blank')
    try {
      const url = await getItemWebUrl(photo.driveId, photo.itemId)
      if (!url) throw new Error('OneDrive no devolvió la dirección del archivo')
      if (win) { win.opener = null; win.location.href = url }
      else window.location.assign(url)
    } catch (e) {
      win?.close()
      notify('No se pudo abrir la ubicación en OneDrive: ' + e.message, 'error')
    }
    return
  }

  // Un sitio web no puede abrir el Explorador de Windows: copiar la ruta para pegarla ahí
  const source = getState().sources.find(s => s.id === photo.sourceId)
  const parts = (photo.localPath || photo.name).split('/')
  const folder = [source?.name || 'Carpeta local', ...parts.slice(0, -1)].join('\\')
  try {
    await navigator.clipboard.writeText(folder)
    notify(`Ruta copiada: ${folder} — pégala en el Explorador de archivos (archivo: ${parts[parts.length - 1]})`, 'success')
  } catch {
    notify(`Carpeta: ${folder} — archivo: ${parts[parts.length - 1]}`)
  }
}

export async function getLocalFile(photo) {
  const source = getState().sources.find(s => s.id === photo.sourceId)
  if (!source?.dirHandle || !photo.localPath) return null
  if (await source.dirHandle.queryPermission({ mode: 'read' }) !== 'granted') {
    if (await source.dirHandle.requestPermission({ mode: 'read' }) !== 'granted') return null
  }
  const parts = photo.localPath.split('/')
  let dir = source.dirHandle
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
  const fh = await dir.getFileHandle(parts[parts.length - 1])
  return fh.getFile()
}

// ── Sincronizar (incremental) ─────────────────────────────────────────────

export async function syncSource(sourceId) {
  const src = getState().sources.find(s => s.id === sourceId)
  if (!src) return
  if (src.type === 'onedrive') {
    await indexOneDriveSource(src, true)
  } else {
    await indexLocalSource(src)
  }
}

export async function syncAllSources() {
  if (getState().indexing.active) return
  for (const src of getState().sources) await syncSource(src.id)
}

// ── Eliminar fuente ───────────────────────────────────────────────────────

function confirmRemoveSource(sourceId) {
  const src = getState().sources.find(s => s.id === sourceId)
  if (!src) return
  if (!confirm(`¿Eliminar la fuente "${src.name}" y sus ${src.photoCount || 0} fotos del índice?`)) return
  deleteSource(sourceId).then(async () => {
    setState({ sources: await getSources() })
    await refreshState()
    renderActiveView()
    scheduleSave()
    notify(`Fuente "${src.name}" eliminada`)
  })
}

// ── Helpers internos ─────────────────────────────────────────────────────

function updateSourceStatus(sourceId, status) {
  const sources = getState().sources.map(s => s.id === sourceId ? { ...s, status } : s)
  setState({ sources })
}

function setIndexingState(active, sourceId = null, current = 0, total = 0, message = '') {
  setState({ indexing: { active, sourceId, current, total, message } })
}

async function refreshState() {
  const [sources, photos, projects, tags] = await Promise.all([getSources(), getPhotos(), getProjects(), getTags()])
  setState({ sources, photos, projects, tags })
  applyFilters()
}

function renderActiveView() {
  const { view } = getState()
  const event = new CustomEvent('rode:refreshview', { detail: { view } })
  document.dispatchEvent(event)
}

