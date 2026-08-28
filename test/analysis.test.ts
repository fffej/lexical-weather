import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import nlp from 'compromise'
import {
  EntityDictionary,
  FirehosePostSample,
  STOP_WORDS,
  addStopWord,
  countEntityTypes,
  extractEntities,
  isCandidateEntity,
  normalizeEntity,
  rankEntities,
  removeStopWord,
  unwrapJetstreamEvent,
} from '../docs/analysis.js'

describe('dashboard entity analysis', () => {
  it('extracts named entities and common noun phrases with Compromise', () => {
    const entities = extractEntities(
      'Mary met Dr. John Smith in Paris at Google to discuss renewable energy.',
      nlp,
    )
    const pairs = entities.map(({ label, type }) => [label, type])
    assert.ok(pairs.some(([label, type]) => label === 'Mary' && type === 'person'))
    assert.ok(pairs.some(([label, type]) => label === 'Dr. John Smith' && type === 'person'))
    assert.ok(pairs.some(([label, type]) => label === 'Paris' && type === 'place'))
    assert.ok(pairs.some(([label, type]) => label === 'Google' && type === 'organization'))
    assert.ok(pairs.some(([label, type]) => label === 'renewable energy' && type === 'thing'))
  })

  it('discards URLs, standalone filler, and describing words', () => {
    const entities = extractEntities(
      'A beautiful old house is really nice. Read https://example.org/interesting-story.',
      nlp,
    )
    assert.ok(entities.some(({ key }) => key === 'beautiful old house'))
    assert.equal(entities.some(({ key }) => key === 'beautiful'), false)
    assert.equal(entities.some(({ key }) => key.includes('example')), false)
    assert.equal(entities.some(({ key }) => key === 'really'), false)
  })

  it('normalizes curly apostrophes and whitespace for stable keys', () => {
    assert.equal(normalizeEntity('  King’s   Cross '), "king's cross")
  })

  it('counts an entity once per post while retaining repeated mention counts', () => {
    const sample = new EntityDictionary()
    const openAI = { key: 'openai', label: 'OpenAI', type: 'organization' } as const
    sample.observe([openAI, openAI], 0)
    sample.observe([openAI], 1)
    const [row] = rankEntities(sample, { minimumPosts: 2 })
    assert.equal(row?.label, 'OpenAI')
    assert.equal(row?.postCount, 2)
    assert.equal(row?.mentionCount, 3)
    assert.equal(sample.postCount, 2)
  })

  it('does not count an update to the same post as another distinct post', () => {
    const sample = new EntityDictionary()
    const entity = { key: 'openai', label: 'OpenAI', type: 'organization' } as const
    assert.equal(sample.observe([entity], 0, 'post-1'), true)
    assert.equal(sample.observe([entity], 1, 'post-1'), false)
    assert.equal(sample.entities.get('openai')?.postCount, 1)
    assert.equal(sample.postCount, 1)
  })

  it('expires post and entity observations at the selected window boundary', () => {
    const sample = new EntityDictionary(100)
    const place = { key: 'london', label: 'London', type: 'place' } as const
    sample.observe([place], 0)
    sample.observe([place], 50)
    sample.observe([], 60)

    assert.equal(sample.prune(150, true), true)
    assert.equal(sample.entities.get('london')?.postCount, 1)
    assert.equal(sample.postCount, 2)
    assert.equal(sample.prune(151, true), true)
    assert.equal(sample.entities.size, 0)
    assert.equal(sample.postCount, 1)
  })

  it('bounds entity memory by ejecting the least recently seen entity', () => {
    const sample = new EntityDictionary(1_000, { maxEntities: 2 })
    sample.observe([{ key: 'alpha', label: 'Alpha', type: 'thing' }], 0)
    sample.observe([{ key: 'beta', label: 'Beta', type: 'thing' }], 1)
    sample.observe([{ key: 'gamma', label: 'Gamma', type: 'thing' }], 2)
    assert.deepEqual([...sample.entities.keys()], ['beta', 'gamma'])
    assert.equal(sample.mentionCount, 2)
  })

  it('ranks by distinct posts, then mentions, and reports type totals', () => {
    const sample = new EntityDictionary()
    const person = { key: 'mary', label: 'Mary', type: 'person' } as const
    const place = { key: 'paris', label: 'Paris', type: 'place' } as const
    sample.observe([person, place, place], 0)
    sample.observe([person, place], 1)
    sample.observe([person], 2)
    assert.deepEqual(rankEntities(sample).map(({ key }) => key), ['mary'])
    assert.deepEqual(rankEntities(sample, { minimumPosts: 2 }).map(({ key }) => key), ['mary', 'paris'])
    assert.deepEqual(countEntityTypes(sample, 2), {
      person: 1, place: 1, organization: 0, thing: 0,
    })
  })

  it('adds and removes personal exclusions without removing built-in stop words', () => {
    assert.equal(addStopWord('Climate Change'), true)
    assert.equal(STOP_WORDS.has('climate change'), true)
    assert.equal(isCandidateEntity('climate change'), false)
    assert.equal(removeStopWord('Climate Change'), true)
    assert.equal(isCandidateEntity('climate change'), true)
    assert.equal(removeStopWord('maybe'), false)
    assert.equal(STOP_WORDS.has('maybe'), true)
  })

  it('keeps full post bodies only in an independent bounded sample', () => {
    const sample = new FirehosePostSample(1, 1_000)
    sample.upsert({ id: 'one', text: 'London', entityKeys: ['london'] }, 0)
    sample.upsert({ id: 'two', text: 'London again', entityKeys: ['london'] }, 1)
    assert.deepEqual(sample.postsForEntity('london').map((post) => post.id), ['two'])
    assert.equal(sample.remove('two'), true)
    assert.deepEqual(sample.postsForEntity('london'), [])
  })

  it('unwraps v2 stream envelopes', () => {
    const payload = { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq: 4 }
    assert.equal(unwrapJetstreamEvent({ $type: 'message', payload }), payload)
  })
})
