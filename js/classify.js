import { getState, setState, applyFilters, SCREENSHOT_NAME, isVideo } from './store.js'
import { savePhotos, getThumbnail, getEmbeddings, saveEmbeddings } from './db.js'
import { getThumbnailUrls, waitIfThrottled, noteThrottle, throttledUntil } from './graph.js'
import { logError } from './ui.js'
import { getAccount } from './auth.js'
import { saveToCloud } from './sync.js'

// Subir este número re-clasifica todas las fotos (p. ej. al cambiar las frases o el margen).
// Con el vector guardado en este dispositivo, reclasificar es instantáneo y no vuelve a pedir miniaturas.
export const KIND_VERSION = 2

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'
const MODEL = 'Xenova/clip-vit-base-patch32'

// Un tipo especial debe superar a la mejor frase de "foto" por este margen; si no, la foto queda como normal.
// Con argmax simple, fotos de obra sin gente salían como "personas" por diferencias mínimas.
const MARGIN = 0.015

// Frases en inglés porque CLIP se entrenó en inglés. La galería es sobre todo de obra: muchas frases de "foto".
const PROMPTS = [
  ['foto', 'a photo of a construction site'],
  ['foto', 'a photo of a building under construction'],
  ['foto', 'a photo of concrete, rebar or formwork'],
  ['foto', 'a photo of a wall, floor or ceiling'],
  ['foto', 'a photo of a room interior'],
  ['foto', 'a photo of plumbing, electrical work or a roof'],
  ['foto', 'a photo of construction materials or tools'],
  ['foto', 'a photo of a house exterior'],
  ['foto', 'a photo of a landscape or a beach'],
  ['foto', 'a photo of a car or a street'],
  ['foto', 'a photo of an animal or a pet'],
  ['foto', 'a photo of food'],
  ['foto', 'a photo of furniture'],
  ['foto', 'a photo of a pool or a garden'],
  ['foto', 'a photo of machinery or a truck'],
  ['personas', 'a photo of people posing for the camera'],
  ['personas', 'a group photo of friends or family'],
  ['personas', 'a portrait photo of a person'],
  ['personas', 'a photo of people at a party, a sports game or an event'],
  ['selfie', 'a selfie'],
  ['selfie', 'a close-up selfie of a face taken with a front camera'],
  ['selfie', 'a selfie of a group of people'],
  ['captura', 'a screenshot of a mobile app user interface'],
  ['captura', 'a screenshot of a website'],
  ['captura', 'a screenshot of a text message conversation'],
  ['grafico', 'a digital illustration'],
  ['grafico', 'a logo'],
  ['grafico', 'a diagram or a chart'],
  ['grafico', 'an architectural floor plan drawing'],
  ['grafico', 'a meme or an image with text and graphics'],
  ['documento', 'a photo of a paper receipt'],
  ['documento', 'a photo of a printed document'],
  ['documento', 'a photo of an invoice or a bill'],
  ['documento', 'a photo of handwritten notes on paper'],
  ['documento', 'a scanned page of a document'],
]

export function canClassifyHere() {
  return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 768
}

const PREFETCH = 4           // lotes descargándose mientras se analiza el actual
const MAX_DOWNLOADS = 12     // miniaturas descargándose a la vez
const UI_EVERY_MS = 1000     // con miles de fotos, refrescar la vista por cada foto es lo que más tarda
const FILTER_EVERY_MS = 15000
const CLOUD_EVERY_MS = 5 * 60000  // el índice pesa varios MB: subirlo de vez en cuando, no por lote

// Ritmo adaptable: OneDrive bloquea por un rato si se le piden demasiadas miniaturas seguidas
// Se recuerda el ritmo en que OneDrive empezó a bloquear: después se trabaja un poco por debajo de él,
// porque cada bloqueo cuesta 1–2 minutos de espera.
const RATE_MIN = 3, RATE_MAX = 40
const CEILING_MIN = 6        // nunca recordar un techo menor: OneDrive aguanta al menos esto en promedio
const RATE_KEY = 'rode-fotos-ritmo2'
let _ceiling = Math.max(CEILING_MIN, Number(localStorage.getItem(RATE_KEY)) || RATE_MAX)
let _rate = Math.min(12, _ceiling)
let _okStreak = 0, _probeStreak = 0, _lastThrottle = 0
let _nextStartAt = 0

