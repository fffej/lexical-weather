import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostStore } from '../src/store.ts'

describe('PostStore', () => {
  it('atomically stores a post and cursor, then removes the account', async () => {
    const store = new PostStore(':memory:')
    store.apply(42, () => store.putPost({
      uri: 'at://did:plc:test/app.bsky.feed.post/abc',
      did: 'did:plc:test',
      rkey: 'abc',
      cid: 'bafytest',
      seq: 42,
      eventTime: '2026-08-28T10:00:00Z',
      createdAt: '2026-08-28T10:00:00Z',
      text: 'A database post',
      topics: ['database'],
      rawRecord: { $type: 'app.bsky.feed.post', text: 'A database post' },
    }))

    assert.equal(await store.load(), 42)
    assert.equal(store.stats().posts, 1)
    assert.equal(store.list(1)[0]?.text, 'A database post')

    store.apply(43, () => store.deleteAccount('did:plc:test'))
    assert.equal(await store.load(), 43)
    assert.equal(store.stats().posts, 0)
    store.close()
  })
})
