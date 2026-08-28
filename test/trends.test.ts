import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LexicalNoveltyDetector,
  OnlineTopicClusterer,
  StreamingTrendDetector,
  decay,
  dot,
  extractLexicalFeatures,
  normalizeText,
} from '../docs/trends.js'

describe('lexical novelty detection', () => {
  it('normalizes social text and extracts useful unique unigrams and bigrams', () => {
    const normalized = normalizeText(' Massive FIRE near Heathrow!! https://example.com @Some.User ')
    assert.equal(normalized, 'massive fire near heathrow <url> <mention>')
    assert.deepEqual(extractLexicalFeatures(normalized), [
      'massive', 'fire', 'near', 'heathrow',
      'massive fire', 'fire near', 'near heathrow',
    ])
  })

  it('decays values by their configured half-life', () => {
    assert.equal(decay(8, 60_000, 60_000), 4)
    assert.equal(decay(8, 0, 60_000), 8)
  })

  it('selects a sudden repeated phrase without selecting one-off anomalies', () => {
    const detector = new LexicalNoveltyDetector()
    const texts = [
      'reports of smoke by heathrow',
      'smoke seen near heathrow',
      'more smoke around heathrow airport',
    ]
    const results = texts.map((text, index) => detector.process({
      id: String(index), text, timestampMs: index * 1_000, sourceId: `source-${index}`,
    }))
    assert.equal(results[0]?.candidate, false)
    assert.equal(results[1]?.candidate, false)
    assert.equal(results[2]?.candidate, true)

    const isolated = detector.process({
      id: 'odd', text: 'unrepeatable quokka zeppelin', timestampMs: 4_000,
    })
    assert.equal(isolated.candidate, false)
  })

  it('does not flag a stable high-volume feature after its slow baseline matures', () => {
    const detector = new LexicalNoveltyDetector()
    let result
    for (let minute = 0; minute < 12 * 60; minute += 1) {
      result = detector.process({
        id: String(minute), text: `database release note ${minute}`,
        timestampMs: minute * 60_000,
      })
    }
    assert.equal(result?.candidate, false)
    const database = detector.features.get('database')
    assert.ok(database)
    assert.ok(detector.lexicalBurst(database, 12 * 60 * 60_000) < 3)
  })

  it('suppresses exact duplicates within the TTL', () => {
    const detector = new LexicalNoveltyDetector({ duplicateTtlMs: 100 })
    const first = detector.process({ id: '1', text: 'same post', timestampMs: 0 })
    const duplicate = detector.process({ id: '2', text: 'SAME POST!', timestampMs: 50 })
    const expired = detector.process({ id: '3', text: 'same post', timestampMs: 151 })
    assert.equal(first.duplicate, false)
    assert.equal(duplicate.duplicate, true)
    assert.equal(expired.duplicate, false)
    assert.equal(detector.snapshotDiagnostics().duplicatesSuppressed, 1)
  })

  it('bounds and prunes lexical state', () => {
    const detector = new LexicalNoveltyDetector({
      maxFeatures: 3,
      featurePruneThreshold: 0.01,
      lexicalFastHalfLifeMs: 1,
      lexicalMediumHalfLifeMs: 1,
      lexicalSlowHalfLifeMs: 1,
    })
    detector.process({ id: '1', text: 'alpha beta gamma', timestampMs: 0 })
    assert.equal(detector.features.size, 3)
    detector.maintain(10)
    assert.equal(detector.features.size, 0)
    assert.ok(detector.snapshotDiagnostics().featuresPruned >= 3)
  })
})

