const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

let extractorPromise
let backend = 'loading'
let webgpuDisabled = false

function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_URL).then(async ({ env, pipeline }) => {
      env.allowLocalModels = false
      const progress_callback = (progress) => self.postMessage({
        type: 'status', status: 'loading', file: progress.file, progress: progress.progress,
      })
      if (self.navigator?.gpu && !webgpuDisabled) {
        try {
          const extractor = await pipeline('feature-extraction', MODEL_ID, {
            device: 'webgpu', dtype: 'fp16', progress_callback,
          })
          backend = 'webgpu'
          self.postMessage({ type: 'status', status: 'ready', progress: 'webgpu' })
          return extractor
        } catch (error) {
          // WebGPU support varies by adapter and browser. CPU/WASM remains a safe path.
          webgpuDisabled = true
          self.postMessage({ type: 'status', status: 'fallback', error: String(error) })
        }
      }
      const extractor = await pipeline('feature-extraction', MODEL_ID, {
        device: 'wasm', dtype: 'q8', progress_callback,
      })
      backend = 'wasm'
      self.postMessage({ type: 'status', status: 'ready', progress: 'wasm' })
      return extractor
    })
  }
  return extractorPromise
}

let inferenceQueue = Promise.resolve()

async function embedBatch(items) {
  const valid = items.filter((item) => Number.isSafeInteger(item?.id) && typeof item?.text === 'string')
  if (!valid.length) return
  try {
    let extractor = await loadExtractor()
    const texts = valid.map(({ text }) => text)
    let output
    try {
      output = await extractor(texts, { pooling: 'mean', normalize: true })
    } catch (error) {
      // Some adapters initialise successfully but reject an operator on first use.
      if (backend !== 'webgpu') throw error
      webgpuDisabled = true
      extractorPromise = undefined
      self.postMessage({ type: 'status', status: 'fallback', error: String(error) })
      extractor = await loadExtractor()
      output = await extractor(texts, { pooling: 'mean', normalize: true })
    }
    const vector = Float32Array.from(output.data)
    const dimensions = vector.length / valid.length
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error('Invalid embedding dimensions')
    self.postMessage({
      type: 'batch-result', ids: valid.map(({ id }) => id), dimensions, buffer: vector.buffer,
    }, [vector.buffer])
  } catch (error) {
    self.postMessage({
      type: 'batch-error',
      ids: valid.map(({ id }) => id),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

self.addEventListener('message', ({ data }) => {
  if (data?.type === 'embed-batch' && Array.isArray(data.items)) {
    inferenceQueue = inferenceQueue.then(() => embedBatch(data.items))
  } else if (data?.type === 'embed' && typeof data.text === 'string') {
    inferenceQueue = inferenceQueue.then(() => embedBatch([data]))
  }
})
