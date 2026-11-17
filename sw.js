const CACHE = 'rode-fotos-v18'
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './config.js',
  './css/app.css',
  './js/auth.js',
  './js/graph.js',
  './js/db.js',
  './js/store.js',
  './js/ui.js',
  './js/sync.js',
  './js/sources.js',
  './js/projects.js',
  './js/gallery.js',
  './js/mapView.js',
  './js/viewer.js',
  './js/export.js',
  './js/classify.js',
  './js/clipWorker.js',
  './js/app.js',
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('rode-fotos-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Solo archivos de la app (mismo origen) y librerías de jsDelivr; red primero, caché sin conexión
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin && url.hostname !== 'cdn.jsdelivr.net') return

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
        }
        return res
      })
      .catch(() => caches.match(e.request))
  )
})
