import { getState, toggleSelect } from './store.js'
import { getThumbnail } from './db.js'
import { getThumbnailUrl } from './graph.js'
import { openViewer } from './viewer.js'
import { getAccount } from './auth.js'

const THUMB_W = 196
const THUMB_H = 147
const THUMB_GAP = 8
const INFO_H = 36

const _thumbUrls = new Map()

window.RODE_GALLERY_VERSION = 7

function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

class VirtualGallery {
  constructor(wrap) {
    this.wrap = wrap
    this.inner = document.createElement('div')
    this.inner.id = 'gallery-inner'
    this.wrap.appendChild(this.inner)
    this.photos = []
    this._cols = 1

    this.wrap.addEventListener('scroll', () => this.render(), { passive: true })
    this._ro = new ResizeObserver(() => { this._cols = this._calcCols(); this.reflow() })
    this._ro.observe(this.wrap)

    // Click handler (delegar en inner)
    this.inner.addEventListener('click', e => this._onClick(e))
    this.inner.addEventListener('contextmenu', e => { e.preventDefault(); this._onCtxMenu(e) })
  }

  _calcCols() {
    const w = this.wrap.clientWidth
    return Math.max(1, Math.floor((w + THUMB_GAP) / (THUMB_W + THUMB_GAP)))
  }

  get _rowH() { return THUMB_H + INFO_H + THUMB_GAP }
  get _rows() { return Math.ceil(this.photos.length / this._cols) }

  setPhotos(photos) {
    this.photos = photos
    this._cols = this._calcCols()
    this.reflow()
  }

  reflow() {
    const totalH = this._rows * this._rowH + THUMB_GAP
    this.inner.style.height = totalH + 'px'
    this.render()
  }

  render() {
    const { selection } = getState()
    const scrollTop = this.wrap.scrollTop
    const viewH = this.wrap.clientHeight
    const cols = this._cols
    const rowH = this._rowH

    const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - 2)
    const lastRow = Math.min(this._rows - 1, Math.ceil((scrollTop + viewH) / rowH) + 2)

    // Preservar cards que siguen visibles (evitar parpadeo)
    const existing = {}
    this.inner.querySelectorAll('.thumb-card[data-id]').forEach(el => {
      existing[el.dataset.id] = el
    })

    const toKeep = new Set()
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col
        if (idx >= this.photos.length) break
        const photo = this.photos[idx]
        toKeep.add(photo.id)

        let el = existing[photo.id]
        if (!el) {
          el = this._buildCard(photo)
          this.inner.appendChild(el)
          this._loadThumb(photo, el)
        }
        // Posición
        el.style.left = (col * (THUMB_W + THUMB_GAP) + THUMB_GAP) + 'px'
        el.style.top = (row * rowH + THUMB_GAP) + 'px'
        el.classList.toggle('selected', selection.has(photo.id))
      }
    }

    // Eliminar cards fuera de la vista
    for (const [id, el] of Object.entries(existing)) {
      if (!toKeep.has(id)) el.remove()
    }
  }

  _buildCard(photo) {
    const { projects } = getState()
    const proj = projects.find(p => p.id === photo.projectId)
    const date = photo.takenAt ? new Date(photo.takenAt).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

    const el = document.createElement('div')
    el.className = 'thumb-card'
    el.dataset.id = photo.id
    el.style.width = THUMB_W + 'px'
    el.style.height = (THUMB_H + INFO_H) + 'px'
    el.innerHTML = `
      <div class="thumb-img-wrap">
        <span class="thumb-img-placeholder">🖼️</span>
      </div>
      <div class="thumb-info">
        <div class="thumb-project-dot" style="background:${proj?.color ?? '#94a3b8'}"></div>
        <div class="thumb-date">${date}</div>
      </div>
      <div class="thumb-check">✓</div>
      ${photo.mediaType === 'video' ? `<div class="thumb-video">▶${photo.duration ? ' ' + formatDuration(photo.duration) : ''}</div>` : ''}`
    return el
  }

  async _loadThumb(photo, el) {
    const imgWrap = el.querySelector('.thumb-img-wrap')
    let url = null

    if (photo.sourceType === 'local') {
      try {
        const blob = await getThumbnail(photo.id)
        if (blob) url = URL.createObjectURL(blob)
      } catch {}
    } else if (photo.sourceType === 'onedrive') {
      // Solo en memoria: las URLs de Graph caducan y no deben guardarse con la foto
      url = _thumbUrls.get(photo.id) || null
      if (!url && getAccount()) {
        try {
          url = await getThumbnailUrl(photo.driveId, photo.itemId, 'large')
          if (url) _thumbUrls.set(photo.id, url)
        } catch {}
      }
    }

    if (!url) return
    const img = document.createElement('img')
    img.onload = () => { img.classList.add('loaded'); imgWrap.querySelector('.thumb-img-placeholder')?.remove() }
    img.onerror = () => { if (url.startsWith('blob:')) URL.revokeObjectURL(url) }
    img.src = url
    imgWrap.appendChild(img)
  }

  _onClick(e) {
    const card = e.target.closest('.thumb-card[data-id]')
    if (!card) return
    const { selection } = getState()
    // Si hay selección activa o se hace clic en el check → toggle select
    if (selection.size > 0 || e.target.closest('.thumb-check')) {
      toggleSelect(card.dataset.id, e.shiftKey)
      this.render()
      return
    }
    // Si no hay selección → abrir visor
    const idx = this.photos.findIndex(p => p.id === card.dataset.id)
    if (idx >= 0) openViewer(this.photos, idx)
  }

  _onCtxMenu(e) {
    const card = e.target.closest('.thumb-card[data-id]')
    if (!card) return
    toggleSelect(card.dataset.id, false)
    this.render()
  }

  scrollToTop() { this.wrap.scrollTop = 0 }

  destroy() { this._ro.disconnect() }
}

let _gallery = null

export function initGallery(container) {
  container.innerHTML = `<div id="gallery-wrap"></div>`
  const wrap = container.querySelector('#gallery-wrap')
  _gallery = new VirtualGallery(wrap)
  return _gallery
}

export function updateGallery() {
  if (!_gallery) return
  const { filtered } = getState()
  _gallery.setPhotos(filtered)
}
