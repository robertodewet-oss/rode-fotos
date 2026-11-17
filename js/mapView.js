import { getState } from './store.js'
import { openViewer } from './viewer.js'

let _map = null
let _cluster = null
let _projCircles = []
const _icons = {}

export function initMapView(container) {
  container.innerHTML = '<div id="map-container"></div>'
  const L = window.L
  if (!L) { container.innerHTML = '<p style="padding:24px">Leaflet no cargó.</p>'; return }

  // El contenedor se recrea cada vez que se entra al mapa: el mapa anterior ya no está en la página
  _map?.remove()
  _map = L.map('map-container').setView([23.5, -109.9], 10)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(_map)

  // Agrupar puntos: con decenas de miles de fotos, un marcador por foto congela el navegador
  _cluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 50 })
  _cluster.on('click', e => openPopup(e.layer))
  _map.addLayer(_cluster)

  updateMapPhotos()
}

function iconFor(color) {
  if (!_icons[color]) {
    _icons[color] = window.L.divIcon({
      className: '',
      html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};border:1.5px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    })
  }
  return _icons[color]
}

function openPopup(marker) {
  const photo = marker.photo
  const date = photo.takenAt ? new Date(photo.takenAt).toLocaleDateString('es-MX') : ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'cursor:pointer;text-align:center'
  wrap.innerHTML = `<div style="font-weight:600;font-size:13px">${escHtml(photo.name)}</div><div style="font-size:11px;color:#64748b">${date}</div>`
  wrap.addEventListener('click', () => {
    const { filtered } = getState()
    const idx = filtered.findIndex(p => p.id === photo.id)
    if (idx >= 0) openViewer(filtered, idx)
  })
  window.L.popup().setLatLng(marker.getLatLng()).setContent(wrap).openOn(_map)
}

export function updateMapPhotos() {
  const L = window.L
  if (!L || !_map || !_cluster) return
  const { filtered, projects } = getState()

  _projCircles.forEach(c => _map.removeLayer(c))
  _projCircles = []
  for (const p of projects) {
    _projCircles.push(L.circle([p.lat, p.lng], {
      radius: p.radius, color: p.color, fillColor: p.color,
      fillOpacity: 0.08, weight: 2,
    }).bindTooltip(p.name).addTo(_map))
  }

  const proj = {}
  for (const p of projects) proj[p.id] = p
  const markers = []
  for (const photo of filtered) {
    if (photo.lat == null || photo.lng == null) continue
    const m = L.marker([photo.lat, photo.lng], { icon: iconFor(proj[photo.projectId]?.color ?? '#64748b') })
    m.photo = photo
    markers.push(m)
  }
  _cluster.clearLayers()
  _cluster.addLayers(markers)

  if (markers.length) _map.fitBounds(_cluster.getBounds().pad(0.1))
}

export function resizeMap() {
  _map?.invalidateSize()
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
