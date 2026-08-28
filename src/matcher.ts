export function parseTopics(value: string): string[] {
  return [...new Set(value.split(',').map((topic) => topic.trim().toLocaleLowerCase()).filter(Boolean))]
}

export function matchingTopics(text: string, topics: readonly string[]): string[] {
  const foldedText = text.toLocaleLowerCase()
  return topics.filter((topic) => foldedText.includes(topic))
}

export function isFeedPostRecord(value: unknown): value is FeedPostRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.$type === 'app.bsky.feed.post' && typeof record.text === 'string'
}

export interface FeedPostRecord {
  $type: 'app.bsky.feed.post'
  text: string
  createdAt?: string
  langs?: string[]
  reply?: {
    parent?: { uri?: string }
    root?: { uri?: string }
  }
  [key: string]: unknown
}
