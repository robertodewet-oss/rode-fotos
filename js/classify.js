import { getState, setState, applyFilters, SCREENSHOT_NAME } from './store.js'
import { savePhotos, getThumbnail } from './db.js'
import { getThumbnailUrls } from './graph.js'
import { getAccount } from './auth.js'
import { saveToCloud } from './sync.js'

// Subir este número re-clasifica todas las fotos (p. ej. al cambiar las frases)
export const KIND_VERSION = 1

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'
const MODEL = 'Xenova/clip-vit-base-patch32'

// Frases en inglés porque CLIP se entrenó en inglés; la que más se parece a la imagen decide el tipo
const PROMPTS = [
  ['foto', 'a photo of a construction site'],
  ['foto', 'a photo of a building or a house'],
  ['foto', 'a photo of a room interior'],
  ['foto', 'a photo of construction materials or tools'],
  ['foto', 'a photo of a landscape or a beach'],
  ['foto', 'a photo of a car or a street'],
  ['foto', 'a photo of an animal or a pet'],
  ['foto', 'a photo of food'],
  ['foto', 'a photo of furniture'],
  ['personas', 'a photo of people'],
  ['personas', 'a photo of a person'],
  ['personas', 'a portrait photo of a person'],
  ['personas', 'a photo of people playing a sport'],
  ['personas', 'a family photo'],
  ['selfie', 'a selfie'],
  ['selfie', 'a close-up selfie of a face taken with a front camera'],
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
const PREFETCH = 3           // lotes descargándose mientras se analiza el actual
const UI_EVERY_MS = 1000     // con miles de fotos, refrescar la vista por cada foto es lo que más tarda
const FILTER_EVERY_MS = 15000
const CLOUD_EVERY_MS = 5 * 60000  // el índice pesa varios MB: subirlo de vez en cuando, no por lote

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
          console.warn('[classify] lote', e.message)
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
          const perSec = done / ((now - t0) / 1000)
          setStatus({ active: true, done, total: pending.length, message: '', perSec, device: model.device })
          lastUi = now
        }
      }
      applyFilters()
      saveToCloud()
      pending = getPending()
    }
  } catch (e) {
    console.warn('[classify] detenido:', e.message)
  } finally {
    _running = false
    setStatus({ active: false, done: 0, total: 0, message: '' })
  }
}

// Ya intentadas en esta sesión; las que fallaron (sin miniatura, sin red…) se reintentan al volver a abrir la app
const _attempted = new Set()

// Las más recientes primero: son las que más se consultan
function getPending() {
  const here = new Set(getState().sources.map(s => s.id))
  return getState().photos.filter(p =>
    p.mediaType !== 'video' && !SCREENSHOT_NAME.test(p.name || '') && (p.kindV || 0) < KIND_VERSION &&
    !_attempted.has(p.id) && (p.sourceType !== 'local' || here.has(p.sourceId)))
    .sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))
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
      console.warn('[classify] WebGPU no disponible, usando CPU:', e.message)
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

// Descarga las miniaturas de un lote (en paralelo) y las deja listas para el modelo
async function prepareBatch(T, photos) {
  photos.forEach(p => _attempted.add(p.id))
  const od = photos.filter(p => p.sourceType === 'onedrive')
  let urls = new Map()
  if (od.length) urls = await getThumbnailUrls(od, 'medium').catch(e => { console.warn('[classify] miniaturas', e.message); return new Map() })

  const items = await Promise.all(photos.map(async photo => {
    try {
      const blob = photo.sourceType === 'local'
        ? await getThumbnail(photo.id)
        : urls.has(photo.itemId) ? await (await fetch(urls.get(photo.itemId))).blob() : null
      return blob ? { photo, image: await T.RawImage.fromBlob(blob) } : null
    } catch { return null }
  }))
  return items.filter(Boolean)
}

async function classifyBatch({ processor, visionModel, textVecs }, ready) {
  if (!ready.length) return []
  const { image_embeds } = await visionModel(await processor(ready.map(r => r.image)))
  return image_embeds.tolist().map((emb, i) => {
    const img = normalize(emb)
    const ranked = textVecs
      .map((t, k) => ({ kind: PROMPTS[k][0], score: dot(img, t) }))
      .sort((a, b) => b.score - a.score)
    // Si la foto trae datos de cámara no puede ser captura ni gráfico
    const photo = ready[i].photo
    const hasCamera = !!(photo.cameraMake || photo.cameraModel)
    const best = ranked.find(r => !(hasCamera && (r.kind === 'captura' || r.kind === 'grafico')))
    return [photo.id, best.kind]
  })
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
