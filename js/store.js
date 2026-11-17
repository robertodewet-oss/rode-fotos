// Estado global reactivo de la app
export function emptyFilters() {
  return {
    projectId: null,       // string | null
    dateFrom: null,        // ms timestamp | null
    dateTo: null,
    hiddenDevices: [],     // deviceOf() de los dispositivos desmarcados
    hiddenKinds: [],       // kindOf() de los tipos desmarcados
    tags: [],              // string[]
  }
}

export const SCREENSHOT_NAME = /screenshot|screen shot|captura|scr_|pantallazo/i

// Tipo efectivo: reglas sin IA primero, luego lo que guardó el clasificador
export function kindOf(photo) {
  if (photo.mediaType === 'video') return 'video'
  if (SCREENSHOT_NAME.test(photo.name || '')) return 'captura'
  return photo.kind || null
}

// '' agrupa los archivos sin datos de cámara
export function deviceOf(photo) {
  return photo.cameraModel || photo.cameraMake || ''
}

const _state = {
  user: null,              // { displayName, mail }
  photos: [],              // todos los metadatos indexados
  filtered: [],            // fotos tras aplicar filtros
  projects: [],            // definiciones de proyectos
  tags: [],                // etiquetas
  sources: [],             // fuentes conectadas
  selection: new Set(),    // IDs seleccionados
  lastSelectedId: null,    // para shift+click rango
  view: 'gallery',         // 'gallery' | 'map' | 'projects' | 'sources'
  filters: emptyFilters(),
  classifying: { active: false, done: 0, total: 0, message: '' },
  indexing: {
    active: false,
    sourceId: null,
    current: 0,
    total: 0,
    message: '',
  },
}

const _listeners = new Set()

export function getState() { return _state }

export function setState(update) {
  const patch = typeof update === 'function' ? update(_state) : update
  Object.assign(_state, patch)
  _emit()
}

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn) }

function _emit() { _listeners.forEach(fn => fn(_state)) }

// ── Helpers de filtrado ────────────────────────────────────────────────────

export function applyFilters() {
  const { photos, filters } = _state
  let list = photos

  if (filters.projectId !== null) {
    list = list.filter(p => p.projectId === filters.projectId)
  }
  if (filters.dateFrom !== null) {
    list = list.filter(p => p.takenAt && p.takenAt >= filters.dateFrom)
  }
  if (filters.dateTo !== null) {
    list = list.filter(p => p.takenAt && p.takenAt <= filters.dateTo)
  }
  if (filters.hiddenDevices.length > 0) {
    const hidden = new Set(filters.hiddenDevices)
    list = list.filter(p => !hidden.has(deviceOf(p)))
  }
  if (filters.hiddenKinds.length > 0) {
    const hidden = new Set(filters.hiddenKinds)
    list = list.filter(p => !hidden.has(kindOf(p)))
  }
  if (filters.tags.length > 0) {
    list = list.filter(p => filters.tags.every(t => p.tags?.includes(t)))
  }

  // Ordenar por fecha desc
  list = [...list].sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))

  setState({ filtered: list })
}

// ── Helpers de selección ──────────────────────────────────────────────────

export function toggleSelect(photoId, shiftKey = false) {
  const { selection, lastSelectedId, filtered } = _state
  const newSel = new Set(selection)

  if (shiftKey && lastSelectedId && lastSelectedId !== photoId) {
    const ids = filtered.map(p => p.id)
    const a = ids.indexOf(lastSelectedId)
    const b = ids.indexOf(photoId)
    const [from, to] = a < b ? [a, b] : [b, a]
    for (let i = from; i <= to; i++) newSel.add(ids[i])
  } else {
    if (newSel.has(photoId)) newSel.delete(photoId)
    else newSel.add(photoId)
  }

  setState({ selection: newSel, lastSelectedId: photoId })
}

export function clearSelection() {
  setState({ selection: new Set(), lastSelectedId: null })
}

export function selectAll() {
  const { filtered } = _state
  setState({ selection: new Set(filtered.map(p => p.id)) })
}

// ── Proyectos: GPS auto-assign ────────────────────────────────────────────

export function autoAssignProject(photo, projects) {
  if (photo.lat == null || photo.lng == null) return null
  let best = null, bestDist = Infinity
  for (const proj of projects) {
    const d = haversine(photo.lat, photo.lng, proj.lat, proj.lng)
    if (d <= proj.radius && d < bestDist) { best = proj.id; bestDist = d }
  }
  return best
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
