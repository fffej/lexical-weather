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
  words: Record<string, {
    occurrences: number
    frequency: number
  }>
}

export interface RankedLiveWord {
  word: string
  count: number
  livePercent: number
  referencePercent: number
  lift: number
  multiple: number | null
  score: number
  isUnseen: boolean
}

export interface FrequencyEntry {
  occurrences: number
  lastSeenAt: number
}

export class FrequencyDictionary {
  constructor(maxAgeMs?: number, options?: { maxWords?: number })
  maxAgeMs: number
  maxWords: number
  words: Map<string, FrequencyEntry>
  occurrenceCount: number
  setMaxAge(maxAgeMs: number, now?: number): boolean
  observe(tokens: string[], observedAt?: number): void
  prune(now?: number, force?: boolean): boolean
  clear(): void
}

export class FirehosePostSample {
  constructor(limit?: number, maxAgeMs?: number)
  limit: number
  maxAgeMs: number
  posts: Map<string, WindowPost & { observedAt: number }>
  setMaxAge(maxAgeMs: number, now?: number): boolean
  upsert(post: WindowPost, observedAt?: number): void
  remove(id: string): boolean
  prune(now?: number): boolean
  postsForWord(word: string): WindowPost[]
  clear(): void
}

export const DEFAULT_STOP_WORDS: Set<string>
export const STOP_WORDS: Set<string>
export function addStopWord(word: string): boolean
export function removeStopWord(word: string): boolean
export function tokenize(text: string): string[]
export function isCandidateWord(word: string): boolean
export function loadBaseline(payload: BaselinePayload): Map<string, number>
export function percentage(count: number, occurrenceCount: number): number
export function makeSnapshot(sample: FrequencyDictionary, capturedAt?: string, maximumWords?: number): FrequencySnapshot
export function rankLiveWords(
  sample: FrequencyDictionary,
  baseline: Map<string, number>,
  options?: {
    limit?: number
    minimumOccurrences?: number
    snapshot?: FrequencySnapshot | null
  },
): RankedLiveWord[]
export function postUri(event: { did: string; rkey: string }): string
export function unwrapJetstreamEvent(message: unknown): any
