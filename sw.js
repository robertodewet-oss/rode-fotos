const CACHE = 'rode-fotos-v1'
const PRECACHE = [
  './',
  './index.html',
  './config.js',
  './css/app.css',
  './js/auth.js',
  './js/graph.js',
  './js/db.js',
  './js/store.js',
  './js/sync.js',
  './js/sources.js',
  './js/projects.js',
  './js/gallery.js',
  './js/mapView.js',
  './js/viewer.js',
  './js/selection.js',
  './js/export.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const url = e.request.url
  // No interceptar auth ni Graph
  if (url.includes('microsoftonline.com') || url.includes('graph.microsoft.com') || url.includes('login.microsoft')) return

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
        }
        return res
      }).catch(() => cached)
      return cached || network
    })
  )
})
