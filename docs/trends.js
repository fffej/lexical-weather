import { DEFAULT_STOP_WORDS } from './analysis.js'

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,24}(?:\/\S*)?/giu
const MENTION_PATTERN = /(^|\s)@[\p{L}\p{N}._:-]+/gu
const HASHTAG_PATTERN = /(^|\s)#[\p{L}\p{N}_-]+/gu
const TOKEN_PATTERN = /<url>|<mention>|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

// These words carry little topic identity in conversational streams. Keeping them out
// of the evidence gate is much more effective than asking an embedding model to undo
// thousands of coincidental matches such as "love", "need", and "game".
const TREND_STOP_WORDS = new Set([...DEFAULT_STOP_WORDS, ...`
  account additional agree al app art august back believe bit book bought boy bringing building call called
  campaign change check country cute
  deal end ever feeling film find fine follow forgot found friend friends fun game games
  details election et finally forward free friday girl google guy guys happy hard heart help idea im important
  information interesting issued kid kids learn learned learning life light link long looking love loved loves
  making man market mexico model money morning music named national need needed needs news order past
  pick place play played playing point post posted read ready real reason release remember
  nws president pro run running said saw school send song space start started states stay story super support tip
  talk tell thursday tried tune turn united update updated video wait watch week white win won work
  working works world worth
`.trim().split(/\s+/)])

const ENGLISH_MARKERS = new Set(`
  a an and are as at be because been but by can could did do does for from had has have he
  her here him his how i if in into is it its me my no not of on one or our out she so than
  that the their them then there they this to up us was we were what when where which who why
  will with would you your i'm i've i'll i'd you're you've you'll you'd we're we've we'll we'd
  they're they've they'll they'd he's she's it's that's there's don't doesn't didn't can't
  couldn't won't wouldn't isn't aren't wasn't weren't haven't hasn't hadn't should must
`.trim().split(/\s+/))

// High-signal function words from common non-English languages. This catches posts
// whose author metadata incorrectly says English without trying to identify or retain
// the other language.
const NON_ENGLISH_MARKERS = new Set(`
  al ahora avec avec dans das dass dei del della delle der des die ein eine el ella ellos en
  era es esta este eu foi für gli il las les los mais mit não oder para pero por porque que
  qui se senza sin sobre son sua suas sus très uma una und une uno von ya y zu
`.trim().split(/\s+/))

export const TrendDetectionDefaults = Object.freeze({
  lexicalFastHalfLifeMs: 90_000,
  lexicalMediumHalfLifeMs: 15 * 60_000,
  lexicalSlowHalfLifeMs: 6 * 60 * 60_000,
  lexicalMinFastActivity: 3,
  lexicalMinSources: 3,
  lexicalMinBurstScore: 1.8,
  lexicalStrongBurstScore: 3.5,
  lexicalSourceWindowMs: 3 * 60_000,
  lexicalEpsilon: 0.25,
  maxFeatures: 100_000,
  featurePruneThreshold: 0.01,
  duplicateTtlMs: 3 * 60_000,
  maxDuplicateSignatures: 20_000,
  maintenanceIntervalMs: 10_000,
  topicFastHalfLifeMs: 3 * 60_000,
  topicMediumHalfLifeMs: 20 * 60_000,
  topicSlowHalfLifeMs: 6 * 60 * 60_000,
  topicSimilarityThreshold: 0.64,
  topicLexicalSimilarityFloor: 0.48,
  centroidAlpha: 0.14,
  minTopicMessages: 3,
  minTopicSources: 3,
  minTopicFastActivity: 3,
  topicStaleTtlMs: 60 * 60_000,
  maxActiveTopics: 2_000,
  maxTopicSamples: 5,
  maxSourcesPerTopic: 100,
  sourceDiversityCap: 10,
  sourceTtlMs: 15 * 60_000,
  sourceThrottleWindowMs: 60_000,
  maxSourceContributionsPerWindow: 2,
  volumeCap: 50,
  scoreWeights: Object.freeze({
    burst: 0.40,
    volume: 0.20,
    coherence: 0.15,
    novelty: 0.15,
    diversity: 0.10,
  }),
})

