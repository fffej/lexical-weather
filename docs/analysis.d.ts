export interface WindowPost {
  id: string
  did?: string
  tokens: string[]
  [key: string]: unknown
}

export interface BaselinePayload {
  words: Array<[string, number] | [string, number, number]>
}

export interface FrequencySnapshot {
  id: string
  capturedAt: string
  postCount: number
  tokenCount: number
  counts: Record<string, number>
}

export interface RankedLiveWord {
  word: string
  count: number
  posts: number
  authors: number
  livePercent: number
  referencePercent: number
  lift: number
  multiple: number | null
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

export const DEFAULT_STOP_WORDS: Set<string>
export const STOP_WORDS: Set<string>
export function addStopWord(word: string): boolean
export function removeStopWord(word: string): boolean
export function tokenize(text: string): string[]
export function isCandidateWord(word: string): boolean
export function loadBaseline(payload: BaselinePayload): Map<string, number>
export function percentage(count: number, tokenCount: number): number
export function makeSnapshot(window: SlidingPostWindow, capturedAt?: string): FrequencySnapshot
export function rankLiveWords(
  window: SlidingPostWindow,
  baseline: Map<string, number>,
  options?: {
    limit?: number
    minimumPosts?: number
    minimumAuthors?: number
    snapshot?: FrequencySnapshot | null
  },
): RankedLiveWord[]
export function postUri(event: { did: string; rkey: string }): string
export function unwrapJetstreamEvent(message: unknown): any
