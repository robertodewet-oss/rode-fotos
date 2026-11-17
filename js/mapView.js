import { getState } from './store.js'
import { openViewer } from './viewer.js'

let _map = null
let _markers = []
let _projCircles = []

export function initMapView(container) {
  container.innerHTML = '<div id="map-container"></div>'
  const L = window.L
  if (!L) { container.innerHTML = '<p style="padding:24px">Leaflet no cargó.</p>'; return }

  _map = L.map('map-container').setView([23.5, -109.9], 10)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(_map)

  updateMapPhotos()
}

export function updateMapPhotos() {
  const L = window.L
  if (!L || !_map) return
  const { filtered, projects } = getState()

  // Limpiar
  _markers.forEach(m => _map.removeLayer(m))
  _projCircles.forEach(c => _map.removeLayer(c))
  _markers = []; _projCircles = []

  // Círculos de proyectos
  for (const p of projects) {
    const c = L.circle([p.lat, p.lng], {
      radius: p.radius, color: p.color, fillColor: p.color,
      fillOpacity: 0.08, weight: 2,
    }).bindTooltip(p.name).addTo(_map)
    _projCircles.push(c)
  }

  // Fotos con GPS
  const withGps = filtered.filter(p => p.lat != null && p.lng != null)
  const proj = {}
  for (const p of projects) proj[p.id] = p

  for (let i = 0; i < withGps.length; i++) {
    const photo = withGps[i]
    const color = proj[photo.projectId]?.color ?? '#64748b'
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};border:1.5px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    })
    const marker = L.marker([photo.lat, photo.lng], { icon })
    marker.bindPopup(() => {
      const date = photo.takenAt ? new Date(photo.takenAt).toLocaleDateString('es-MX') : ''
      const wrap = document.createElement('div')
      wrap.style.cssText = 'cursor:pointer;text-align:center'
      wrap.innerHTML = `<div style="font-weight:600;font-size:13px">${escHtml(photo.name)}</div><div style="font-size:11px;color:#64748b">${date}</div>`
      wrap.addEventListener('click', () => {
        const idx = filtered.indexOf(photo)
        if (idx >= 0) openViewer(filtered, idx)
      })
      return wrap
    })
    marker.addTo(_map)
    _markers.push(marker)
  }

  // Ajustar bounds si hay fotos
  if (_markers.length) {
    const group = L.featureGroup(_markers)
    _map.fitBounds(group.getBounds().pad(0.1))
  }
}

export function resizeMap() {
  _map?.invalidateSize()
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
