import { initAuth, signIn, signOut, getAccount } from './auth.js'
import { openDB, getPhotos, getProjects, getTags, getSources } from './db.js'
import { getState, setState, applyFilters, clearSelection, subscribe, emptyFilters, kindOf, deviceOf } from './store.js'
import { startClassification } from './classify.js'
import { syncFromCloud, reloadState } from './sync.js'
import { initGallery, updateGallery } from './gallery.js'
import { initViewer } from './viewer.js'
import { initMapView, updateMapPhotos, resizeMap } from './mapView.js'
import { renderSourcesView, connectOneDrive, addLocalFolder, syncAllSources } from './sources.js'
import { renderProjectsView } from './projects.js'
import { showExportDialog } from './export.js'
import { notify, escHtml, logError } from './ui.js'
import { throttledUntil } from './graph.js'

export { notify }

// ── Init ──────────────────────────────────────────────────────────────────

export async function init() {
  window.addEventListener('error', e => logError('Error inesperado', `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`))
  window.addEventListener('unhandledrejection', e => logError('Error inesperado', e.reason?.message || String(e.reason)))
  await openDB()
  await initAuth()
  initViewer()

  // Si hay sesión activa, cargar datos y mostrar app
  if (getAccount()) {
    await loadAppData()
    renderApp()
  } else {
    renderWelcome()
  }

  // Routing por hash
  window.addEventListener('hashchange', () => navigate())

  // Evento interno de refresh
  document.addEventListener('rode:refreshview', e => {
    renderActiveView(e.detail.view)
  })
}

async function loadAppData() {
  // 1. Cargar desde IndexedDB
  const [photos, projects, tags, sources] = await Promise.all([
    getPhotos(), getProjects(), getTags(), getSources()
  ])
  setState({ photos, projects, tags, sources })
  applyFilters()

  // 2. Traer lo que otros dispositivos guardaron en OneDrive (clasificación, etiquetas, proyectos).
  //    Sin datos locales se espera; si ya hay, se hace en segundo plano para no retrasar la galería.
  if (!photos.length) {
    if (await syncFromCloud()) await reloadState()
  } else {
    syncFromCloud().then(async changed => {
      if (!changed) return
      await reloadState()
      updateActiveView()
      notify('Índice actualizado desde OneDrive')
    })
  }
}

// ── Welcome (no autenticado) ──────────────────────────────────────────────

function renderWelcome() {
  document.getElementById('app-shell').innerHTML = `
    <div id="welcome">
      <div style="font-size:64px">📷</div>
      <h1>RODE Fotos</h1>
      <p>Explorador de fotos de obra para RODE HAUS.<br>Conecta tu OneDrive o carpetas locales para empezar.</p>
      <button id="btn-signin" onclick="document.getElementById('btn-signin').disabled=true;document.getElementById('btn-signin').textContent='Iniciando...'">
        <svg class="ms-logo" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
          <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
        </svg>
        Iniciar sesión con Microsoft
      </button>
    </div>`
  document.getElementById('btn-signin').addEventListener('click', async () => {
    try {
      await signIn()
      await loadAppData()
      renderApp()
    } catch (e) {
      if (!e.message.includes('user_cancelled') && !e.message.includes('popup')) {
        notify('Error al iniciar sesión: ' + e.message, 'error')
      }
      document.getElementById('btn-signin').disabled = false
      document.getElementById('btn-signin').innerHTML = `
        <svg class="ms-logo" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
          <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
        </svg>
        Iniciar sesión con Microsoft`
    }
  })
}

// ── App shell (autenticado) ───────────────────────────────────────────────

