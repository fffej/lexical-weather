import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SlidingPostWindow,
  loadBaseline,
  rankLiveWords,
  tokenize,
  unwrapJetstreamEvent,
} from '../docs/analysis.js'

describe('dashboard analysis', () => {
  it('tokenizes Unicode text, hashtags, mentions, and contractions consistently', () => {
    assert.deepEqual(
      tokenize("Hello, #World — we're testing @Bluesky! https://www.example.com/a-word, example.org 7"),
      ['hello', 'world', "we're", 'testing', 'bluesky'],
    )
  })

  it('reverses counts when posts update and leave the sliding window', () => {
    const window = new SlidingPostWindow(2)
    window.upsert({ id: 'one', tokens: ['blue', 'sky'] })
    window.upsert({ id: 'two', tokens: ['blue'] })
    window.upsert({ id: 'one', tokens: ['green'] })
    assert.deepEqual([...window.counts], [['blue', 1], ['green', 1]])

    window.upsert({ id: 'three', tokens: ['new'] })
    assert.deepEqual([...window.counts], [['green', 1], ['new', 1]])
    assert.equal(window.tokenCount, 2)
  })

  it('ranks repeated words above one-offs and compares both periods', () => {
    const window = new SlidingPostWindow(10)
    window.upsert({ id: 'one', tokens: ['future', 'future', 'future', 'the'] })
    window.upsert({ id: 'two', tokens: ['future', 'novel'] })
    const baseline = loadBaseline({ words: [['future', 100, 200], ['novel', 10, 20]] })
    const rows = rankLiveWords(window, baseline, { minimumCount: 2 })
    assert.equal(rows[0]?.word, 'future')
    assert.ok(rows[0]?.earlyLift > 0)
    assert.ok(rows[0]?.lateLift > 0)
    assert.equal(rows.some((row) => row.word === 'the'), false)
  })

  it('unwraps v2 stream envelopes', () => {
    const payload = { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq: 4 }
    assert.equal(unwrapJetstreamEvent({ $type: 'message', payload }), payload)
  })
})