describe('online semantic topics', () => {
  it('normalizes vectors and converges paraphrases into one topic', () => {
    const topics = new OnlineTopicClusterer()
    const messages = [
      'huge plume of smoke near Heathrow',
      'fire engines heading to terminal five',
      'something is burning beside LHR airport',
    ]
    const vectors = [
      [1, 0, 0],
      [0.98, 0.15, 0],
      [0.96, 0.2, 0],
    ]
    for (let index = 0; index < messages.length; index += 1) {
      topics.observe({
        id: String(index), text: messages[index]!, timestampMs: index * 1_000,
        sourceId: `did:${index}`,
      }, vectors[index]!)
    }
    assert.equal(topics.topics.size, 1)
    const topic = [...topics.topics.values()][0]!
    assert.equal(topic.messageCount, 3)
    assert.ok(Math.abs(dot(topic.centroid, topic.centroid) - 1) < 1e-6)
    assert.ok(topic.coherence > 0.95)
  })

  it('creates separate topics below the similarity threshold', () => {
    const topics = new OnlineTopicClusterer()
    topics.observe({ id: '1', text: 'airport fire', timestampMs: 0 }, [1, 0])
    topics.observe({ id: '2', text: 'football result', timestampMs: 1 }, [0, 1])
    assert.equal(topics.topics.size, 2)
  })

  it('ranks only topics with enough messages and source diversity', () => {
    const topics = new OnlineTopicClusterer()
    for (let index = 0; index < 3; index += 1) {
      topics.observe({
        id: String(index), text: `airport report ${index}`, timestampMs: index,
        sourceId: `did:${index % 2}`,
      }, [1, 0])
    }
    const [ranked] = topics.rank(3)
    assert.equal(ranked?.state, 'EMERGING')
    assert.equal(ranked?.messageCount, 3)
    assert.equal(ranked?.uniqueSources, 2)
    assert.ok((ranked?.score ?? 0) > 0)
    assert.ok((ranked?.burst ?? 0) > 0)
    assert.equal(ranked?.samples.length, 3)
  })

  it('throttles one source and keeps representative samples bounded', () => {
    const topics = new OnlineTopicClusterer({ maxTopicSamples: 2 })
    let last
    for (let index = 0; index < 6; index += 1) {
      last = topics.observe({
        id: String(index), text: `variant ${index}`, timestampMs: index * 1_000,
        sourceId: 'did:spam',
      }, [1, 0])
    }
    const topic = [...topics.topics.values()][0]!
    assert.equal(topic.messageCount, 3)
    assert.equal(topic.samples.length, 2)
    assert.equal(last?.suppressed, true)
    assert.equal(topics.snapshotDiagnostics().sourceContributionsSuppressed, 3)
    assert.equal(topics.rank(6_000).length, 0)
  })

  it('moves a stopped topic to fading and eventually expires it', () => {
    const topics = new OnlineTopicClusterer({
      topicFastHalfLifeMs: 10,
      topicMediumHalfLifeMs: 100,
      topicSlowHalfLifeMs: 1_000,
      topicStaleTtlMs: 100,
      featurePruneThreshold: 0.01,
    })
    for (let index = 0; index < 3; index += 1) {
      topics.observe({ id: String(index), text: `event ${index}`, timestampMs: index }, [1, 0])
    }
    assert.equal(topics.classify([...topics.topics.values()][0]!, 60), 'FADING')
    topics.maintain(1_000)
    assert.equal(topics.topics.size, 0)
    assert.equal(topics.snapshotDiagnostics().topicsExpired, 1)
  })

  it('embeds only lexical candidates in the combined streaming detector', async () => {
    let embeddingCalls = 0
    const detector = new StreamingTrendDetector(async () => {
      embeddingCalls += 1
      return new Float32Array([1, 0])
    })
    for (let index = 0; index < 4; index += 1) {
      await detector.process({
        id: String(index), text: `smoke near heathrow report ${index}`,
        timestampMs: index * 1_000, sourceId: `did:${index}`,
      })
    }
    assert.equal(embeddingCalls, 2)
    assert.equal(detector.semantic.topics.size, 1)
    assert.equal(detector.snapshotDiagnostics().messagesProcessed, 4)
  })
})
