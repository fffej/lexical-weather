export class WorkerEmbedder {
  constructor(options = {}) {
    const workerFactory = options.workerFactory
      ?? (() => new Worker(new URL('./embedding-worker.js', import.meta.url), { type: 'module' }))
    this.worker = workerFactory()
    this.onStatus = options.onStatus ?? (() => {})
    this.pending = new Map()
    this.queued = []
    this.batchTimer = null
    this.batchSize = options.batchSize ?? 16
    this.batchDelayMs = options.batchDelayMs ?? 40
    this.nextRequestId = 1
    this.worker.addEventListener('message', ({ data }) => this.#handleMessage(data))
    this.worker.addEventListener('error', (event) => {
      this.#rejectAll(new Error(event.message || 'Embedding worker failed'))
    })
  }

  embed(text) {
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.queued.push({ id, text })
      if (this.queued.length >= this.batchSize) this.#flush()
      else if (!this.batchTimer) this.batchTimer = setTimeout(() => this.#flush(), this.batchDelayMs)
    })
  }

  terminate() {
    clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.queued.length = 0
    this.#rejectAll(new Error('Embedding worker terminated'))
    this.worker.terminate()
  }

  #handleMessage(message) {
    if (message?.type === 'status') {
      this.onStatus(message)
      return
    }
    if (message?.type === 'batch-result' && message.buffer instanceof ArrayBuffer) {
      const ids = Array.isArray(message.ids) ? message.ids : []
      const dimensions = Number(message.dimensions)
      const values = new Float32Array(message.buffer)
      if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || values.length !== ids.length * dimensions) {
        this.#rejectIds(ids, new Error('Embedding worker returned an invalid batch'))
        return
      }
      ids.forEach((id, index) => {
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        request.resolve(values.slice(index * dimensions, (index + 1) * dimensions))
      })
      return
    }
    if (message?.type === 'batch-error') {
      this.#rejectIds(message.ids ?? [], new Error(message.error || 'Embedding batch failed'))
      return
    }
    const request = this.pending.get(message?.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.type === 'result' && message.buffer instanceof ArrayBuffer) {
      request.resolve(new Float32Array(message.buffer))
    } else request.reject(new Error(message?.error || 'Embedding worker returned an invalid response'))
  }

  #flush() {
    clearTimeout(this.batchTimer)
    this.batchTimer = null
    if (!this.queued.length) return
    const items = this.queued.splice(0, this.batchSize)
    this.worker.postMessage({ type: 'embed-batch', items })
    if (this.queued.length) this.batchTimer = setTimeout(() => this.#flush(), 0)
  }

  #rejectIds(ids, error) {
    for (const id of ids) {
      const request = this.pending.get(id)
      if (!request) continue
      request.reject(error)
      this.pending.delete(id)
    }
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}
