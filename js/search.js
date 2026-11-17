import { getAllEmbeddings, embeddingsVersion } from './db.js'

// Búsqueda por texto con la misma IA (CLIP) que clasifica: compara la frase con el vector guardado de cada foto.
// CLIP solo entiende inglés, así que la frase se traduce primero del español.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'
const CLIP = 'Xenova/clip-vit-base-patch32'
const TRANSLATOR = 'Xenova/opus-mt-es-en'

const MAX_RESULTS = 500
const BELOW_BEST = 0.05   // se muestran las fotos que quedan cerca de la mejor coincidencia

let _models = null
let _vecs = null, _vecsVersion = -1

async function loadModels() {
  if (!_models) {
    _models = (async () => {
      const T = await import(TRANSFORMERS_URL)
      const [translate, tokenizer, textModel] = await Promise.all([
        T.pipeline('translation', TRANSLATOR, { dtype: 'q8', device: 'wasm' }),
        T.AutoTokenizer.from_pretrained(CLIP),
        T.CLIPTextModelWithProjection.from_pretrained(CLIP, { dtype: 'q8', device: 'wasm' }),
      ])
      return { translate, tokenizer, textModel }
    })()
    _models.catch(() => { _models = null })
  }
  return _models
}

async function loadVecs() {
  if (!_vecs || _vecsVersion !== embeddingsVersion) {
    _vecsVersion = embeddingsVersion
    _vecs = await getAllEmbeddings()
  }
  return _vecs
}

export function searchReady() { return !!_models }

// El traductor aprendió español de España: palabras de México y de obra se cambian antes de traducir
// ("alberca café" salía como "coffee pool")
// \b no reconoce letras con acento: se delimitan las palabras a mano
const word = (src, before = '') => new RegExp(`${before}(?<!\\p{L})(?:${src})(?!\\p{L})`, 'giu')
const GLOSSARY = [
  [word('caf[eé]s?', '(?<!de )'), 'marrón'],       // color; "taza de café" se queda
  [word('albercas?'), 'piscina'],
  [word('cimbras?'), 'encofrado'],
  [word('colados?'), 'vertido de concreto'],
  [word('varillas?'), 'barras de acero'],
  [word('blocks?'), 'bloques de concreto'],
  [word('castillos?'), 'columnas de concreto'],
  [word('impermeabilizaci[oó]n'), 'impermeabilización de techo'],
  [word('carros?'), 'coche'],
  [word('camionetas?'), 'camioneta pickup'],
  [word('celular(?:es)?'), 'teléfono'],
  [word('recibos?|tickets?'), 'recibo'],
]

function localize(query) {
  return GLOSSARY.reduce((q, [re, rep]) => q.replace(re, rep), query)
}

// Devuelve { english, scores: Map photoId → puntaje } con las fotos que coinciden, de mayor a menor
export async function searchPhotos(query) {
  const [{ translate, tokenizer, textModel }, { ids, matrix, dim }] = await Promise.all([loadModels(), loadVecs()])
  if (!ids.length) return { english: '', scores: new Map(), empty: true }

  const [{ translation_text }] = await translate(localize(query))
  const english = translation_text.replace(/[.!?]+$/, '').trim()
  const { text_embeds } = await textModel(tokenizer([`a photo of ${english}`], { padding: true, truncation: true }))
  const q = text_embeds.data
  let n = 0
  for (let k = 0; k < dim; k++) n += q[k] * q[k]
  n = Math.sqrt(n)

  const scores = new Float32Array(ids.length)
  let best = -1
  for (let i = 0; i < ids.length; i++) {
    let s = 0
    const off = i * dim
    for (let k = 0; k < dim; k++) s += matrix[off + k] * q[k]
    s /= n
    scores[i] = s
    if (s > best) best = s
  }

  const order = []
  for (let i = 0; i < ids.length; i++) if (scores[i] >= best - BELOW_BEST) order.push(i)
  order.sort((a, b) => scores[b] - scores[a])
  return { english, scores: new Map(order.slice(0, MAX_RESULTS).map(i => [ids[i], scores[i]])) }
}
