import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { CursorStore } from '@bsky/jetstream'

export interface StoredPost {
  uri: string
  url: string
  did: string
  rkey: string
  cid: string
  seq: number
  event_time: string
  created_at: string | null
  text: string
  langs: string
  topics: string
  reply_parent: string | null
  raw_record: string
}

export interface PostInput {
  uri: string
  did: string
  rkey: string
  cid: string
  seq: number
  eventTime: string
  createdAt?: string
  text: string
  langs?: string[]
  topics: string[]
  replyParent?: string
  rawRecord: unknown
}

export class PostStore implements CursorStore {
  readonly db: DatabaseSync
  readonly #putPost: StatementSync
  readonly #deletePost: StatementSync
  readonly #deleteAccount: StatementSync
  readonly #getCursor: StatementSync
  readonly #setCursor: StatementSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_time TEXT NOT NULL,
        created_at TEXT,
        text TEXT NOT NULL,
        langs TEXT NOT NULL,
        topics TEXT NOT NULL,
        reply_parent TEXT,
        raw_record TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS posts_seq_idx ON posts(seq DESC);
      CREATE INDEX IF NOT EXISTS posts_did_idx ON posts(did);
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    this.#putPost = this.db.prepare(`
      INSERT INTO posts (
        uri, did, rkey, cid, seq, event_time, created_at, text,
        langs, topics, reply_parent, raw_record
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        cid = excluded.cid,
        seq = excluded.seq,
        event_time = excluded.event_time,
        created_at = excluded.created_at,
        text = excluded.text,
        langs = excluded.langs,
        topics = excluded.topics,
        reply_parent = excluded.reply_parent,
        raw_record = excluded.raw_record
    `)
    this.#deletePost = this.db.prepare('DELETE FROM posts WHERE uri = ?')
    this.#deleteAccount = this.db.prepare('DELETE FROM posts WHERE did = ?')
    this.#getCursor = this.db.prepare("SELECT value FROM state WHERE key = 'cursor'")
    this.#setCursor = this.db.prepare(`
      INSERT INTO state(key, value) VALUES ('cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
  }

  async load(): Promise<number | undefined> {
    const row = this.#getCursor.get() as { value: string } | undefined
    if (!row) return undefined
    const cursor = Number(row.value)
    return Number.isSafeInteger(cursor) ? cursor : undefined
  }

  async save(seq: number): Promise<void> {
    this.#setCursor.run(String(seq))
  }

  apply(seq: number, change: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      change()
      this.#setCursor.run(String(seq))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  putPost(post: PostInput): void {
    this.#putPost.run(
      post.uri,
      post.did,
      post.rkey,
      post.cid,
      post.seq,
      post.eventTime,
      post.createdAt ?? null,
      post.text,
      JSON.stringify(post.langs ?? []),
      JSON.stringify(post.topics),
      post.replyParent ?? null,
      JSON.stringify(post.rawRecord),
    )
  }

  deletePost(uri: string): void {
    this.#deletePost.run(uri)
  }

  deleteAccount(did: string): void {
    this.#deleteAccount.run(did)
  }

  list(limit: number): StoredPost[] {
    return this.db.prepare(`
      SELECT
        uri,
        'https://bsky.app/profile/' || did || '/post/' || rkey AS url,
        did, rkey, cid, seq, event_time, created_at, text, langs, topics,
        reply_parent, raw_record
      FROM posts
      ORDER BY seq DESC
      LIMIT ?
    `).all(limit) as unknown as StoredPost[]
  }

  stats(): { posts: number; cursor?: number; firstSeq?: number; lastSeq?: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS posts, MIN(seq) AS first_seq, MAX(seq) AS last_seq
      FROM posts
    `).get() as { posts: number; first_seq: number | null; last_seq: number | null }
    const cursorRow = this.#getCursor.get() as { value: string } | undefined
    return {
      posts: row.posts,
      cursor: cursorRow ? Number(cursorRow.value) : undefined,
      firstSeq: row.first_seq ?? undefined,
      lastSeq: row.last_seq ?? undefined,
    }
  }

  close(): void {
    this.db.close()
  }
}
