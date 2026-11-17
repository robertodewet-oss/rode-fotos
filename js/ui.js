// Módulo de UI utilitarios — sin dependencias circulares

export function notify(msg, type = 'info') {
  if (type === 'error') logError(msg)
  const container = document.getElementById('notifications')
  if (!container) { console.info(`[notify] ${msg}`); return }
  const el = document.createElement('div')
  el.className = `notification ${type}`
  el.textContent = msg
  container.appendChild(el)
  // Los errores se quedan más tiempo para alcanzar a leerlos (y quedan en Fuentes → Registro)
  const ms = type === 'error' ? 10000 : 3500
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s' }, ms)
  setTimeout(() => el.remove(), ms + 500)
}

// ── Registro de errores (por dispositivo) ────────────────────────────────
const LOG_KEY = 'rode-fotos-errores'
const LOG_MAX = 200

// Las URLs de OneDrive llevan credenciales temporales en la query: nunca guardarlas
function sanitize(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?'"]+)\?[^\s'"]*/g, '$1?…')
    .replace(/tempauth=[^\s&'"]+/g, 'tempauth=…')
    .replace(/Bearer\s+[\w.-]+/g, 'Bearer …')
    .slice(0, 600)
}

export function logError(message, detail = '') {
  const entry = { at: Date.now(), message: sanitize(message), detail: detail ? sanitize(detail) : '' }
  console.warn('[RODE Fotos]', entry.message, entry.detail)
  try {
    const log = getErrorLog()
    log.push(entry)
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX)))
  } catch {}
  document.dispatchEvent(new CustomEvent('rode:errorlog'))
}

export function getErrorLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]') } catch { return [] }
}

export function clearErrorLog() {
  try { localStorage.removeItem(LOG_KEY) } catch {}
  document.dispatchEvent(new CustomEvent('rode:errorlog'))
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function fileExt(name = '') {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toUpperCase() : ''
}

export function formatDate(ts, opts = {}) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', ...opts })
}
