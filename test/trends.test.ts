import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LexicalNoveltyDetector,
  decay,
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