function renderApp() {
  const account = getAccount()
  const initials = account?.name?.split(' ').map(w => w[0]).slice(0, 2).join('') || '?'

  document.getElementById('app-shell').innerHTML = `
    <div id="topbar">
      <div id="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        RODE Fotos
      </div>
      <div id="filter-bar">
        <select id="f-project" class="filter-select">
          <option value="">Todos los proyectos</option>
        </select>
        <input type="date" id="f-date-from" class="filter-date" title="Desde">
        <input type="date" id="f-date-to" class="filter-date" title="Hasta">
        <details class="filter-dd" id="f-devices">
          <summary class="filter-select">Dispositivos</summary>
          <div class="dd-panel">
            <div class="dd-actions">
              <button type="button" data-dev-all="1">Todos</button>
              <button type="button" data-dev-all="0">Ninguno</button>
            </div>
            <div id="f-devices-list"></div>
          </div>
        </details>
        <details class="filter-dd only-mobile">
          <summary class="filter-select">Tipos</summary>
          <div class="dd-panel" data-kind-list></div>
        </details>
        <span id="filter-count"></span>
        <button id="btn-clear-filters">✕ Limpiar</button>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
        <button class="btn btn--secondary btn--sm" id="btn-refresh" title="Buscar fotos y videos nuevos en todas las fuentes">🔄<span class="hide-mobile"> Actualizar</span></button>
        <div class="user-chip" id="user-menu-btn" style="color:var(--text);padding:4px 8px;border-radius:6px;cursor:pointer">
          <div class="user-avatar">${initials}</div>
          <span class="user-name" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${account?.name || 'Usuario'}</span>
        </div>
      </div>
    </div>
    <div id="main">
      <nav id="sidebar">
        <div class="sidebar-section">Fotos</div>
        <div class="nav-item active" data-view="gallery">
          <span class="icon">🖼️</span> Galería
        </div>
        <div class="nav-item" data-view="map">
          <span class="icon">🗺️</span> Mapa
        </div>
        <div class="sidebar-filters">
          <div class="sidebar-section">Tipos</div>
          <div class="sidebar-kinds" data-kind-list></div>
          <div id="classify-status"></div>
        </div>
        <div class="sidebar-divider"></div>
        <div class="sidebar-section">Gestión</div>
        <div class="nav-item" data-view="projects">
          <span class="icon">📍</span> Proyectos
        </div>
        <div class="nav-item" data-view="sources">
          <span class="icon">🔗</span> Fuentes
        </div>
        <div id="sidebar-bottom">
          <div class="sidebar-divider"></div>
          <div class="nav-item" id="nav-signout">
            <span class="icon">↩️</span> Cerrar sesión
          </div>
        </div>
      </nav>
      <div id="content">
        <div id="view-container"></div>
      </div>
    </div>
    <div id="selection-bar" class="hidden">
      <span id="sel-count">0 seleccionadas</span>
      <div class="divider"></div>
      <button class="btn btn--sm" id="btn-sel-all" style="color:#94a3b8">Todas</button>
      <button class="btn btn--sm" id="btn-sel-tag" style="color:#a5b4fc">🏷️ Etiquetar</button>
      <button class="btn btn--primary btn--sm" id="btn-sel-export">⬇️ Exportar</button>
      <button class="btn btn--sm" id="btn-sel-cancel" style="color:#94a3b8">✕</button>
    </div>
    <div id="indexing-progress" class="hidden">
      <div class="spinner" style="flex-shrink:0"></div>
      <span id="idx-msg">Indexando...</span>
      <div class="progress-bar-wrap">
        <div class="progress-bar" id="idx-pbar" style="width:0%"></div>
      </div>
      <span id="idx-num" style="font-size:11px;color:var(--text-sm)"></span>
    </div>`

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view))
  })
  document.getElementById('nav-signout').addEventListener('click', async () => {
    await signOut()
    setState({ user: null, photos: [], filtered: [], projects: [], tags: [], sources: [] })
    renderWelcome()
  })

  document.getElementById('btn-refresh').addEventListener('click', async e => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      if (await syncFromCloud()) { await reloadState(); updateActiveView() }
      if (!getState().sources.length) { notify('Primero agrega una fuente en Fuentes'); return }
      await syncAllSources()
    } finally { btn.disabled = false }
  })

  // User menu
  document.getElementById('user-menu-btn').addEventListener('click', () => {
    notify(`Sesión de ${account?.name}`)
  })

  // Filter bar
  document.getElementById('f-project').addEventListener('change', e => {
    setState({ filters: { ...getState().filters, projectId: e.target.value || null } })
    applyFilters(); updateActiveView()
  })
  document.getElementById('f-date-from').addEventListener('change', e => {
    const val = e.target.value ? new Date(e.target.value).getTime() : null
    setState({ filters: { ...getState().filters, dateFrom: val } })
    applyFilters(); updateActiveView()
  })
  document.getElementById('f-date-to').addEventListener('change', e => {
    const val = e.target.value ? new Date(e.target.value + 'T23:59:59').getTime() : null
    setState({ filters: { ...getState().filters, dateTo: val } })
    applyFilters(); updateActiveView()
  })
  const devList = document.getElementById('f-devices-list')
  devList.addEventListener('change', e => {
    const dev = e.target.dataset.device
    if (dev === undefined) return
    toggleHidden('hiddenDevices', dev, !e.target.checked)
  })
  document.querySelectorAll('[data-dev-all]').forEach(btn => btn.addEventListener('click', () => {
    const all = btn.dataset.devAll === '1'
    const hiddenDevices = all ? [] : [...devList.querySelectorAll('input[data-device]')].map(i => i.dataset.device)
    setState({ filters: { ...getState().filters, hiddenDevices } })
    syncCheckboxes(); applyFilters(); updateActiveView()
  }))

  document.querySelectorAll('[data-kind-list]').forEach(list => {
    list.innerHTML = KIND_FILTERS.map(([kind, label]) => `
      <label class="check-row">
        <input type="checkbox" data-kind="${kind}" checked>
        <span>${label}</span>
        <span class="check-count" data-kind-count="${kind}"></span>
      </label>`).join('')
    list.addEventListener('change', e => {
      const kind = e.target.dataset.kind
      if (kind) toggleHidden('hiddenKinds', kind, !e.target.checked)
    })
  })

  // Cerrar desplegables al hacer clic fuera
  document.addEventListener('click', e => {
    document.querySelectorAll('details.filter-dd[open]').forEach(d => { if (!d.contains(e.target)) d.open = false })
  })

  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    setState({ filters: emptyFilters() })
    document.getElementById('f-project').value = ''
    document.getElementById('f-date-from').value = ''
    document.getElementById('f-date-to').value = ''
    syncCheckboxes(); applyFilters(); updateActiveView()
  })

  // Selection bar
  document.getElementById('btn-sel-all').addEventListener('click', () => {
    const { filtered } = getState()
    setState({ selection: new Set(filtered.map(p => p.id)) })
    updateSelectionBar(); updateGallery()
  })
  document.getElementById('btn-sel-cancel').addEventListener('click', () => {
    clearSelection(); updateSelectionBar(); updateGallery()
  })
  document.getElementById('btn-sel-export').addEventListener('click', showExportDialog)
  document.getElementById('btn-sel-tag').addEventListener('click', showTagDialog)

  // Suscribirse a cambios de estado
  let wasIndexing = getState().indexing.active
  subscribe(state => {
    updateSelectionBar()
    updateFilterCount()
    updateIndexingProgress()
    updateFilterDropdowns()
    updateClassifyStatus()
    if (wasIndexing && !state.indexing.active) startClassification()
    wasIndexing = state.indexing.active
  })

  // Poblar filtros con datos actuales
  updateFilterDropdowns()
  updateClassifyStatus()
  // Durante una pausa por límites de OneDrive no hay cambios de estado: refrescar la cuenta regresiva
  setInterval(() => { if (getState().classifying.active) updateClassifyStatus() }, 2000)

  navigate(location.hash.slice(1) || 'gallery')

  // Dar tiempo a que cargue la galería antes de empezar a descargar el modelo
  setTimeout(startClassification, 3000)
}

