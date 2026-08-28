const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

let extractorPromise

function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_URL).then(async ({ env, pipeline }) => {
      env.allowLocalModels = false
      const extractor = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (progress) => {
          self.postMessage({
            type: 'status',
            status: 'loading',
            file: progress.file,
            progress: progress.progress,
          })
        },
      })
      self.postMessage({ type: 'status', status: 'ready' })
      return extractor
    })
  }
  return extractorPromise
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'embed' || typeof data.text !== 'string') return
  try {
    const extractor = await loadExtractor()
    const output = await extractor(data.text, { pooling: 'mean', normalize: true })
    const vector = Float32Array.from(output.data)
    self.postMessage({ type: 'result', id: data.id, buffer: vector.buffer }, [vector.buffer])
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
