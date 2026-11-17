import { getState } from './store.js'
import { getThumbnail } from './db.js'
import { downloadItem } from './graph.js'
import { getAccount } from './auth.js'

let _photos = []
let _idx = 0

export function openViewer(photos, idx) {
  _photos = photos
  _idx = idx
  const overlay = document.getElementById('viewer-overlay')
  overlay.classList.remove('hidden')
  renderViewer()
}

export function closeViewer() {
  const overlay = document.getElementById('viewer-overlay')
  overlay.classList.add('hidden')
  const img = document.getElementById('viewer-img')
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
  img.src = ''
}

function renderViewer() {
  const photo = _photos[_idx]
  if (!photo) return

  const img = document.getElementById('viewer-img')
  img.src = ''
  img.style.opacity = '0'

  loadFullImage(photo).then(url => {
    if (!url) return
    img.onload = () => { img.style.opacity = '1' }
    img.src = url
  })

  // Info panel
  const { projects, tags } = getState()
  const proj = projects.find(p => p.id === photo.projectId)
  const photoTags = (photo.tags || []).map(tid => tags.find(t => t.id === tid)?.name).filter(Boolean)
  const date = photo.takenAt ? new Date(photo.takenAt).toLocaleString('es-MX') : '—'
  const coords = (photo.lat != null && photo.lng != null) ? `${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}` : '—'
  const device = [photo.cameraMake, photo.cameraModel].filter(Boolean).join(' ') || '—'
  const size = photo.size ? `${(photo.size / 1024 / 1024).toFixed(1)} MB` : '—'

  document.getElementById('viewer-info').innerHTML = `
    <div class="viewer-info-row">
      <div class="viewer-info-label">Archivo</div>
      <div class="viewer-info-val filename">${escHtml(photo.name)}</div>
    </div>
    <div class="viewer-info-row">
      <div class="viewer-info-label">Fecha</div>
      <div class="viewer-info-val">${date}</div>
    </div>
    ${proj ? `<div class="viewer-info-row">
      <div class="viewer-info-label">Proyecto</div>
      <div class="viewer-info-val" style="display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${proj.color}"></span>
        ${escHtml(proj.name)}
      </div>
    </div>` : ''}
    <div class="viewer-info-row">
      <div class="viewer-info-label">GPS</div>
      <div class="viewer-info-val">${coords}</div>
    </div>
    <div class="viewer-info-row">
      <div class="viewer-info-label">Cámara</div>
      <div class="viewer-info-val">${escHtml(device)}</div>
    </div>
    <div class="viewer-info-row">
      <div class="viewer-info-label">Tamaño</div>
      <div class="viewer-info-val">${size}</div>
    </div>
    ${photoTags.length ? `<div class="viewer-info-row">
      <div class="viewer-info-label">Etiquetas</div>
      <div class="viewer-info-val tags-wrap">
        ${photoTags.map(t => `<span class="tag-chip" style="background:#e0e7ff;color:#4338ca">${escHtml(t)}</span>`).join('')}
      </div>
    </div>` : ''}
    <div style="margin-top:auto;padding-top:12px">
      <div style="font-size:11px;color:#475569">${_idx + 1} / ${_photos.length}</div>
    </div>`

  // Flechas
  document.getElementById('viewer-nav-prev').style.display = _idx > 0 ? '' : 'none'
  document.getElementById('viewer-nav-next').style.display = _idx < _photos.length - 1 ? '' : 'none'
}

async function loadFullImage(photo) {
  if (photo.sourceType === 'local') {
    // Para fotos locales intentamos obtener la imagen real
    // La miniatura grande es suficiente para el visor
    const blob = await getThumbnail(photo.id).catch(() => null)
    if (blob) return URL.createObjectURL(blob)
    return null
  }
  if (photo.sourceType === 'onedrive' && getAccount()) {
    try {
      const blob = await downloadItem(photo.driveId, photo.itemId)
      return URL.createObjectURL(blob)
    } catch { return null }
  }
  return null
}

function prev() {
  if (_idx > 0) { _idx--; renderViewer() }
}
function next() {
  if (_idx < _photos.length - 1) { _idx++; renderViewer() }
}

// Inicializar controles del viewer (llamado una vez en app.js)
export function initViewer() {
  document.getElementById('viewer-close').addEventListener('click', closeViewer)
  document.getElementById('viewer-nav-prev').addEventListener('click', prev)
  document.getElementById('viewer-nav-next').addEventListener('click', next)
  document.getElementById('viewer-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('viewer-overlay')) closeViewer()
  })
  document.addEventListener('keydown', e => {
    const overlay = document.getElementById('viewer-overlay')
    if (overlay.classList.contains('hidden')) return
    if (e.key === 'ArrowLeft') prev()
    else if (e.key === 'ArrowRight') next()
    else if (e.key === 'Escape') closeViewer()
  })
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