const KIND_FILTERS = [
  ['personas', '👥 Personas'],
  ['selfie', '🤳 Selfies'],
  ['captura', '📱 Capturas de pantalla'],
  ['grafico', '🎨 Gráficos'],
  ['documento', '🧾 Documentos'],
  ['video', '🎬 Videos'],
]

function toggleHidden(key, value, hide) {
  const filters = getState().filters
  const set = new Set(filters[key])
  if (hide) set.add(value); else set.delete(value)
  setState({ filters: { ...filters, [key]: [...set] } })
  syncCheckboxes(); applyFilters(); updateActiveView()
}

// Mantiene iguales las casillas del menú lateral y del desplegable móvil
function syncCheckboxes() {
  const { hiddenKinds, hiddenDevices } = getState().filters
  document.querySelectorAll('input[data-kind]').forEach(i => { i.checked = !hiddenKinds.includes(i.dataset.kind) })
  document.querySelectorAll('input[data-device]').forEach(i => { i.checked = !hiddenDevices.includes(i.dataset.device) })
  const summary = document.querySelector('#f-devices summary')
  const n = hiddenDevices.length
  if (summary) summary.textContent = n ? `Dispositivos (${n} oculto${n === 1 ? '' : 's'})` : 'Dispositivos'
}

function updateClassifyStatus() {
  const { photos, classifying } = getState()
  const counts = {}
  for (const p of photos) { const k = kindOf(p); if (k) counts[k] = (counts[k] || 0) + 1 }
  document.querySelectorAll('[data-kind-count]').forEach(el => {
    el.textContent = counts[el.dataset.kindCount] || ''
  })

  const el = document.getElementById('classify-status')
  if (!el) return
  if (classifying.active) {
    if (classifying.message) { el.textContent = classifying.message; return }
    const fmt = n => n.toLocaleString('es-MX')
    let text = `Clasificando con IA: ${fmt(classifying.done)} de ${fmt(classifying.total)}`
    const waitSec = Math.ceil((throttledUntil() - Date.now()) / 1000)
    if (waitSec > 0) {
      el.textContent = `${text} · en pausa: OneDrive pidió esperar (~${waitSec} s)`
      return
    }
    if (classifying.perSec) {
      const mins = Math.ceil((classifying.total - classifying.done) / classifying.perSec / 60)
      const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
      text += ` · ${classifying.perSec.toFixed(1)} fotos/s · faltan ~${left}`
      text += classifying.device === 'webgpu' ? ' · tarjeta gráfica' : ' · procesador'
    }
    el.textContent = text
  } else {
    el.textContent = ''
  }
}

