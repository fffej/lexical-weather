export type EntityType = 'person' | 'place' | 'organization' | 'thing'

export interface ExtractedEntity {
  key: string
  label: string
  type: EntityType
}

export interface WindowPost {
  id: string
  did?: string
  entityKeys: string[]
  [key: string]: unknown
}

export interface EntityEntry extends ExtractedEntity {
  id: number
  postCount: number
  mentionCount: number
  lastSeenAt: number
  forms: Map<string, number>
}

export interface RankedEntity extends ExtractedEntity {
  postCount: number
  mentionCount: number
  postPercent: number
  lastSeenAt: number
}

export class EntityDictionary {
  constructor(maxAgeMs?: number, options?: { maxEntities?: number })
  maxAgeMs: number
  maxEntities: number
  entities: Map<string, EntityEntry>
  postCount: number
  mentionCount: number
  setMaxAge(maxAgeMs: number, now?: number): boolean
  observe(items: ExtractedEntity[], observedAt?: number, postId?: string | null): boolean
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
  postsForEntity(key: string): WindowPost[]
  clear(): void
}

export const DEFAULT_STOP_WORDS: Set<string>
export const STOP_WORDS: Set<string>
export function normalizeEntity(value: string): string
export function addStopWord(value: string): boolean
export function removeStopWord(value: string): boolean
export function isCandidateEntity(value: string): boolean
export function extractEntities(text: string, parser?: (text: string) => any): ExtractedEntity[]
export function rankEntities(
  sample: EntityDictionary,
  options?: { limit?: number; minimumPosts?: number; type?: EntityType | null },
): RankedEntity[]
export function countEntityTypes(sample: EntityDictionary, minimumPosts?: number): Record<EntityType, number>
export function postUri(event: { did: string; rkey: string }): string
export function unwrapJetstreamEvent(message: unknown): any
