import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isFeedPostRecord, matchingTopics, parseTopics } from '../src/matcher.ts'

describe('topic matching', () => {
  it('parses, normalizes, and deduplicates topics', () => {
    assert.deepEqual(parseTopics(' Database,postgres, database, '), ['database', 'postgres'])
  })

  it('matches case-insensitively and includes plurals', () => {
    assert.deepEqual(matchingTopics('DATABASES are useful', ['database', 'postgres']), ['database'])
  })

  it('recognizes feed post records', () => {
    assert.equal(isFeedPostRecord({ $type: 'app.bsky.feed.post', text: 'hello' }), true)
    assert.equal(isFeedPostRecord({ $type: 'app.bsky.feed.like', text: 'hello' }), false)
  })
})
