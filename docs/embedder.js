export class WorkerEmbedder {
  constructor(options = {}) {
    const workerFactory = options.workerFactory
      ?? (() => new Worker(new URL('./embedding-worker.js', import.meta.url), { type: 'module' }))
    this.worker = workerFactory()
    this.onStatus = options.onStatus ?? (() => {})
    this.pending = new Map()
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
      this.worker.postMessage({ type: 'embed', id, text })
    })
  }

  terminate() {
    this.#rejectAll(new Error('Embedding worker terminated'))
    this.worker.terminate()
  }

  #handleMessage(message) {
    if (message?.type === 'status') {
      this.onStatus(message)
      return
    }
    const request = this.pending.get(message?.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.type === 'result' && message.buffer instanceof ArrayBuffer) {
      request.resolve(new Float32Array(message.buffer))
    } else {
      request.reject(new Error(message?.error || 'Embedding worker returned an invalid response'))
    }
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}
