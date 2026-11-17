import { getState, setState, autoAssignProject, applyFilters } from './store.js'
import { saveProject as dbSaveProject, deleteProject as dbDeleteProject, getProjects, savePhotos, getPhotos } from './db.js'
import { scheduleSave } from './sync.js'

const PROJECT_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4']

let _map = null
let _markers = {}     // projectId → Leaflet layer group
let _circles = {}     // projectId → Leaflet circle
let _newMarker = null

export function renderProjectsView(container) {
  container.innerHTML = `
    <div id="projects-view">
      <div id="projects-list">
        <button class="btn btn--primary" id="btn-new-project" style="width:100%;margin-bottom:12px">
          + Nuevo proyecto
        </button>
        <div id="project-cards"></div>
      </div>
      <div id="projects-map"></div>
    </div>`

  renderProjectCards()
  initProjectsMap()

  container.querySelector('#btn-new-project').addEventListener('click', () => showProjectForm(null))
}

function renderProjectCards() {
  const { projects } = getState()
  const wrap = document.querySelector('#project-cards')
  if (!wrap) return
  wrap.innerHTML = ''
  for (const p of projects) {
    const card = document.createElement('div')
    card.className = 'project-card'
    card.innerHTML = `
      <div class="project-dot" style="background:${p.color}"></div>
      <div class="project-info">
        <div class="project-name">${escHtml(p.name)}</div>
        <div class="project-meta">Radio: ${p.radius}m · ${countPhotos(p.id)} fotos</div>
      </div>
      <div class="project-actions">
        <button class="btn btn--icon btn--sm" data-action="edit" data-id="${p.id}" title="Editar">✏️</button>
        <button class="btn btn--icon btn--sm" data-action="del" data-id="${p.id}" title="Eliminar">🗑️</button>
      </div>`
    wrap.appendChild(card)
  }
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'edit') showProjectForm(btn.dataset.id)
    if (btn.dataset.action === 'del') confirmDeleteProject(btn.dataset.id)
  })
}

function countPhotos(projectId) {
  return getState().photos.filter(p => p.projectId === projectId).length
}

// ── Mapa Leaflet ──────────────────────────────────────────────────────────

function initProjectsMap() {
  const L = window.L
  if (!L) return

  _map = L.map('projects-map').setView([23.5, -109.9], 10)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(_map)

  renderProjectsOnMap()

  // Click en mapa → nuevo proyecto
  _map.on('click', e => {
    if (_newMarker) _map.removeLayer(_newMarker)
    _newMarker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(_map)
    showProjectForm(null, e.latlng.lat, e.latlng.lng)
  })
}

function renderProjectsOnMap() {
  const L = window.L
  if (!L || !_map) return
  const { projects } = getState()

  // Limpiar anteriores
  Object.values(_markers).forEach(m => _map.removeLayer(m))
  Object.values(_circles).forEach(c => _map.removeLayer(c))
  _markers = {}; _circles = {}

  for (const p of projects) {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${p.color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    })
    const marker = L.marker([p.lat, p.lng], { icon })
      .bindTooltip(p.name, { permanent: false, direction: 'top' })
      .addTo(_map)
    marker.on('click', () => showProjectForm(p.id))
    _markers[p.id] = marker

    _circles[p.id] = L.circle([p.lat, p.lng], {
      radius: p.radius,
      color: p.color,
      fillColor: p.color,
      fillOpacity: 0.1,
      weight: 2,
    }).addTo(_map)
  }
}

// ── Formulario de proyecto ────────────────────────────────────────────────

function showProjectForm(projectId, defaultLat = null, defaultLng = null) {
  const existing = projectId ? getState().projects.find(p => p.id === projectId) : null
  const lat = existing?.lat ?? defaultLat ?? 23.5
  const lng = existing?.lng ?? defaultLng ?? -109.9
  const selectedColor = existing?.color ?? PROJECT_COLORS[getState().projects.length % PROJECT_COLORS.length]

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>${existing ? 'Editar' : 'Nuevo'} proyecto</h2>
        <button class="btn btn--icon" id="pf-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Nombre</label>
          <input id="pf-name" type="text" placeholder="Ej: ALH, La Ventana House" value="${escHtml(existing?.name || '')}">
        </div>
        <div class="field">
          <label>Coordenadas (lat, lng)</label>
          <div style="display:flex;gap:8px">
            <input id="pf-lat" type="number" step="0.000001" value="${lat}" style="flex:1">
            <input id="pf-lng" type="number" step="0.000001" value="${lng}" style="flex:1">
          </div>
        </div>
        <div class="field">
          <label>Radio de asignación automática (metros)</label>
          <input id="pf-radius" type="number" min="50" max="50000" value="${existing?.radius ?? 500}">
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-row" id="pf-colors">
            ${PROJECT_COLORS.map(c => `<div class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}"></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        ${existing ? `<button class="btn btn--danger" id="pf-del">Eliminar</button>` : ''}
        <button class="btn btn--secondary" id="pf-cancel">Cancelar</button>
        <button class="btn btn--primary" id="pf-save">Guardar</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  let currentColor = selectedColor
  overlay.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'))
      sw.classList.add('selected')
      currentColor = sw.dataset.color
    })
  })

  const close = () => { overlay.remove(); if (_newMarker) { _map?.removeLayer(_newMarker); _newMarker = null } }

  overlay.querySelector('#pf-close').addEventListener('click', close)
  overlay.querySelector('#pf-cancel').addEventListener('click', close)
  overlay.querySelector('#pf-del')?.addEventListener('click', () => { close(); confirmDeleteProject(projectId) })
  overlay.querySelector('#pf-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#pf-name').value.trim()
    const latVal = parseFloat(overlay.querySelector('#pf-lat').value)
    const lngVal = parseFloat(overlay.querySelector('#pf-lng').value)
    const radius = parseInt(overlay.querySelector('#pf-radius').value)
    if (!name) { overlay.querySelector('#pf-name').focus(); return }

    const project = {
      id: existing?.id ?? crypto.randomUUID(),
      name, lat: latVal, lng: lngVal, radius, color: currentColor,
      createdAt: existing?.createdAt ?? Date.now(),
    }
    await saveProject(project)
    close()
  })
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function saveProject(project) {
  await dbSaveProject(project)
  const projects = await getProjects()
  // Re-asignar fotos a este proyecto
  const photos = getState().photos
  const updated = photos.map(p => {
    if (autoAssignProject(p, [project]) === project.id) return { ...p, projectId: project.id }
    if (p.projectId === project.id) return { ...p, projectId: autoAssignProject(p, projects) }
    return p
  })
  await savePhotos(updated)
  setState({ projects, photos: updated })
  applyFilters()
  renderProjectCards()
  renderProjectsOnMap()
  scheduleSave()
}

export async function confirmDeleteProject(projectId) {
  const p = getState().projects.find(pr => pr.id === projectId)
  if (!p) return
  if (!confirm(`¿Eliminar el proyecto "${p.name}"? Las fotos no se borran, solo pierden la asignación.`)) return
  await dbDeleteProject(projectId)
  const photos = getState().photos.map(ph => ph.projectId === projectId ? { ...ph, projectId: null } : ph)
  await savePhotos(photos)
  const projects = await getProjects()
  setState({ projects, photos })
  applyFilters()
  renderProjectCards()
  renderProjectsOnMap()
  scheduleSave()
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