// ── Diagnóstico minuto a minuto (se ve en Fuentes) ─────────────────────────
const DIAG_KEY = 'rode-fotos-diagnostico'
function newMinute() {
  return { at: Date.now(), ocultaMs: 0, fotos: 0, deVector: 0, lotes: 0, esperaBloqueoMs: 0, esperaRitmoMs: 0,
    graphLlamadas: 0, graphMs: 0, graphPedidas: 0, sinUrl: 0, bloqueosGraph: 0,
    descOk: 0, descMs: 0, desc429: 0, descRed: 0, descNoDisp: 0, iaMs: 0, ritmo: 0, techo: 0 }
}
let _diag = newMinute()
// Tiempo con la pestaña oculta o minimizada (Chrome le da menos recursos)
let _hiddenSince = document.hidden ? Date.now() : 0
document.addEventListener('visibilitychange', () => {
  if (document.hidden) _hiddenSince = Date.now()
  else if (_hiddenSince) { _diag.ocultaMs += Date.now() - _hiddenSince; _hiddenSince = 0 }
})
function flushDiag(force = false) {
  if (!force && Date.now() - _diag.at < 60000) return
  _diag.ritmo = +_rate.toFixed(1); _diag.techo = +_ceiling.toFixed(1)
  _diag.duracionMs = Date.now() - _diag.at
  if (_hiddenSince) { _diag.ocultaMs += Date.now() - _hiddenSince; _hiddenSince = Date.now() }
  if (_diag.lotes || _diag.fotos) {
    try {
      const log = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]')
      log.push(_diag)
      localStorage.setItem(DIAG_KEY, JSON.stringify(log.slice(-180)))
      document.dispatchEvent(new Event('rode:diag'))
    } catch {}
  }
  _diag = newMinute()
}
export function getDiagnostics() {
  try { return JSON.parse(localStorage.getItem(DIAG_KEY) || '[]') } catch { return [] }
}
export function clearDiagnostics() {
  try { localStorage.removeItem(DIAG_KEY) } catch {}
  document.dispatchEvent(new Event('rode:diag'))
}

let _running = false
let _model = null
let _forceCpu = false

export async function startClassification() {
  if (_running || !canClassifyHere() || !getAccount()) return
  _running = true
  let lastUi = 0, lastFilter = Date.now(), lastCloud = Date.now()
  try {
    let pending = getPending()
    while (pending.length) {
      setStatus({ active: true, done: 0, total: pending.length, message: 'Preparando modelo de IA…' })
      let model = await loadModel()
      const t0 = Date.now()
      const before = classifiedTotal()
      const chunks = []
      for (let i = 0; i < pending.length; i += model.batch) chunks.push(pending.slice(i, i + model.batch))

      const inflight = chunks.slice(0, PREFETCH).map(c => prepareBatch(c))
      let done = 0
      for (let b = 0; b < chunks.length; b++) {
        const ready = await inflight.shift()
        if (b + PREFETCH < chunks.length) inflight.push(prepareBatch(chunks[b + PREFETCH]))

        try {
          await saveResults(await classifyBatch(model, ready))
        } catch (e) {
          logError('Error de la IA al clasificar un lote', e.message)
          if (model.device !== 'wasm') {
            // La tarjeta gráfica puede perderse (driver, suspensión): seguir con el procesador
            _forceCpu = true
            await model.visionModel?.dispose?.()
            _model = null
            model = await loadModel()
            await saveResults(await classifyBatch(model, ready)).catch(() => {})
          }
        }
        done += chunks[b].length

        flushDiag()
        const now = Date.now()
        if (now - lastFilter > FILTER_EVERY_MS) { applyFilters(); lastFilter = now }
        if (now - lastCloud > CLOUD_EVERY_MS) { saveToCloud(); lastCloud = now }
        if (now - lastUi > UI_EVERY_MS) {
          const perSec = (classifiedTotal() - before) / ((now - t0) / 1000)
          setStatus({ active: true, done, total: pending.length, message: '', perSec, device: model.device })
          lastUi = now
        }
      }
      applyFilters()
      saveToCloud()
      // Si una vuelta completa no avanzó nada (OneDrive sigue bloqueando), parar y reintentar otro día
      if (classifiedTotal() === before) {
        logError('La clasificación se detuvo: OneDrive no entregó miniaturas. Se reintentará al abrir la app.')
        break
      }
      pending = getPending()
    }
  } catch (e) {
    logError('La clasificación se detuvo', e.message)
  } finally {
    flushDiag(true)
    _running = false
    setStatus({ active: false, done: 0, total: 0, message: '' })
  }
}

