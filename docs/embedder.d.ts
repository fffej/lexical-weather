export interface EmbeddingWorkerStatus {
  type: 'status'
  status: 'loading' | 'ready'
  file?: string
  progress?: number
}

export interface WorkerLike {
  addEventListener(type: string, listener: (event: any) => void): void
  postMessage(message: unknown): void
  terminate(): void
}

export class WorkerEmbedder {
  constructor(options?: {
    workerFactory?: () => WorkerLike
    onStatus?: (status: EmbeddingWorkerStatus) => void
  })
  worker: WorkerLike
  pending: Map<number, unknown>
  embed(text: string): Promise<Float32Array>
  terminate(): void
}