// ── Routing ───────────────────────────────────────────────────────────────

let _currentView = null
let _galleryInstance = null
let _mapInitialized = false

function navigate(view = null) {
  if (!view) view = location.hash.slice(1) || 'gallery'
  if (!['gallery', 'map', 'projects', 'sources'].includes(view)) view = 'gallery'
  if (view !== _currentView) {
    _currentView = view
    setState({ view })
    renderActiveView(view)
  }
}

function renderActiveView(view) {
  if (!view) view = _currentView
  const container = document.getElementById('view-container')
  if (!container) return
  const filterBar = document.getElementById('filter-bar')

  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view)
  })

  const showFilters = view === 'gallery' || view === 'map'
  if (filterBar) filterBar.style.display = showFilters ? '' : 'none'

  if (view === 'gallery') {
    if (!_galleryInstance) {
      _galleryInstance = initGallery(container)
    } else {
      container.innerHTML = '<div id="gallery-wrap"></div>'
      _galleryInstance = initGallery(container)
    }
    updateGallery()
    checkEmpty()
  } else if (view === 'map') {
    if (!_mapInitialized) {
      initMapView(container)
      _mapInitialized = true
    }
    setTimeout(() => resizeMap(), 100)
    updateMapPhotos()
  } else if (view === 'projects') {
    renderProjectsView(container)
  } else if (view === 'sources') {
    renderSourcesView(container)
  }
  location.hash = view
}