function classifiedTotal() {
  return getState().photos.reduce((n, p) => n + ((p.kindV || 0) >= KIND_VERSION ? 1 : 0), 0)
}

// Ya intentadas en esta sesión; las que fallaron (sin miniatura, sin red…) se reintentan al volver a abrir la app
const _attempted = new Set()

// Las más recientes primero: son las que más se consultan
function getPending() {
  const here = new Set(getState().sources.map(s => s.id))
  return getState().photos.filter(p =>
    !isVideo(p) && !SCREENSHOT_NAME.test(p.name || '') && (p.kindV || 0) < KIND_VERSION &&
    !_attempted.has(p.id) && (p.sourceType !== 'local' || here.has(p.sourceId)))
    .sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))
}

// Reparte los inicios de lote para no pasar de _rate fotos por segundo
async function pace(n) {
  const now = Date.now()
  const start = Math.max(now, _nextStartAt)
  _nextStartAt = start + (n / _rate) * 1000
  if (start > now) await sleep(start - now)
}

function onThrottled() {
  // Los lotes que se descargan en paralelo ven el mismo bloqueo: contarlo una sola vez
  if (Date.now() - _lastThrottle < 30000) return
  _lastThrottle = Date.now()
  _ceiling = Math.max(CEILING_MIN, _rate * 0.8)
  try { localStorage.setItem(RATE_KEY, _ceiling.toFixed(1)) } catch {}
  _rate = Math.max(RATE_MIN, _rate / 2)
  _okStreak = 0; _probeStreak = 0
}

function onBatchOk(n) {
  _okStreak += n; _probeStreak += n
  if (_okStreak >= 100) { _rate = Math.min(_ceiling, _rate + 2); _okStreak = 0 }
  // Sin bloqueos por un buen rato: probar con un poco más
  if (_probeStreak >= 600) { _ceiling = Math.min(RATE_MAX, _ceiling + 1); _probeStreak = 0 }
}

let _activeDownloads = 0
const _downloadQueue = []
async function limitedFetch(url) {
  if (_activeDownloads >= MAX_DOWNLOADS) await new Promise(r => _downloadQueue.push(r))
  _activeDownloads++
  try { return await fetch(url) } finally {
    _activeDownloads--
    _downloadQueue.shift()?.()
  }
}

// Chrome frena los temporizadores de una pestaña oculta (hasta 1 por minuto); los de un hilo aparte no.
// Por eso las pausas de la clasificación se cuentan en un worker mínimo.
let _timer = null, _timerSeq = 0
const _timerWait = new Map()
function sleep(ms) {
  if (!_timer) {
    try {
      const src = 'onmessage = e => setTimeout(() => postMessage(e.data.id), e.data.ms)'
      _timer = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
      _timer.onmessage = e => { _timerWait.get(e.data)?.(); _timerWait.delete(e.data) }
    } catch { _timer = false }
  }
  if (!_timer) return new Promise(r => setTimeout(r, ms))
  return new Promise(r => { const id = ++_timerSeq; _timerWait.set(id, r); _timer.postMessage({ id, ms }) })
}

