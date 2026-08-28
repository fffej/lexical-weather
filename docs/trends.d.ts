export interface TrendMessage {
  id: string
  text: string
  timestampMs: number
  sourceId?: string
}

export interface FeatureStats {
  fast: number
  medium: number
  slow: number
  lastUpdatedMs: number
}

export interface ScoredFeature {
  feature: string
  score: number
  fastActivity: number
}

export interface LexicalResult {
  message: TrendMessage
  normalized: string
  scoredFeatures: ScoredFeature[]
  candidate: boolean
  duplicate: boolean
}

export interface TopicSample {
  text: string
  timestampMs: number
  similarityToCentroid: number
  sourceId?: string
}

export interface Topic {
  id: number
  centroid: Float32Array
  messageCount: number
  fastCount: number
  mediumCount: number
  slowCount: number
  lastCountUpdateMs: number
  createdAtMs: number
  lastSeenMs: number
  coherence: number
  samples: TopicSample[]
  sourceIds: Map<string, number>
  sourceContributions: Map<string, number[]>
  hasSourceIdentity: boolean
}

export type TopicState = 'EMERGING' | 'ACTIVE' | 'FADING'

export interface RankedTopic {
  topicId: number
  score: number
  burst: number
  volume: number
  coherence: number
  novelty: number
  diversity?: number
  state: TopicState
  messageCount: number
  uniqueSources?: number
  ageMs: number
  samples: string[]
}

export const TrendDetectionDefaults: Readonly<Record<string, number>>
export function decay(value: number, elapsedMs: number, halfLifeMs: number): number
export function normalizeText(text: string): string
export function extractLexicalFeatures(normalized: string, stopWords?: Set<string>): string[]
export function normalizeEmbedding(vector: Float32Array | Iterable<number>): Float32Array
export function dot(left: Float32Array, right: Float32Array): number
export function topicBurst(topic: Topic, now: number, options?: Record<string, any>): number

export class LexicalNoveltyDetector {
  constructor(options?: Record<string, number>)
  options: Record<string, number>
  features: Map<string, FeatureStats>
  recentDuplicates: Map<string, number>
  diagnostics: Record<string, number>
  process(message: TrendMessage): LexicalResult
  lexicalBurst(stats: FeatureStats, now: number): number
  readStats(stats: FeatureStats, now: number): FeatureStats
  maintain(now?: number): void
  clear(): void
  snapshotDiagnostics(): Record<string, number>
}

export class OnlineTopicClusterer {
  constructor(options?: Record<string, any>)
  options: Record<string, any>
  topics: Map<number, Topic>
  diagnostics: Record<string, number>
  observe(message: TrendMessage, vector: Float32Array | Iterable<number>): {
    topic: Topic
    created: boolean
    suppressed: boolean
    similarity?: number
  }
  findMatchingTopic(embedding: Float32Array): { topic: Topic; similarity: number } | undefined
  scoreTopic(topic: Topic, now?: number): Record<string, any>
  rank(now?: number, limit?: number): RankedTopic[]
  classify(topic: Topic, now?: number): TopicState
  maintain(now?: number): void
  clear(): void
  snapshotDiagnostics(): Record<string, number>
}

export class StreamingTrendDetector {
  constructor(
    embed: (normalized: string) => Promise<Float32Array | Iterable<number>> | Float32Array | Iterable<number>,
    options?: Record<string, any>,
  )
  lexical: LexicalNoveltyDetector
  semantic: OnlineTopicClusterer
  process(message: TrendMessage): Promise<Record<string, any>>
  rank(now?: number, limit?: number): RankedTopic[]
  maintain(now?: number): void
  clear(): void
  snapshotDiagnostics(): Record<string, number>
}