function updateActiveView() {
  if (_currentView === 'gallery') updateGallery()
  else if (_currentView === 'map') updateMapPhotos()
}

function checkEmpty() {
  const { filtered, sources } = getState()
  const wrap = document.getElementById('gallery-wrap')
  if (!wrap) return
  if (!filtered.length) {
    wrap.classList.add('empty-state')
    if (!sources.length) {
      wrap.innerHTML = `<div class="empty-box">
        <div class="empty-icon">📸</div>
        <h2>Sin fotos todavía</h2>
        <p>Conecta tu OneDrive o agrega una carpeta local para ver tus fotos de obra.</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn--primary" id="btn-add-od">☁️ Conectar OneDrive</button>
          ${canPickDir() ? `<button class="btn btn--secondary" id="btn-add-local">💾 Carpeta local</button>` : ''}
        </div>
      </div>`
      wrap.querySelector('#btn-add-od')?.addEventListener('click', connectOneDrive)
      wrap.querySelector('#btn-add-local')?.addEventListener('click', addLocalFolder)
    } else {
      wrap.innerHTML = `<div class="empty-box">
        <div class="empty-icon">🔍</div>
        <h2>Sin resultados</h2>
        <p>Ninguna foto coincide con los filtros actuales.</p>
      </div>`
    }
  } else {
    wrap.classList.remove('empty-state')
  }
}

function canPickDir() { return 'showDirectoryPicker' in window }

// ── Selection bar ─────────────────────────────────────────────────────────

function updateSelectionBar() {
  const { selection } = getState()
  const bar = document.getElementById('selection-bar')
  if (!bar) return
  if (selection.size > 0) {
    bar.classList.remove('hidden')
    document.getElementById('sel-count').textContent = `${selection.size} seleccionada${selection.size !== 1 ? 's' : ''}`
  } else {
    bar.classList.add('hidden')
  }
}

// ── Conteo de filtros ─────────────────────────────────────────────────────

function updateFilterCount() {
  const { filtered, photos } = getState()
  const el = document.getElementById('filter-count')
  if (el) el.textContent = `${filtered.length} de ${photos.length}`
}

// ── Progress de indexación ────────────────────────────────────────────────

function updateIndexingProgress() {
  const { indexing } = getState()
  const bar = document.getElementById('indexing-progress')
  if (!bar) return
  if (indexing.active) {
    bar.classList.remove('hidden')
    document.getElementById('idx-msg').textContent = indexing.message || 'Indexando...'
    document.getElementById('idx-pbar').style.width = indexing.total
      ? `${(indexing.current / indexing.total) * 100}%` : '0%'
    document.getElementById('idx-num').textContent = indexing.total
      ? `${indexing.current}/${indexing.total}` : ''
  } else {
    bar.classList.add('hidden')
    // Refrescar galería después de indexar
    if (_currentView === 'gallery') updateGallery()
    updateFilterDropdowns()
    updateFilterCount()
    checkEmpty()
  }
}

// ── Dropdowns de filtros ──────────────────────────────────────────────────

function updateFilterDropdowns() {
  const { projects, photos } = getState()
  const fpSel = document.getElementById('f-project')
  const devList = document.getElementById('f-devices-list')
  if (!fpSel || !devList) return

  const curProj = fpSel.value
  fpSel.innerHTML = '<option value="">Todos los proyectos</option>'
  for (const p of projects) {
    const opt = document.createElement('option')
    opt.value = p.id; opt.textContent = p.name
    if (opt.value === curProj) opt.selected = true
    fpSel.appendChild(opt)
  }

  const counts = new Map()
  for (const p of photos) { const d = deviceOf(p); counts.set(d, (counts.get(d) || 0) + 1) }
  const devices = [...counts.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))
  const signature = devices.map(d => `${d}:${counts.get(d)}`).join('|')
  // Reconstruir solo si cambió la lista, para no interrumpir clics en el desplegable
  if (devList.dataset.signature === signature) return
  devList.dataset.signature = signature
  const { hiddenDevices } = getState().filters
  devList.innerHTML = devices.map(d => `
    <label class="check-row">
      <input type="checkbox" data-device="${escHtml(d)}" ${hiddenDevices.includes(d) ? '' : 'checked'}>
      <span>${d ? escHtml(d) : '<em>Sin datos de cámara</em>'}</span>
      <span class="check-count">${counts.get(d)}</span>
    </label>`).join('') || '<div class="check-empty">Sin fotos</div>'
}