// Aplica sobre la versión actual de cada foto: el estado puede haberse recargado desde la nube mientras tanto
async function saveResults(results) {
  if (!results.length) return
  const byId = new Map(getState().photos.map(p => [p.id, p]))
  const updated = []
  for (const [id, kind] of results) {
    const p = byId.get(id)
    if (p) updated.push(Object.assign(p, { kind, kindV: KIND_VERSION }))
  }
  _diag.fotos += updated.length
  if (updated.length) await savePhotos(updated)
}

function setStatus(classifying) {
  setState({ classifying })
}

async function loadModel() {
  if (_model) return _model
  const T = await import(TRANSFORMERS_URL)
  const tokenizer = await T.AutoTokenizer.from_pretrained(MODEL)
  const textModel = await T.CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' })
  const { text_embeds } = await textModel(tokenizer(PROMPTS.map(p => p[1]), { padding: true, truncation: true }))
  const textVecs = text_embeds.tolist().map(normalize)
  await textModel.dispose?.()

  // Con la tarjeta gráfica (WebGPU) es mucho más rápido: fp16 si la tarjeta lo soporta, si no fp32
  const gpu = _forceCpu ? null : await gpuInfo()
  if (gpu) {
    try {
      const processor = await T.AutoProcessor.from_pretrained(MODEL)
      const visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: gpu.f16 ? 'fp16' : 'fp32', device: 'webgpu' })
      _model = { T, processor, visionModel, textVecs, device: 'webgpu', batch: 32 }
      return _model
    } catch (e) {
      logError('Tarjeta gráfica no disponible; se clasificará con el procesador', e.message)
    }
  }
  // Sin tarjeta gráfica: varios hilos del procesador en paralelo
  const pool = createPool(Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))))
  _model = { T, pool, textVecs, device: 'wasm', batch: 8 * pool.size }
  return _model
}

async function gpuInfo() {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    return adapter ? { f16: adapter.features.has('shader-f16') } : null
  } catch { return null }
}

function createPool(size) {
  const workers = Array.from({ length: size }, () => new Worker(new URL('./clipWorker.js', import.meta.url), { type: 'module' }))
  const waiting = new Map()
  let seq = 0
  workers.forEach(w => {
    w.onmessage = ({ data }) => {
      const p = waiting.get(data.id)
      waiting.delete(data.id)
      data.error ? p?.reject(new Error(data.error)) : p?.resolve(data.vecs)
    }
    w.onerror = e => logError('Error en un hilo de la IA', e.message)
  })
  return {
    size,
    // Reparte las imágenes entre los hilos y devuelve un vector (o null) por imagen, en el mismo orden
    async embed(blobs) {
      const per = Math.ceil(blobs.length / size)
      const parts = workers.map((w, k) => {
        const slice = blobs.slice(k * per, (k + 1) * per)
        if (!slice.length) return Promise.resolve([])
        const id = ++seq
        return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); w.postMessage({ id, blobs: slice }) })
      })
      return (await Promise.all(parts)).flat()
    },
  }
}

