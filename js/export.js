import { getState } from './store.js'
import { getThumbnail } from './db.js'
import { downloadItem } from './graph.js'
import { getAccount } from './auth.js'
import { notify } from './ui.js'
import { getLocalFile } from './sources.js'

export function showExportDialog() {
  const { selection, filtered, projects } = getState()
  const selectedPhotos = filtered.filter(p => selection.has(p.id))
  if (!selectedPhotos.length) return

  const overlay = document.createElement('div')
  overlay.id = 'export-modal'
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Exportar ${selectedPhotos.length} fotos</h2>
        <button class="btn btn--icon" id="exp-close">✕</button>
      </div>
      <div class="modal-body">
        <label class="export-opt">
          <input type="checkbox" id="exp-rename" checked>
          <label for="exp-rename">Renombrar: <code>PROYECTO_AAAA-MM-DD_###</code></label>
        </label>
        <label class="export-opt">
          <input type="checkbox" id="exp-resize">
          <label for="exp-resize">Reducir a 2000 px (lado mayor)</label>
        </label>
        <div id="exp-dest-info" style="font-size:12px;color:var(--text-sm);margin-top:4px"></div>
        <div id="exp-progress" style="display:none">
          <div class="progress-bar-wrap" style="height:6px;margin-top:8px">
            <div class="progress-bar" id="exp-pbar" style="width:0%"></div>
          </div>
          <div id="exp-msg" style="font-size:12px;color:var(--text-sm);margin-top:4px"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--secondary" id="exp-cancel">Cancelar</button>
        ${canPickDir() ? `<button class="btn btn--primary" id="exp-to-folder">📁 Exportar a carpeta</button>` : ''}
        <button class="btn btn--primary" id="exp-download">⬇️ Descargar</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  overlay.querySelector('#exp-close').addEventListener('click', () => overlay.remove())
  overlay.querySelector('#exp-cancel').addEventListener('click', () => overlay.remove())

  overlay.querySelector('#exp-to-folder')?.addEventListener('click', async () => {
    const opts = getOpts(overlay)
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await runExport(selectedPhotos, opts, async (blob, filename, i, total) => {
        updateProgress(overlay, i, total, filename)
        const fh = await dirHandle.getFileHandle(filename, { create: true })
        const w = await fh.createWritable()
        await w.write(blob); await w.close()
      })
      overlay.remove()
      notify(`${selectedPhotos.length} fotos exportadas`, 'success')
    } catch (e) {
      if (e.name !== 'AbortError') notify('Error al exportar: ' + e.message, 'error')
    }
  })

  overlay.querySelector('#exp-download').addEventListener('click', async () => {
    const opts = getOpts(overlay)
    for (let i = 0; i < selectedPhotos.length; i++) {
      const photo = selectedPhotos[i]
      updateProgress(overlay, i + 1, selectedPhotos.length, photo.name)
      try {
        const blob = await fetchPhotoBlob(photo)
        if (!blob) continue
        const processed = opts.resize && photo.mediaType !== 'video' ? await resizeBlob(blob) : blob
        const filename = opts.rename ? buildName(photo, getState().projects, i) : photo.name
        triggerDownload(processed, filename)
        await new Promise(r => setTimeout(r, 200)) // pequeña pausa entre descargas
      } catch {}
    }
    overlay.remove()
    notify(`${selectedPhotos.length} fotos descargadas`, 'success')
  })
}

function getOpts(overlay) {
  return {
    rename: overlay.querySelector('#exp-rename').checked,
    resize: overlay.querySelector('#exp-resize').checked,
  }
}

async function runExport(photos, opts, writeFn) {
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]
    let blob = await fetchPhotoBlob(photo)
    if (!blob) continue
    if (opts.resize && photo.mediaType !== 'video') blob = await resizeBlob(blob)
    const filename = opts.rename ? buildName(photo, getState().projects, i) : photo.name
    await writeFn(blob, filename, i + 1, photos.length)
  }
}

async function fetchPhotoBlob(photo) {
  if (photo.sourceType === 'local') {
    const file = await getLocalFile(photo).catch(() => null)
    if (file) return file
    return photo.mediaType === 'video' ? null : getThumbnail(photo.id).catch(() => null)
  }
  if (photo.sourceType === 'onedrive' && getAccount()) {
    return downloadItem(photo.driveId, photo.itemId).catch(() => null)
  }
  return null
}

function buildName(photo, projects, idx) {
  const proj = projects.find(p => p.id === photo.projectId)
  const prefix = proj ? proj.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() : 'FOTOS'
  const date = photo.takenAt ? new Date(photo.takenAt).toISOString().slice(0, 10) : 'sin-fecha'
  const num = String(idx + 1).padStart(3, '0')
  const ext = photo.name.split('.').pop()?.toLowerCase() || 'jpg'
  return `${prefix}_${date}_${num}.${ext}`
}

async function resizeBlob(blob, maxPx = 2000) {
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  const scale = Math.min(maxPx / width, maxPx / height, 1)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function updateProgress(overlay, current, total, name) {
  const prog = overlay.querySelector('#exp-progress')
  prog.style.display = ''
  overlay.querySelector('#exp-pbar').style.width = `${(current / total) * 100}%`
  overlay.querySelector('#exp-msg').textContent = `${current}/${total} — ${name}`
}

function canPickDir() { return 'showDirectoryPicker' in window }
