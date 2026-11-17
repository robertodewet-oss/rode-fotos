import { getState, setState, applyFilters, SCREENSHOT_NAME } from './store.js'
import { savePhotos, getThumbnail } from './db.js'
import { getThumbnailUrl } from './graph.js'
import { getAccount } from './auth.js'
import { scheduleSave } from './sync.js'

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

let _running = false
let _model = null

export async function startClassification() {
  if (_running || !canClassifyHere() || !getAccount()) return
  _running = true
  try {
    let pending = getPending()
    while (pending.length) {
      setStatus({ active: true, done: 0, total: pending.length, message: 'Preparando modelo de IA…' })
      const model = await loadModel()
      let results = []
      for (let i = 0; i < pending.length; i++) {
        const photo = pending[i]
        _attempted.add(photo.id)
        setStatus({ active: true, done: i, total: pending.length, message: '' })
        try {
          const kind = await classifyPhoto(model, photo)
          if (kind) results.push([photo.id, kind])
        } catch (e) {
          console.warn('[classify]', photo.name, e.message)
        }
        if (results.length >= 20 || i === pending.length - 1) {
          await saveResults(results)
          results = []
        }
      }
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

function getPending() {
  const here = new Set(getState().sources.map(s => s.id))
  return getState().photos.filter(p =>
    p.mediaType !== 'video' && !SCREENSHOT_NAME.test(p.name || '') && (p.kindV || 0) < KIND_VERSION &&
    !_attempted.has(p.id) && (p.sourceType !== 'local' || here.has(p.sourceId)))
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
  applyFilters()
  scheduleSave()
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
  const visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' })
  _model = { T, processor, visionModel, textVecs }
  return _model
}

async function classifyPhoto({ T, processor, visionModel, textVecs }, photo) {
  const url = await imageUrlFor(photo)
  if (!url) return null
  let image
  try {
    image = await T.RawImage.fromURL(url)
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  const { image_embeds } = await visionModel(await processor(image))
  const img = normalize(image_embeds.tolist()[0])

  const ranked = textVecs
    .map((t, i) => ({ kind: PROMPTS[i][0], score: dot(img, t) }))
    .sort((a, b) => b.score - a.score)

  // Si la foto trae datos de cámara no puede ser captura ni gráfico
  const hasCamera = !!(photo.cameraMake || photo.cameraModel)
  const best = ranked.find(r => !(hasCamera && (r.kind === 'captura' || r.kind === 'grafico')))
  return best.kind
}

async function imageUrlFor(photo) {
  if (photo.sourceType === 'local') {
    const blob = await getThumbnail(photo.id).catch(() => null)
    return blob ? URL.createObjectURL(blob) : null
  }
  if (photo.sourceType === 'onedrive') {
    return getThumbnailUrl(photo.driveId, photo.itemId, 'medium')
  }
  return null
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
