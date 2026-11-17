import { getState, setState, applyFilters, SCREENSHOT_NAME, isVideo } from './store.js'
import { savePhotos, getThumbnail, getEmbeddings, saveEmbeddings } from './db.js'
import { getThumbnailUrls, waitIfThrottled, noteThrottle } from './graph.js'
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

const BATCH = 16             // fotos por pasada del modelo
const PREFETCH = 2           // lotes descargándose mientras se analiza el actual
const MAX_DOWNLOADS = 6      // miniaturas descargándose a la vez
const UI_EVERY_MS = 1000     // con miles de fotos, refrescar la vista por cada foto es lo que más tarda
const FILTER_EVERY_MS = 15000
const CLOUD_EVERY_MS = 5 * 60000  // el índice pesa varios MB: subirlo de vez en cuando, no por lote

// Ritmo adaptable: OneDrive bloquea por un rato si se le piden demasiadas miniaturas seguidas
const RATE_MIN = 2, RATE_START = 8, RATE_MAX = 25
let _rate = RATE_START
let _okStreak = 0
let _nextStartAt = 0

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
      for (let i = 0; i < pending.length; i += BATCH) chunks.push(pending.slice(i, i + BATCH))

      const inflight = chunks.slice(0, PREFETCH).map(c => prepareBatch(model.T, c))
      let done = 0
      for (let b = 0; b < chunks.length; b++) {
        const ready = await inflight.shift()
        if (b + PREFETCH < chunks.length) inflight.push(prepareBatch(model.T, chunks[b + PREFETCH]))

        try {
          await saveResults(await classifyBatch(model, ready))
        } catch (e) {
          logError('Error de la IA al clasificar un lote', e.message)
          if (model.device === 'webgpu') {
            // La tarjeta gráfica puede perderse (driver, suspensión): seguir con el procesador
            _forceCpu = true
            _model = null
            model = await loadModel()
            await saveResults(await classifyBatch(model, ready)).catch(() => {})
          }
        }
        done += chunks[b].length

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
  _rate = Math.max(RATE_MIN, _rate / 2)
  _okStreak = 0
}

function onBatchOk(n) {
  _okStreak += n
  if (_okStreak >= 400) { _rate = Math.min(RATE_MAX, _rate + 2); _okStreak = 0 }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Aplica sobre la versión actual de cada foto: el estado puede haberse recargado desde la nube mientras tanto
async function saveResults(results) {
  if (!results.length) return
  const byId = new Map(getState().photos.map(p => [p.id, p]))
  const updated = []
  for (const [id, kind] of results) {
    const p = byId.get(id)
    if (p) updated.push(Object.assign(p, { kind, kindV: KIND_VERSION }))
  }
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

  const processor = await T.AutoProcessor.from_pretrained(MODEL)
  let visionModel = null, device = 'wasm'
  // Con la tarjeta gráfica (WebGPU) es ~5 veces más rápido; necesita soporte de fp16
  if (!_forceCpu && await hasGpuF16()) {
    try {
      visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'fp16', device: 'webgpu' })
      device = 'webgpu'
    } catch (e) {
      logError('Tarjeta gráfica no disponible; se clasificará con el procesador', e.message)
    }
  }
  if (!visionModel) visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' })
  _model = { T, processor, visionModel, textVecs, device }
  return _model
}

async function hasGpuF16() {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    return !!adapter?.features.has('shader-f16')
  } catch { return false }
}

// Descarga las miniaturas de un lote (en paralelo) y las deja listas para el modelo.
// Las fotos con vector ya guardado no se descargan: solo se vuelven a puntuar.
async function prepareBatch(T, photos) {
  photos.forEach(p => _attempted.add(p.id))
  const known = await getEmbeddings(photos.map(p => p.id)).catch(() => new Map())
  const fromVec = photos.filter(p => known.has(p.id)).map(photo => ({ photo, vec: known.get(photo.id) }))
  photos = photos.filter(p => !known.has(p.id))
  if (!photos.length) return fromVec

  await waitIfThrottled()
  await pace(photos.length)

  const od = photos.filter(p => p.sourceType === 'onedrive')
  let urls = new Map()
  if (od.length) {
    urls = await getThumbnailUrls(od, 'medium').catch(e => {
      logError('No se pudieron pedir miniaturas a OneDrive', e.message)
      return new Map()
    })
  }

  let throttled = false
  const items = await Promise.all(photos.map(async photo => {
    try {
      let blob = null
      if (photo.sourceType === 'local') {
        blob = await getThumbnail(photo.id)
      } else if (urls.has(photo.itemId)) {
        let res
        try {
          res = await limitedFetch(urls.get(photo.itemId))
        } catch {
          // Un 429 del servidor de miniaturas llega sin cabeceras CORS: el navegador solo ve un error de red
          throttled = true
          _attempted.delete(photo.id)
          return null
        }
        if (res.status === 429 || res.status === 503) { throttled = true; _attempted.delete(photo.id); return null }
        if (!res.ok) return null   // 406/500: OneDrive no puede generar esa miniatura
        blob = await res.blob()
      }
      return blob ? { photo, image: await T.RawImage.fromBlob(blob) } : null
    } catch { return null }
  }))

  if (throttled) {
    onThrottled()
    noteThrottle(60, 'miniaturas')
  } else {
    onBatchOk(photos.length)
  }
  return [...fromVec, ...items.filter(Boolean)]
}

async function classifyBatch({ processor, visionModel, textVecs }, ready) {
  if (!ready.length) return []
  const toEmbed = ready.filter(r => r.image)
  if (toEmbed.length) {
    const { image_embeds } = await visionModel(await processor(toEmbed.map(r => r.image)))
    const vecs = image_embeds.tolist().map(normalize)
    toEmbed.forEach((r, i) => { r.vec = Float32Array.from(vecs[i]) })
    await saveEmbeddings(toEmbed.map(r => [r.photo.id, r.vec])).catch(() => {})
  }
  return ready.map(r => [r.photo.id, decideKind(r.vec, r.photo, textVecs)])
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
