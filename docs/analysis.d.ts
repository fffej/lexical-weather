export interface WindowPost {
  id: string
  tokens: string[]
  [key: string]: unknown
}

export interface BaselineValues {
  early: number
  late: number
}

export interface BaselinePayload {
  words: Array<[string, number, number]>
  historicalVocabulary?: string[]
}

export interface RankedLiveWord extends BaselineValues {
  word: string
  count: number
  livePpm: number
  earlyPpm: number
  latePpm: number
  earlyLift: number
  lateLift: number
  historicalLift: number
  score: number
  isUnseen: boolean
}

export class SlidingPostWindow {
  constructor(limit?: number)
  limit: number
  posts: WindowPost[]
  byId: Map<string, WindowPost>
  counts: Map<string, number>
  tokenCount: number
  setLimit(limit: number): void
  upsert(post: WindowPost): void
  remove(id: string): boolean
  clear(): void
}

export const STOP_WORDS: Set<string>
export function tokenize(text: string): string[]
export function loadBaseline(payload: BaselinePayload): Map<string, BaselineValues>
export function logLift(livePpm: number, baselinePpm: number): number
export function rankLiveWords(
  window: SlidingPostWindow,
  baseline: Map<string, BaselineValues>,
  options?: {
    minimumCount?: number
    includeStopWords?: boolean
    query?: string
    limit?: number
    comparison?: 'early' | 'late'
  },
): RankedLiveWord[]
export function rankHistoricalWords(
  baseline: Map<string, BaselineValues>,
  direction?: 'rising' | 'fading',
  limit?: number,
  vocabulary?: Set<string> | null,
): Array<{ word: string; early: number; late: number; lift: number; score: number }>
export function postUri(event: { did: string; rkey: string }): string
export function unwrapJetstreamEvent(message: unknown): any