export function decay(value, elapsedMs, halfLifeMs) {
  if (value === 0 || elapsedMs <= 0) return value
  return value * 2 ** (-elapsedMs / halfLifeMs)
}

export function normalizeText(text) {
  const prepared = String(text)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(MENTION_PATTERN, '$1 <mention> ')
    .replace(HASHTAG_PATTERN, '$1 ')
    .replace(URL_PATTERN, ' <url> ')
  return (prepared.match(TOKEN_PATTERN) ?? [])
    .map((token) => token.replaceAll('’', "'"))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Conservative English detection for the firehose. Declared languages are respected,
 * but unlabelled posts must contain both predominantly Latin text and recognisable
 * English grammar words. False negatives are preferable to polluting every baseline.
 */
export function isEnglishPost(text, declaredLangs = []) {
  const langs = Array.isArray(declaredLangs)
    ? declaredLangs.map((lang) => String(lang).toLowerCase())
    : []
  if (langs.length && !langs.some((lang) => lang === 'en' || lang.startsWith('en-'))) return false

  const prepared = String(text)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(URL_PATTERN, ' ')
    .replace(MENTION_PATTERN, '$1 ')
    .replace(HASHTAG_PATTERN, '$1 ')
  const letters = prepared.match(/\p{L}/gu) ?? []
  if (letters.length < 4) return false
  const latinLetters = prepared.match(/\p{Script=Latin}/gu) ?? []
  if (latinLetters.length / letters.length < 0.9) return false

  const words = prepared.match(/[a-z]+(?:'[a-z]+)*/g) ?? []
  if (words.length === 0) return false
  const englishMarkers = words.filter((word) => ENGLISH_MARKERS.has(word)).length
  const foreignMarkers = words.filter((word) => NON_ENGLISH_MARKERS.has(word)).length
  if (foreignMarkers >= 2 && foreignMarkers > englishMarkers) return false
  if (langs.length) return words.length >= 2 || words.some((word) => ENGLISH_MARKERS.has(word))
  if (words.length < 3) return false
  return englishMarkers >= 1 && (englishMarkers >= 2 || englishMarkers / words.length >= 0.12)
}

function isUsefulUnigram(token, stopWords) {
  return token !== '<url>'
    && token !== '<mention>'
    && token.length >= 2
    && !/^\p{N}+$/u.test(token)
    && !stopWords.has(token)
}

export function extractLexicalFeatures(normalized, stopWords = TREND_STOP_WORDS) {
  const tokens = normalized.match(TOKEN_PATTERN) ?? []
  const features = new Set()
  for (const token of tokens) {
    if (isUsefulUnigram(token, stopWords)) features.add(token)
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index]
    const right = tokens[index + 1]
    if ([left, right].some((token) => token === '<url>' || token === '<mention>')) continue
    if (![left, right].every((token) => isUsefulUnigram(token, stopWords))) continue
    features.add(`${left} ${right}`)
  }
  // Three-word phrases give breaking events a precise label and are far less likely
  // to collide than unigrams. Require at least two meaningful words.
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const phrase = tokens.slice(index, index + 3)
    if (phrase.some((token) => token === '<url>' || token === '<mention>')) continue
    if (phrase.filter((token) => isUsefulUnigram(token, stopWords)).length < 2) continue
    features.add(phrase.join(' '))
  }
  // Also retain non-adjacent content pairs. Events are often phrased as "smoke by
  // Heathrow" and "fire near Heathrow"; the shared pair is better evidence than either
  // unigram and avoids requiring the sentence model to see every ordinary post.
  const content = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isUsefulUnigram(token, stopWords))
    .slice(0, 16)
  for (let left = 0; left < content.length; left += 1) {
    for (let right = left + 1; right < content.length; right += 1) {
      if (content[right].index - content[left].index > 7) break
      features.add(`${content[left].token} ${content[right].token}`)
    }
  }
  return [...features]
}