// Descarga las miniaturas de un lote (en paralelo) y las deja listas para el modelo.
// Las fotos con vector ya guardado no se descargan: solo se vuelven a puntuar.
async function prepareBatch(photos) {
  photos.forEach(p => _attempted.add(p.id))
  const known = await getEmbeddings(photos.map(p => p.id)).catch(() => new Map())
  const fromVec = photos.filter(p => known.has(p.id)).map(photo => ({ photo, vec: known.get(photo.id) }))
  photos = photos.filter(p => !known.has(p.id))
  _diag.deVector += fromVec.length
  if (!photos.length) return fromVec
  _diag.lotes++

  let t = Date.now()
  await waitIfThrottled()
  _diag.esperaBloqueoMs += Date.now() - t
  t = Date.now()
  await pace(photos.length)
  _diag.esperaRitmoMs += Date.now() - t

  const od = photos.filter(p => p.sourceType === 'onedrive')
  let urls = new Map()
  const blockedBefore = throttledUntil()
  if (od.length) {
    t = Date.now()
    urls = await getThumbnailUrls(od, 'medium').catch(e => {
      logError('No se pudieron pedir miniaturas a OneDrive', e.message)
      return new Map()
    })
    _diag.graphLlamadas += Math.ceil(od.length / 20)
    _diag.graphMs += Date.now() - t
    _diag.graphPedidas += od.length
    _diag.sinUrl += od.filter(p => !urls.has(p.itemId)).length
    if (throttledUntil() > blockedBefore) _diag.bloqueosGraph++
  }

  // Un 429 del servidor de miniaturas llega sin cabeceras CORS (el navegador solo ve un error de red),
  // pero también fallan así algunas miniaturas sueltas (HEIC, RAW…). Solo es bloqueo si falla buena parte del lote.
  let limited = 0, netFail = 0, tried = 0
  const items = await Promise.all(photos.map(async photo => {
    try {
      let blob = null
      if (photo.sourceType === 'local') {
        blob = await getThumbnail(photo.id)
      } else if (urls.has(photo.itemId)) {
        tried++
        let res = null
        const t0 = Date.now()
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
          try { res = await limitedFetch(urls.get(photo.itemId)) } catch { if (!attempt) await sleep(1500) }
        }
        if (!res) { netFail++; _diag.descRed++; _attempted.delete(photo.id); return null }
        if (res.status === 429 || res.status === 503) { limited++; _diag.desc429++; _attempted.delete(photo.id); return null }
        if (!res.ok) { _diag.descNoDisp++; return null }   // 406/500: OneDrive no puede generar esa miniatura
        blob = await res.blob()
        _diag.descOk++; _diag.descMs += Date.now() - t0
      }
      return blob ? { photo, blob } : null
    } catch { return null }
  }))

  // También cuenta si Graph pidió esperar al pedir las direcciones de las miniaturas
  if (limited || (tried && netFail >= Math.max(3, tried / 2)) || throttledUntil() > blockedBefore) {
    onThrottled()
    if (limited || netFail) noteThrottle(limited ? 60 : 20, 'miniaturas')
  } else {
    onBatchOk(photos.length)
  }
  return [...fromVec, ...items.filter(Boolean)]
}

async function classifyBatch({ T, processor, visionModel, pool, textVecs }, ready) {
  if (!ready.length) return []
  const toEmbed = ready.filter(r => r.blob)
  const tIa = Date.now()
  if (toEmbed.length) {
    let vecs
    if (pool) {
      vecs = await pool.embed(toEmbed.map(r => r.blob))
    } else {
      const images = await Promise.all(toEmbed.map(r => T.RawImage.fromBlob(r.blob).catch(() => null)))
      const ok = images.map((img, i) => img ? i : -1).filter(i => i >= 0)
      vecs = new Array(toEmbed.length).fill(null)
      if (ok.length) {
        const { image_embeds } = await visionModel(await processor(ok.map(i => images[i])))
        image_embeds.tolist().forEach((v, k) => { vecs[ok[k]] = v })
      }
    }
    toEmbed.forEach((r, i) => { if (vecs[i]) r.vec = Float32Array.from(normalize(vecs[i])) })
    await saveEmbeddings(toEmbed.filter(r => r.vec).map(r => [r.photo.id, r.vec])).catch(() => {})
  }
  _diag.iaMs += Date.now() - tIa
  return ready.filter(r => r.vec).map(r => [r.photo.id, decideKind(r.vec, r.photo, textVecs)])
}

function decideKind(img, photo, textVecs) {
  const best = {}
  textVecs.forEach((t, k) => {
    const kind = PROMPTS[k][0]
    const s = dot(img, t)
    if (!(kind in best) || s > best[kind]) best[kind] = s
  })
  // Si la foto trae datos de cámara no puede ser captura ni gráfico
  const hasCamera = !!(photo.cameraMake || photo.cameraModel)
  let top = null
  for (const [kind, s] of Object.entries(best)) {
    if (kind === 'foto' || (hasCamera && (kind === 'captura' || kind === 'grafico'))) continue
    if (!top || s > top[1]) top = [kind, s]
  }
  return top && top[1] - best.foto >= MARGIN ? top[0] : 'foto'
}

function normalize(v) {
  const n = Math.hypot(...v)
  return v.map(x => x / n)
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