// ── Diálogo de etiquetas ──────────────────────────────────────────────────

async function showTagDialog() {
  const { tags, selection, filtered } = getState()
  const selectedPhotos = filtered.filter(p => selection.has(p.id))

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Etiquetar ${selectedPhotos.length} fotos</h2>
        <button class="btn btn--icon" id="tag-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="tags-wrap" id="tags-list">
          ${tags.map(t => `
            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 0">
              <input type="checkbox" value="${t.id}" style="width:16px;height:16px">
              <span class="tag-pill" style="background:${t.color}22;color:${t.color}">${escHtml(t.name)}</span>
            </label>`).join('')}
        </div>
        ${!tags.length ? '<p style="color:var(--text-sm);font-size:13px">Aún no hay etiquetas. Crea una nueva:</p>' : ''}
        <div style="display:flex;gap:8px;margin-top:8px">
          <input id="new-tag-name" class="filter-select" type="text" placeholder="Nueva etiqueta..." style="flex:1">
          <input id="new-tag-color" type="color" value="#4f46e5" style="width:36px;height:34px;padding:2px;border:1px solid var(--border);border-radius:6px">
          <button class="btn btn--secondary btn--sm" id="btn-add-tag">Crear</button>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--secondary" id="tag-cancel">Cancelar</button>
        <button class="btn btn--primary" id="tag-apply">Aplicar</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  overlay.querySelector('#tag-close').addEventListener('click', () => overlay.remove())
  overlay.querySelector('#tag-cancel').addEventListener('click', () => overlay.remove())

  overlay.querySelector('#btn-add-tag').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-tag-name').value.trim()
    const color = overlay.querySelector('#new-tag-color').value
    if (!name) return
    const { saveTag: dbSaveTag, getTags: dbGetTags } = await import('./db.js')
    const newTag = { id: crypto.randomUUID(), name, color }
    await dbSaveTag(newTag)
    const updatedTags = await dbGetTags()
    setState({ tags: updatedTags })
    // Agregar al DOM
    const list = overlay.querySelector('#tags-list')
    const lbl = document.createElement('label')
    lbl.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 0'
    lbl.innerHTML = `<input type="checkbox" value="${newTag.id}" checked style="width:16px;height:16px">
      <span class="tag-pill" style="background:${color}22;color:${color}">${escHtml(name)}</span>`
    list.appendChild(lbl)
    overlay.querySelector('#new-tag-name').value = ''
  })

  overlay.querySelector('#tag-apply').addEventListener('click', async () => {
    const checked = [...overlay.querySelectorAll('#tags-list input:checked')].map(i => i.value)
    const { savePhotos: dbSavePhotos } = await import('./db.js')  // importación diferida OK aquí
    const updatedPhotos = getState().photos.map(p => {
      if (!selection.has(p.id)) return p
      const newTags = [...new Set([...(p.tags || []), ...checked])]
      return { ...p, tags: newTags, tagsAt: Date.now() }
    })
    await dbSavePhotos(updatedPhotos)
    setState({ photos: updatedPhotos })
    applyFilters()
    const { scheduleSave: sched } = await import('./sync.js')
    sched()
    overlay.remove()
    notify(`Etiquetas aplicadas a ${selectedPhotos.length} fotos`, 'success')
  })
}

// ── Iniciar ───────────────────────────────────────────────────────────────
init().catch(e => {
  document.getElementById('app-shell').innerHTML = `
    <div style="padding:24px;color:red">Error al iniciar: ${e.message}</div>`
  console.error(e)
})
