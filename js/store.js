// Estado global reactivo de la app
export function emptyFilters() {
  return {
    projectId: null,       // string | null
    dateFrom: null,        // ms timestamp | null
    dateTo: null,
    hiddenDevices: [],     // deviceOf() de los dispositivos desmarcados
    hiddenKinds: [],       // kindOf() de los tipos desmarcados
    tags: [],              // string[]
    sort: 'taken-desc',    // clave de SORTS
    search: '',            // texto del buscador
  }
}

// Campo y dirección de cada opción de "Ordenar por"
export const SORTS = {
  'taken-desc':   ['takenAt', -1, 'Fecha de captura: más reciente'],
  'taken-asc':    ['takenAt', 1, 'Fecha de captura: más antigua'],
  'created-desc': ['createdAt', -1, 'Fecha de creación: más reciente'],
  'created-asc':  ['createdAt', 1, 'Fecha de creación: más antigua'],
  'size-desc':    ['size', -1, 'Tamaño: más grande'],
  'size-asc':     ['size', 1, 'Tamaño: más pequeño'],
}

export const SCREENSHOT_NAME = /screenshot|screen shot|captura|scr_|pantallazo/i
export const VIDEO_NAME = /\.(mp4|mov|m4v|3gp|webm|avi|mkv)$/i

// Por extensión también: archivos indexados antes de que la app reconociera videos no traen mediaType
export function isVideo(photo) {
  return photo.mediaType === 'video' || VIDEO_NAME.test(photo.name || '')
}

// Tipo efectivo: reglas sin IA primero, luego lo que guardó el clasificador
export function kindOf(photo) {
  if (isVideo(photo)) return 'video'
  if (SCREENSHOT_NAME.test(photo.name || '')) return 'captura'
  return photo.kind || null
}

// Fecha escrita en el nombre por cámaras y apps: IMG_20231105_143022, PXL_20231105_143022123,
// Screenshot_2023-11-05-14-30-22, "WhatsApp Image 2023-11-05 at 14.30.22", IMG-20231105-WA0001…
const NAME_DATE = /(?:^|[^\d])(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _T-]*(?:at )?([01]\d|2[0-3])[.:_-]?([0-5]\d)[.:_-]?([0-5]\d))?/

export function dateFromName(name = '') {
  const m = NAME_DATE.exec(name)
  if (!m) return null
  const [, y, mo, d, h = 12, mi = 0, s = 0] = m
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
  return t <= Date.now() + 86400000 ? t : null
}

// Fecha más confiable de un archivo: captura (EXIF) → nombre → la más antigua entre creación y modificación.
// La "creación" de OneDrive suele ser la fecha en que se subió; la modificación conserva la del teléfono.
export function bestDate(takenAt, name, ...fileDates) {
  if (takenAt) return takenAt
  const fromName = dateFromName(name)
  if (fromName) return fromName
  const valid = fileDates.filter(Boolean)
  return valid.length ? Math.min(...valid) : null
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
  searchScores: null,      // Map photoId → puntaje mientras hay una búsqueda activa
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
  const { photos, filters, sources } = _state
  // Fotos de carpetas locales de otro dispositivo: siguen en el índice pero aquí no se pueden abrir
  const here = new Set(sources.map(s => s.id))
  let list = photos.filter(p => p.sourceType !== 'local' || here.has(p.sourceId))

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
    // Cada foto pertenece a un solo tipo; las normales y las aún sin clasificar cuentan como "foto"
    const hidden = new Set(filters.hiddenKinds)
    list = list.filter(p => !hidden.has(kindOf(p) || 'foto'))
  }
  if (filters.tags.length > 0) {
    list = list.filter(p => filters.tags.every(t => p.tags?.includes(t)))
  }

  // Con búsqueda activa: solo las coincidencias, la más parecida primero
  const scores = _state.searchScores
  if (scores) {
    list = list.filter(p => scores.has(p.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id))
    setState({ filtered: list })
    return
  }

  // Las fotos sin el dato van al final en ambas direcciones
  const [field, dir] = SORTS[filters.sort] || SORTS['taken-desc']
  list = [...list].sort((a, b) => {
    const va = a[field], vb = b[field]
    if (!va && !vb) return 0
    if (!va) return 1
    if (!vb) return -1
    return (va - vb) * dir
  })

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