function featureRate(value, halfLifeMs, ageMs) {
  const observationAge = Math.max(1_000, ageMs)
  const warmup = 1 - 2 ** (-observationAge / halfLifeMs)
  return value * Math.LN2 / halfLifeMs / Math.max(warmup, 1e-9)
}

function mergedOptions(options) {
  return {
    ...TrendDetectionDefaults,
    ...options,
    scoreWeights: { ...TrendDetectionDefaults.scoreWeights, ...options.scoreWeights },
  }
}

export class LexicalNoveltyDetector {
  constructor(options = {}) {
    this.options = mergedOptions(options)
    this.features = new Map()
    this.recentDuplicates = new Map()
    this.nextMaintenanceAt = 0
    this.diagnostics = {
      messagesProcessed: 0,
      candidates: 0,
      duplicatesSuppressed: 0,
      featuresPruned: 0,
    }
  }

  process(message) {
    const now = Number(message.timestampMs)
    if (!Number.isFinite(now)) throw new TypeError('message.timestampMs must be finite')
    this.diagnostics.messagesProcessed += 1
    this.#maybeMaintain(now)

    const normalized = normalizeText(message.text)
    if (!normalized) return this.#result(message, normalized, [], false, false)
    if (this.#isDuplicate(normalized, now)) {
      this.diagnostics.duplicatesSuppressed += 1
      return this.#result(message, normalized, [], false, true)
    }

    const features = extractLexicalFeatures(normalized)
    const sourceKey = message.sourceId ?? message.id
    const scoredFeatures = features.map((feature) => {
      const stats = this.#updateFeature(feature, now, sourceKey)
      const sourceCount = this.#sourceCount(stats, now)
      return {
        feature,
        score: this.lexicalBurst(stats, now),
        fastActivity: stats.fast,
        sourceCount,
        words: feature.split(' ').length,
        ageMs: Math.max(0, now - stats.firstSeenMs),
      }
    }).sort((left, right) => right.sourceCount - left.sourceCount
      || right.score - left.score
      || right.words - left.words
      || left.feature.localeCompare(right.feature))

    const eligible = scoredFeatures.filter(({ fastActivity, sourceCount }) => (
      // An EW count starts decaying between observations, so three recent
      // occurrences will normally be just below the literal value three.
      fastActivity > this.options.lexicalMinFastActivity - 1
      && sourceCount >= this.options.lexicalMinSources
    ))
    const freshOrBursty = eligible.filter(({ ageMs, score }) => (
      ageMs <= this.options.lexicalMediumHalfLifeMs || score >= this.options.lexicalMinBurstScore
    ))
    const phrases = freshOrBursty.filter(({ words }) => words > 1)
    const bursty = eligible.filter(({ score }) => score >= this.options.lexicalMinBurstScore)
    const candidate = phrases.length >= 1
      || bursty.some(({ score, words }) => words > 1 && score >= this.options.lexicalStrongBurstScore)
    if (candidate) this.diagnostics.candidates += 1
    return this.#result(message, normalized, scoredFeatures, candidate, false, eligible.slice(0, 12))
  }

  lexicalBurst(stats, now) {
    const current = this.readStats(stats, now)
    const ageMs = Math.max(0, now - current.firstSeenMs)
    const fastRate = featureRate(current.fast, this.options.lexicalFastHalfLifeMs, ageMs) * 60_000
    const slowRate = featureRate(current.slow, this.options.lexicalSlowHalfLifeMs, ageMs) * 60_000
    return ((fastRate + this.options.lexicalEpsilon) / (slowRate + this.options.lexicalEpsilon))
      * Math.log1p(fastRate)
  }

