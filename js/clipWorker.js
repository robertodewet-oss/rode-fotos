// Analiza miniaturas con CLIP en un hilo aparte. Varios de estos trabajan en paralelo cuando no hay tarjeta gráfica:
// GitHub Pages no permite el modo multihilo de WebAssembly, así que se reparte el trabajo entre hilos independientes.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'
const MODEL = 'Xenova/clip-vit-base-patch32'

let _ready = null

async function init() {
  const T = await import(TRANSFORMERS_URL)
  T.env.backends.onnx.wasm.numThreads = 1
  const processor = await T.AutoProcessor.from_pretrained(MODEL)
  const model = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' })
  return { T, processor, model }
}

self.onmessage = async ({ data: { id, blobs } }) => {
  try {
    _ready ??= init()
    const { T, processor, model } = await _ready
    // Una imagen dañada no debe tumbar el lote completo
    const images = await Promise.all(blobs.map(b => T.RawImage.fromBlob(b).catch(() => null)))
    const ok = images.map((img, i) => img ? i : -1).filter(i => i >= 0)
    const vecs = new Array(blobs.length).fill(null)
    if (ok.length) {
      const { image_embeds } = await model(await processor(ok.map(i => images[i])))
      image_embeds.tolist().forEach((v, k) => { vecs[ok[k]] = v })
    }
    self.postMessage({ id, vecs })
  } catch (e) {
    _ready = null
    self.postMessage({ id, error: e.message })
  }
}
