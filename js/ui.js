// Módulo de UI utilitarios — sin dependencias circulares

export function notify(msg, type = 'info') {
  const container = document.getElementById('notifications')
  if (!container) { console.info(`[notify] ${msg}`); return }
  const el = document.createElement('div')
  el.className = `notification ${type}`
  el.textContent = msg
  container.appendChild(el)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s' }, 3500)
  setTimeout(() => el.remove(), 4000)
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function formatDate(ts, opts = {}) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', ...opts })
}