  readStats(stats, now) {
    const elapsedMs = Math.max(0, now - stats.lastUpdatedMs)
    return {
      fast: decay(stats.fast, elapsedMs, this.options.lexicalFastHalfLifeMs),
      medium: decay(stats.medium, elapsedMs, this.options.lexicalMediumHalfLifeMs),
      slow: decay(stats.slow, elapsedMs, this.options.lexicalSlowHalfLifeMs),
      firstSeenMs: stats.firstSeenMs,
      sources: stats.sources,
      lastUpdatedMs: Math.max(now, stats.lastUpdatedMs),
    }
  }

  maintain(now = Date.now()) {
    const duplicateCutoff = now - this.options.duplicateTtlMs
    for (const [signature, seenAt] of this.recentDuplicates) {
      if (seenAt >= duplicateCutoff) break
      this.recentDuplicates.delete(signature)
    }
    for (const [feature, stats] of this.features) {
      const current = this.readStats(stats, now)
      if (current.fast < this.options.featurePruneThreshold
        && current.medium < this.options.featurePruneThreshold
        && current.slow < this.options.featurePruneThreshold) {
        this.features.delete(feature)
        this.diagnostics.featuresPruned += 1
      }
    }
    this.#boundMap(this.features, this.options.maxFeatures, 'featuresPruned')
    this.#boundMap(this.recentDuplicates, this.options.maxDuplicateSignatures)
    this.nextMaintenanceAt = now + this.options.maintenanceIntervalMs
  }

  clear() {
    this.features.clear()
    this.recentDuplicates.clear()
    this.nextMaintenanceAt = 0
    for (const key of Object.keys(this.diagnostics)) this.diagnostics[key] = 0
  }

  snapshotDiagnostics() {
    const processed = this.diagnostics.messagesProcessed
    return {
      ...this.diagnostics,
      candidatePercentage: processed ? this.diagnostics.candidates / processed * 100 : 0,
      activeFeatures: this.features.size,
      duplicateSignatures: this.recentDuplicates.size,
    }
  }

  #result(message, normalized, scoredFeatures, candidate, duplicate, evidence = []) {
    return { message, normalized, scoredFeatures, evidence, candidate, duplicate }
  }

  #isDuplicate(normalized, now) {
    const seenAt = this.recentDuplicates.get(normalized)
    this.recentDuplicates.delete(normalized)
    this.recentDuplicates.set(normalized, now)
    this.#boundMap(this.recentDuplicates, this.options.maxDuplicateSignatures)
    return seenAt !== undefined && now - seenAt <= this.options.duplicateTtlMs
  }

  #updateFeature(feature, now, sourceKey) {
    const previous = this.features.get(feature)
    const stats = previous
      ? this.readStats(previous, now)
      : {
        fast: 0, medium: 0, slow: 0, firstSeenMs: now,
        lastUpdatedMs: now, sources: new Map(),
      }
    stats.fast += 1
    stats.medium += 1
    stats.slow += 1
    stats.lastUpdatedMs = Math.max(now, stats.lastUpdatedMs)
    if (sourceKey) {
      stats.sources.delete(sourceKey)
      stats.sources.set(sourceKey, now)
      while (stats.sources.size > 32) stats.sources.delete(stats.sources.keys().next().value)
    }
    this.features.delete(feature)
    this.features.set(feature, stats)
    this.#boundMap(this.features, this.options.maxFeatures, 'featuresPruned')
    return stats
  }

  #sourceCount(stats, now) {
    const cutoff = now - this.options.lexicalSourceWindowMs
    for (const [sourceKey, seenAt] of stats.sources) {
      if (seenAt < cutoff) stats.sources.delete(sourceKey)
    }
    return stats.sources.size
  }

  #maybeMaintain(now) {
    if (now >= this.nextMaintenanceAt) this.maintain(now)
  }

  #boundMap(map, maximum, diagnostic) {
    while (map.size > maximum) {
      map.delete(map.keys().next().value)
      if (diagnostic) this.diagnostics[diagnostic] += 1
    }
  }
}

