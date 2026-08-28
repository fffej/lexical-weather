import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FirehosePostSample,
  FrequencyDictionary,
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

  it('counts occurrences and evicts words that have not been seen recently', () => {
    const sample = new FrequencyDictionary(100)
    sample.observe(['blue', 'sky'], 0)
    sample.observe(['blue'], 50)
    sample.observe(['green'], 60)
    assert.deepEqual([...sample.words].map(([word, entry]) => [word, entry.occurrences]), [
      ['sky', 1], ['blue', 2], ['green', 1],
    ])

    assert.equal(sample.prune(151, true), true)
    assert.deepEqual([...sample.words].map(([word, entry]) => [word, entry.occurrences]), [['green', 1]])
    assert.equal(sample.occurrenceCount, 1)
  })

  it('bounds vocabulary by ejecting the least recently used word', () => {
    const sample = new FrequencyDictionary(1_000, { maxWords: 2 })
    sample.observe(['blue', 'sky'], 0)
    sample.observe(['blue', 'green'], 1)
    assert.deepEqual([...sample.words].map(([word, entry]) => [word, entry.occurrences]), [
      ['blue', 2], ['green', 1],
    ])
    assert.equal(sample.occurrenceCount, 3)
  })

  it('ranks live percentages against one historical reference', () => {
    const sample = new FrequencyDictionary()
    sample.observe(['future', 'future', 'future', 'the'])
    sample.observe(['future', 'novel'])
    const baseline = loadBaseline({ words: [['future', 100, 200], ['novel', 10, 20]] })
    const rows = rankLiveWords(sample, baseline, { minimumOccurrences: 2 })
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

  it('uses an occurrence threshold without retaining post or author evidence', () => {
    const sample = new FrequencyDictionary()
    sample.observe(['launch', 'launch', 'launch'])
    const rows = rankLiveWords(sample, new Map())
    assert.equal(rows[0]?.word, 'launch')
    assert.equal(rows[0]?.count, 3)
  })

  it('captures a bounded occurrence and frequency dictionary for comparisons', () => {
    const sample = new FrequencyDictionary()
    sample.observe(['blue', 'blue', 'sky'])
    const snapshot = makeSnapshot(sample, '2026-08-28T12:00:00.000Z', 1)
    assert.deepEqual(snapshot.words, { blue: { occurrences: 2, frequency: 2 / 3 * 100 } })
    assert.equal(snapshot.capturedAt, '2026-08-28T12:00:00.000Z')
  })

  it('keeps full post bodies only in an independent bounded sample', () => {
    const sample = new FirehosePostSample(1, 1_000)
    sample.upsert({ id: 'one', text: 'blue', tokens: ['blue'] }, 0)
    sample.upsert({ id: 'two', text: 'blue again', tokens: ['blue'] }, 1)
    assert.deepEqual(sample.postsForWord('blue').map((post) => post.id), ['two'])
    assert.equal(sample.remove('two'), true)
    assert.deepEqual(sample.postsForWord('blue'), [])
  })

  it('unwraps v2 stream envelopes', () => {
    const payload = { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq: 4 }
    assert.equal(unwrapJetstreamEvent({ $type: 'message', payload }), payload)
  })
})
