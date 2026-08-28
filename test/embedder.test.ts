import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorkerEmbedder } from '../docs/embedder.js'

class FakeWorker {
  listeners = new Map<string, Array<(event: any) => void>>()
  sent: any[] = []
  terminated = false

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

describe('embedding worker client', () => {
  it('matches transferred vectors to concurrent requests', async () => {
    const worker = new FakeWorker()
    const embedder = new WorkerEmbedder({ workerFactory: () => worker })
    const first = embedder.embed('first')
    const second = embedder.embed('second')
    assert.deepEqual(worker.sent, [
      { type: 'embed', id: 1, text: 'first' },
      { type: 'embed', id: 2, text: 'second' },
    ])
    worker.emit('message', { type: 'result', id: 2, buffer: new Float32Array([0, 1]).buffer })
    worker.emit('message', { type: 'result', id: 1, buffer: new Float32Array([1, 0]).buffer })
    assert.deepEqual([...await first], [1, 0])
    assert.deepEqual([...await second], [0, 1])
  })

  it('forwards load status and rejects worker errors', async () => {
    const worker = new FakeWorker()
    const statuses: unknown[] = []
    const embedder = new WorkerEmbedder({
      workerFactory: () => worker,
      onStatus: (status) => statuses.push(status),
    })
    worker.emit('message', { type: 'status', status: 'loading', progress: 25 })
    assert.deepEqual(statuses, [{ type: 'status', status: 'loading', progress: 25 }])
    const pending = embedder.embed('broken')
    worker.emit('message', { type: 'error', id: 1, error: 'model unavailable' })
    await assert.rejects(pending, /model unavailable/)
  })

  it('rejects pending work when terminated', async () => {
    const worker = new FakeWorker()
    const embedder = new WorkerEmbedder({ workerFactory: () => worker })
    const pending = embedder.embed('queued')
    embedder.terminate()
    await assert.rejects(pending, /terminated/)
    assert.equal(worker.terminated, true)
  })
})