export function normalizeEmbedding(vector) {
  const input = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  let squaredNorm = 0
  for (const value of input) squaredNorm += value * value
  const norm = Math.sqrt(squaredNorm)
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError('embedding must have a finite non-zero norm')
  const normalized = new Float32Array(input.length)
  for (let index = 0; index < input.length; index += 1) normalized[index] = input[index] / norm
  return normalized
}

export function dot(left, right) {
  if (left.length !== right.length) throw new RangeError('embedding dimensions must match')
  let product = 0
  for (let index = 0; index < left.length; index += 1) product += left[index] * right[index]
  return product
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

function topicRates(topic, now, options) {
  const elapsedMs = Math.max(0, now - topic.lastCountUpdateMs)
  return {
    fast: decay(topic.fastCount, elapsedMs, options.topicFastHalfLifeMs),
    medium: decay(topic.mediumCount, elapsedMs, options.topicMediumHalfLifeMs),
    slow: decay(topic.slowCount, elapsedMs, options.topicSlowHalfLifeMs),
  }
}

export function topicBurst(topic, now, options = TrendDetectionDefaults) {
  const current = topicRates(topic, now, options)
  const ageMs = Math.max(0, now - topic.createdAtMs)
  const fastRate = featureRate(current.fast, options.topicFastHalfLifeMs, ageMs) * 60_000
  const slowRate = featureRate(current.slow, options.topicSlowHalfLifeMs, ageMs) * 60_000
  const ratio = (fastRate + options.lexicalEpsilon) / (slowRate + options.lexicalEpsilon)
  const baselineBurst = clamp(Math.log1p(Math.max(0, ratio - 1)) / Math.log(21))
  const youngTopicEvidence = clamp(1 - ageMs / options.topicMediumHalfLifeMs)
    * clamp(Math.log1p(current.fast) / Math.log(8))
  return Math.max(baselineBurst, youngTopicEvidence)
}

function lexicalEvidence(message) {
  return Array.isArray(message.evidence) ? message.evidence : []
}

function evidenceKeys(message) {
  return new Set(lexicalEvidence(message).map(({ feature }) => feature))
}

const TITLE_SMALL_WORDS = new Set('a an and as at by for from in of on or the to'.split(' '))
const TITLE_ACRONYMS = new Set('ai bbc cia fbi gta hhs ice nasa nfl nhl nws uk us ucla'.split(' '))

function formatTopicLabel(feature) {
  const cleaned = String(feature).replaceAll(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.split(' ').map((word, index) => {
    if (TITLE_ACRONYMS.has(word)) return word.toUpperCase()
    if (index > 0 && TITLE_SMALL_WORDS.has(word)) return word
    return word[0].toLocaleUpperCase('en') + word.slice(1)
  }).join(' ')
}

export class OnlineTopicClusterer {
  constructor(options = {}) {
    this.options = mergedOptions(options)
    this.topics = new Map()
    this.nextTopicId = 1
    this.diagnostics = {
      embeddings: 0,
      topicAssignments: 0,
      topicsCreated: 0,
      sourceContributionsSuppressed: 0,
      topicsExpired: 0,
    }
  }

  observe(message, vector) {
    const now = Number(message.timestampMs)
    if (!Number.isFinite(now)) throw new TypeError('message.timestampMs must be finite')
    const embedding = normalizeEmbedding(vector)
    this.diagnostics.embeddings += 1
    const match = this.findMatchingTopic(embedding, message)
    if (!match) return { topic: this.#createTopic(message, embedding), created: true, suppressed: false }
    if (this.#sourceIsThrottled(match.topic, message.sourceId, now)) {
      this.diagnostics.sourceContributionsSuppressed += 1
      return { topic: match.topic, created: false, suppressed: true, similarity: match.similarity }
    }
    this.#updateTopic(match.topic, message, embedding, match.similarity)
    this.diagnostics.topicAssignments += 1
    return { topic: match.topic, created: false, suppressed: false, similarity: match.similarity }
  }

  findMatchingTopic(embedding, message = {}) {
    let topic
    let similarity = -1
    let selectionScore = -1
    const keys = evidenceKeys(message)
    for (const current of this.topics.values()) {
      const candidateSimilarity = dot(embedding, current.centroid)
      let lexicalOverlap = 0
      for (const key of keys) {
        if (current.featureCounts.has(key)) lexicalOverlap += key.includes(' ') ? 2 : 1
      }
      const qualifies = candidateSimilarity >= this.options.topicSimilarityThreshold
        || (lexicalOverlap > 0 && candidateSimilarity >= this.options.topicLexicalSimilarityFloor)
      const adjustedSimilarity = candidateSimilarity + Math.min(0.12, lexicalOverlap * 0.03)
      if (qualifies && adjustedSimilarity > selectionScore) {
        topic = current
        similarity = candidateSimilarity
        selectionScore = adjustedSimilarity
      }
    }
    return topic ? { topic, similarity } : undefined
  }

  scoreTopic(topic, now = Date.now()) {
    this.#pruneTopicSources(topic, now)
    const current = topicRates(topic, now, this.options)
    const ageMs = Math.max(0, now - topic.createdAtMs)
    const fastRate = featureRate(current.fast, this.options.topicFastHalfLifeMs, ageMs) * 60_000
    const slowRate = featureRate(current.slow, this.options.topicSlowHalfLifeMs, ageMs) * 60_000
    const components = {
      burst: topicBurst(topic, now, this.options),
      volume: clamp(Math.log1p(current.fast) / Math.log1p(this.options.volumeCap)),
      coherence: clamp((topic.coherence + 1) / 2),
      novelty: clamp(1 / Math.sqrt(1 + current.slow / 10)),
    }
    if (topic.hasSourceIdentity) {
      components.diversity = clamp(topic.sourceIds.size / this.options.sourceDiversityCap)
    }
    const weights = this.options.scoreWeights
    let weightTotal = weights.burst + weights.volume + weights.coherence + weights.novelty
    let score = weights.burst * components.burst
      + weights.volume * components.volume
      + weights.coherence * components.coherence
      + weights.novelty * components.novelty
    if (components.diversity !== undefined) {
      score += weights.diversity * components.diversity
      weightTotal += weights.diversity
    }
    return { score: weightTotal ? score / weightTotal : 0, components, current, fastRate }
  }

  rank(now = Date.now(), limit = 20) {
    const ranked = []
    for (const topic of this.topics.values()) {
      const scored = this.scoreTopic(topic, now)
      if (topic.messageCount < this.options.minTopicMessages
        || scored.current.fast <= this.options.minTopicFastActivity - 1
        || (topic.hasSourceIdentity && topic.sourceIds.size < this.options.minTopicSources)) continue
      ranked.push({
        topicId: topic.id,
        score: scored.score,
        ...scored.components,
        state: this.classify(topic, now),
        messageCount: topic.messageCount,
        uniqueSources: topic.hasSourceIdentity ? topic.sourceIds.size : undefined,
        ageMs: Math.max(0, now - topic.createdAtMs),
        label: this.#topicLabel(topic),
        samples: topic.samples.map(({ text }) => text),
      })
    }
    return ranked
      .sort((left, right) => right.score - left.score || right.messageCount - left.messageCount)
      .slice(0, limit)
  }

  classify(topic, now = Date.now()) {
    const current = topicRates(topic, now, this.options)
    const fastRate = current.fast / this.options.topicFastHalfLifeMs
    const mediumRate = current.medium / this.options.topicMediumHalfLifeMs
    const slowRate = current.slow / this.options.topicSlowHalfLifeMs
    if (fastRate > Math.max(slowRate * 1.5, mediumRate * 1.2)) return 'EMERGING'
    if (fastRate < mediumRate * 0.75 && mediumRate > slowRate * 1.1) return 'FADING'
    return 'ACTIVE'
  }

  maintain(now = Date.now()) {
    for (const [id, topic] of this.topics) {
      this.#pruneTopicSources(topic, now)
      const current = topicRates(topic, now, this.options)
      if (now - topic.lastSeenMs > this.options.topicStaleTtlMs
        && current.fast < this.options.featurePruneThreshold
        && current.medium < this.options.featurePruneThreshold) {
        this.topics.delete(id)
        this.diagnostics.topicsExpired += 1
      }
    }
    if (this.topics.size > this.options.maxActiveTopics) {
      const lowest = [...this.topics.values()]
        .map((topic) => ({ topic, value: this.scoreTopic(topic, now).score }))
        .sort((left, right) => left.value - right.value || left.topic.lastSeenMs - right.topic.lastSeenMs)
      for (const { topic } of lowest.slice(0, this.topics.size - this.options.maxActiveTopics)) {
        this.topics.delete(topic.id)
        this.diagnostics.topicsExpired += 1
      }
    }
  }

  clear() {
    this.topics.clear()
    this.nextTopicId = 1
    for (const key of Object.keys(this.diagnostics)) this.diagnostics[key] = 0
  }

  snapshotDiagnostics() {
    return { ...this.diagnostics, activeTopics: this.topics.size }
  }

  #createTopic(message, embedding) {
    const now = message.timestampMs
    const topic = {
      id: this.nextTopicId++,
      centroid: embedding.slice(),
      messageCount: 1,
      fastCount: 1,
      mediumCount: 1,
      slowCount: 1,
      lastCountUpdateMs: now,
      createdAtMs: now,
      lastSeenMs: now,
      coherence: 1,
      samples: [this.#sample(message, 1)],
      sourceIds: new Map(),
      sourceContributions: new Map(),
      featureCounts: new Map(),
      hasSourceIdentity: Boolean(message.sourceId),
    }
    this.#recordEvidence(topic, message)
    this.#recordSource(topic, message.sourceId, now)
    this.topics.set(topic.id, topic)
    this.diagnostics.topicsCreated += 1
    if (this.topics.size > this.options.maxActiveTopics) this.maintain(now)
    return topic
  }

  #updateTopic(topic, message, embedding, similarity) {
    const now = message.timestampMs
    const current = topicRates(topic, now, this.options)
    topic.fastCount = current.fast + 1
    topic.mediumCount = current.medium + 1
    topic.slowCount = current.slow + 1
    topic.lastCountUpdateMs = Math.max(now, topic.lastCountUpdateMs)
    topic.messageCount += 1
    topic.lastSeenMs = Math.max(now, topic.lastSeenMs)
    topic.coherence += this.options.centroidAlpha * (similarity - topic.coherence)

    const blended = new Float32Array(topic.centroid.length)
    for (let index = 0; index < blended.length; index += 1) {
      blended[index] = (1 - this.options.centroidAlpha) * topic.centroid[index]
        + this.options.centroidAlpha * embedding[index]
    }
    topic.centroid = normalizeEmbedding(blended)
    this.#recordSource(topic, message.sourceId, now)
    this.#recordEvidence(topic, message)
    this.#retainSamples(topic, this.#sample(message, similarity))
  }

  #recordEvidence(topic, message) {
    for (const item of lexicalEvidence(message)) {
      if (!item?.feature) continue
      const current = topic.featureCounts.get(item.feature) ?? {
        count: 0, words: item.words ?? String(item.feature).split(' ').length,
        sourceCount: 0, burst: 0,
      }
      current.count += 1
      current.sourceCount = Math.max(current.sourceCount, item.sourceCount ?? 0)
      current.burst = Math.max(current.burst, item.score ?? 0)
      topic.featureCounts.set(item.feature, current)
    }
    if (topic.featureCounts.size > 100) {
      const weakest = [...topic.featureCounts]
        .sort(([, left], [, right]) => left.count - right.count || left.words - right.words)
      for (const [key] of weakest.slice(0, topic.featureCounts.size - 100)) {
        topic.featureCounts.delete(key)
      }
    }
  }

  #topicLabel(topic) {
    const ranked = [...topic.featureCounts]
      .filter(([, value]) => value.count >= 2)
      .map(([feature, value]) => ({
        feature,
        value: value.count * (1 + Math.min(2, value.words - 1) * 0.45)
          * (1 + Math.min(1, value.burst / 8)),
        words: value.words,
      }))
      .sort((left, right) => right.value - left.value
        || right.words - left.words
        || left.feature.localeCompare(right.feature))
    return formatTopicLabel(ranked[0]?.feature ?? '')
  }

  #sample(message, similarityToCentroid) {
    return {
      text: String(message.text),
      timestampMs: message.timestampMs,
      similarityToCentroid,
      sourceId: message.sourceId,
    }
  }

  #retainSamples(topic, sample) {
    const byText = new Map(topic.samples.map((current) => [normalizeText(current.text), current]))
    byText.set(normalizeText(sample.text), sample)
    const samples = [...byText.values()]
    const closest = [...samples]
      .sort((left, right) => right.similarityToCentroid - left.similarityToCentroid)
      .slice(0, Math.min(3, this.options.maxTopicSamples))
    const retained = new Set(closest)
    for (const recent of [...samples].sort((left, right) => right.timestampMs - left.timestampMs)) {
      if (retained.size >= this.options.maxTopicSamples) break
      retained.add(recent)
    }
    topic.samples = [...retained]
  }

  #recordSource(topic, sourceId, now) {
    if (!sourceId) return
    topic.hasSourceIdentity = true
    topic.sourceIds.delete(sourceId)
    topic.sourceIds.set(sourceId, now)
    const contributions = topic.sourceContributions.get(sourceId) ?? []
    contributions.push(now)
    topic.sourceContributions.set(sourceId, contributions)
    while (topic.sourceIds.size > this.options.maxSourcesPerTopic) {
      const oldest = topic.sourceIds.keys().next().value
      topic.sourceIds.delete(oldest)
      topic.sourceContributions.delete(oldest)
    }
  }

  #sourceIsThrottled(topic, sourceId, now) {
    if (!sourceId) return false
    const cutoff = now - this.options.sourceThrottleWindowMs
    const recent = (topic.sourceContributions.get(sourceId) ?? []).filter((seenAt) => seenAt > cutoff)
    topic.sourceContributions.set(sourceId, recent)
    return recent.length >= this.options.maxSourceContributionsPerWindow
  }

  #pruneTopicSources(topic, now) {
    const cutoff = now - this.options.sourceTtlMs
    for (const [sourceId, seenAt] of topic.sourceIds) {
      if (seenAt >= cutoff) continue
      topic.sourceIds.delete(sourceId)
      topic.sourceContributions.delete(sourceId)
    }
    for (const [sourceId, contributions] of topic.sourceContributions) {
      const recent = contributions.filter((seenAt) => seenAt > now - this.options.sourceThrottleWindowMs)
      if (recent.length) topic.sourceContributions.set(sourceId, recent)
      else topic.sourceContributions.delete(sourceId)
    }
  }
}

export class StreamingTrendDetector {
  constructor(embed, options = {}) {
    if (typeof embed !== 'function') throw new TypeError('embed must be a function')
    this.embed = embed
    this.lexical = new LexicalNoveltyDetector(options)
    this.semantic = new OnlineTopicClusterer(options)
  }

  async process(message) {
    const lexical = this.lexical.process(message)
    if (!lexical.candidate) return { lexical, embedded: false }
    const embedding = await this.embed(lexical.normalized)
    const assignment = this.semantic.observe({ ...message, evidence: lexical.evidence }, embedding)
    return { lexical, embedded: true, ...assignment }
  }

  rank(now = Date.now(), limit = 20) {
    return this.semantic.rank(now, limit)
  }

  maintain(now = Date.now()) {
    this.lexical.maintain(now)
    this.semantic.maintain(now)
  }

  clear() {
    this.lexical.clear()
    this.semantic.clear()
  }

  snapshotDiagnostics() {
    return { ...this.lexical.snapshotDiagnostics(), ...this.semantic.snapshotDiagnostics() }
  }
}
