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

export const TrendDetectionDefaults: Readonly<Record<string, number>>
export function decay(value: number, elapsedMs: number, halfLifeMs: number): number
export function normalizeText(text: string): string
export function extractLexicalFeatures(normalized: string, stopWords?: Set<string>): string[]

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
