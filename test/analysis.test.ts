import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SlidingPostWindow,
  STOP_WORDS,
  addStopWord,
  isCandidateWord,
  loadBaseline,
  makeSnapshot,
  rankLiveWords,
  removeStopWord,
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

  it('ranks live percentages against one historical reference', () => {
    const window = new SlidingPostWindow(10)
    window.upsert({ id: 'one', did: 'did:one', tokens: ['future', 'future', 'future', 'the'] })
    window.upsert({ id: 'two', did: 'did:two', tokens: ['future', 'novel'] })
    const baseline = loadBaseline({ words: [['future', 100, 200], ['novel', 10, 20]] })
    const rows = rankLiveWords(window, baseline, { minimumPosts: 2 })
    assert.equal(rows[0]?.word, 'future')
    assert.equal(baseline.get('future'), 150)
    assert.ok(rows[0]?.livePercent > rows[0]?.referencePercent)
    assert.ok(rows[0]?.lift > 0)
    assert.equal(rows.some((row) => row.word === 'the'), false)
  })

  it('filters short fragments, filler, profanity, and repeated-letter noise', () => {
    assert.equal(isCandidateWord('en'), false)
    assert.equal(isCandidateWord('maybe'), false)
    assert.equal(isCandidateWord('shit'), false)
    assert.equal(isCandidateWord('today'), false)
    assert.equal(isCandidateWord('loooool'), false)
    assert.equal(isCandidateWord('database'), true)
  })

  it('adds and removes personal exclusions without removing built-in stop words', () => {
    assert.equal(addStopWord('Database'), true)
    assert.equal(STOP_WORDS.has('database'), true)
    assert.equal(isCandidateWord('database'), false)
    assert.equal(removeStopWord('database'), true)
    assert.equal(isCandidateWord('database'), true)
    assert.equal(removeStopWord('maybe'), false)
    assert.equal(STOP_WORDS.has('maybe'), true)
  })

  it('requires evidence across posts and authors rather than repeated mentions', () => {
    const window = new SlidingPostWindow(10)
    window.upsert({ id: 'one', did: 'did:one', tokens: ['launch', 'launch', 'launch'] })
    window.upsert({ id: 'two', did: 'did:one', tokens: ['launch'] })
    window.upsert({ id: 'three', did: 'did:two', tokens: ['release'] })
    assert.deepEqual(rankLiveWords(window, new Map()), [])
  })

  it('captures exact word frequencies for later comparisons', () => {
    const window = new SlidingPostWindow(10)
    window.upsert({ id: 'one', tokens: ['blue', 'blue', 'sky'] })
    const snapshot = makeSnapshot(window, '2026-08-28T12:00:00.000Z')
    assert.equal(snapshot.tokenCount, 3)
    assert.equal(snapshot.counts.blue, 2)
    assert.equal(snapshot.capturedAt, '2026-08-28T12:00:00.000Z')
  })

  it('unwraps v2 stream envelopes', () => {
    const payload = { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq: 4 }
    assert.equal(unwrapJetstreamEvent({ $type: 'message', payload }), payload)
  })
})
