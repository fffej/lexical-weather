import { Jetstream, type Kind, type TypedEvent } from '@bsky/jetstream'
import { isFeedPostRecord, matchingTopics } from './matcher.ts'
import { PostStore } from './store.ts'

const POST_COLLECTION = 'app.bsky.feed.post' as const

export interface CollectorOptions {
  service: string
  apiKey?: string
  topics: string[]
  replay: boolean
  maxEvents: number
  maxMatches: number
  signal?: AbortSignal
  onMatch?: (post: { uri: string; text: string; topics: string[] }) => void
  onError?: (error: Error) => void
}

export interface CollectorResult {
  events: number
  matches: number
}

export async function collect(store: PostStore, options: CollectorOptions): Promise<CollectorResult> {
  const jetstream = new Jetstream({
    service: options.service,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  })
  const streamOptions = {
    collections: [POST_COLLECTION] as const,
    kinds: ['commit', 'account', 'sync'] as Kind[],
    cursor: store,
    signal: options.signal,
    onError: options.onError,
  }
  const events = options.replay
    ? jetstream.replay(streamOptions)
    : jetstream.live(streamOptions)

  let eventCount = 0
  let matchCount = 0

  try {
    for await (const event of events) {
      let matched: { uri: string; text: string; topics: string[] } | undefined
      store.apply(event.seq, () => {
        matched = applyEvent(store, event, options.topics)
      })
      eventCount++
      if (matched) {
        matchCount++
        options.onMatch?.(matched)
      }
      if (
        (options.maxEvents > 0 && eventCount >= options.maxEvents) ||
        (options.maxMatches > 0 && matchCount >= options.maxMatches)
      ) break
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }

  return { events: eventCount, matches: matchCount }
}

export function applyEvent(
  store: PostStore,
  event: TypedEvent,
  topics: readonly string[],
): { uri: string; text: string; topics: string[] } | undefined {
  if (event.kind === 'account') {
    if (!event.account.active && event.account.status === 'deleted') store.deleteAccount(event.did)
    return undefined
  }
  if (event.kind === 'sync') {
    // A sync marker indicates repository divergence: remove cached records and
    // let subsequent events rebuild current state.
    store.deleteAccount(event.did)
    return undefined
  }
  if (event.kind !== 'commit') return undefined

  const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`
  if (event.commit.operation === 'delete') {
    store.deletePost(uri)
    return undefined
  }

  const record = event.commit.record
  if (!isFeedPostRecord(record)) return undefined
  const matches = matchingTopics(record.text, topics)
  if (matches.length === 0) {
    // An update can cause a previously matching post to stop matching.
    store.deletePost(uri)
    return undefined
  }

  store.putPost({
    uri,
    did: event.did,
    rkey: event.commit.rkey,
    cid: event.commit.cid,
    seq: event.seq,
    eventTime: event.time,
    createdAt: record.createdAt,
    text: record.text,
    langs: record.langs,
    topics: matches,
    replyParent: record.reply?.parent?.uri,
    rawRecord: record,
  })
  return { uri, text: record.text, topics: matches }
}
