import { resolve } from 'node:path'
import { collect } from './collector.ts'
import { parseTopics } from './matcher.ts'
import { PostStore } from './store.ts'

function numericOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  const raw = index >= 0 ? process.argv[index + 1] : undefined
  const value = Number(raw ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function databasePath(): string {
  const configured = process.env.DATABASE_PATH ?? './data/posts.sqlite'
  return configured === ':memory:' ? configured : resolve(configured)
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'collect'
  const store = new PostStore(databasePath())
  try {
    if (command === 'list') {
      const rows = store.list(numericOption('--limit', 20))
      if (process.argv.includes('--json')) {
        for (const row of rows) console.log(JSON.stringify(row))
      } else if (rows.length === 0) {
        console.log('No matching posts collected yet.')
      } else {
        for (const row of rows) {
          console.log(`${row.event_time}  ${row.url}`)
          console.log(`  ${row.text.replaceAll('\n', '\n  ')}`)
        }
      }
      return
    }
    if (command === 'stats') {
      console.log(JSON.stringify(store.stats(), null, 2))
      return
    }
    if (command !== 'collect') throw new Error(`Unknown command: ${command}`)

    const topics = parseTopics(process.env.TOPICS ?? 'database')
    if (topics.length === 0) throw new Error('TOPICS must contain at least one topic')
    const replay = process.argv.includes('--replay')
    const apiKey = process.env.JETSTREAM_API_KEY || undefined
    if (replay && !apiKey) {
      throw new Error('--replay requires JETSTREAM_API_KEY (create one at https://bsky.network/account)')
    }

    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    console.log(`${replay ? 'Replaying and following' : 'Following live'} posts for: ${topics.join(', ')}`)
    console.log(`Database: ${databasePath()}`)

    const result = await collect(store, {
      service: process.env.JETSTREAM_SERVICE ?? 'https://jetstream.us-east.bsky.network',
      apiKey,
      topics,
      replay,
      maxEvents: numericOption('--max-events', Number(process.env.MAX_EVENTS ?? 0)),
      maxMatches: numericOption('--max-matches', Number(process.env.MAX_MATCHES ?? 0)),
      signal: controller.signal,
      onError: (error) => console.error(`Jetstream warning: ${error.message}`),
      onMatch: (post) => {
        console.log(`\n${post.uri}  [${post.topics.join(', ')}]`)
        console.log(post.text)
      },
    })
    console.log(`\nStopped after ${result.events} events; stored ${result.matches} matching updates.`)
  } finally {
    store.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
