import { DEFAULT_STOP_WORDS } from './analysis.js'

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,24}(?:\/\S*)?/giu
const MENTION_PATTERN = /(^|\s)@[\p{L}\p{N}._:-]+/gu
const TOKEN_PATTERN = /<url>|<mention>|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

export const TrendDetectionDefaults = Object.freeze({
  lexicalFastHalfLifeMs: 60_000,
  lexicalMediumHalfLifeMs: 10 * 60_000,
  lexicalSlowHalfLifeMs: 6 * 60 * 60_000,
  lexicalMinFastActivity: 3,
  lexicalMinBurstScore: 3,
  lexicalStrongBurstScore: 8,
  lexicalEpsilon: 0.25,
  maxFeatures: 100_000,
  featurePruneThreshold: 0.01,
  duplicateTtlMs: 3 * 60_000,
  maxDuplicateSignatures: 20_000,
  maintenanceIntervalMs: 10_000,
  topicFastHalfLifeMs: 2 * 60_000,
  topicMediumHalfLifeMs: 15 * 60_000,
  topicSlowHalfLifeMs: 6 * 60 * 60_000,
  topicSimilarityThreshold: 0.72,
  centroidAlpha: 0.1,
  minTopicMessages: 3,
  minTopicSources: 2,
  minTopicFastActivity: 3,
  topicStaleTtlMs: 60 * 60_000,
  maxActiveTopics: 2_000,
  maxTopicSamples: 5,
  maxSourcesPerTopic: 100,
  sourceDiversityCap: 10,
  sourceTtlMs: 15 * 60_000,
  sourceThrottleWindowMs: 60_000,
  maxSourceContributionsPerWindow: 3,
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
    .replace(URL_PATTERN, ' <url> ')
  return (prepared.match(TOKEN_PATTERN) ?? [])
    .map((token) => token.replaceAll('’', "'"))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isUsefulUnigram(token, stopWords) {
  return token !== '<url>'
    && token !== '<mention>'
    && token.length >= 2
    && !/^\p{N}+$/u.test(token)
    && !stopWords.has(token)
}

export function extractLexicalFeatures(normalized, stopWords = DEFAULT_STOP_WORDS) {
  const tokens = normalized.match(TOKEN_PATTERN) ?? []
  const features = new Set()
  for (const token of tokens) {
    if (isUsefulUnigram(token, stopWords)) features.add(token)
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index]
    const right = tokens[index + 1]
    if ([left, right].some((token) => token === '<url>' || token === '<mention>')) continue
    if ([left, right].every((token) => !isUsefulUnigram(token, stopWords))) continue
    features.add(`${left} ${right}`)
  }
  return [...features]
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
    const scoredFeatures = features.map((feature) => {
      const stats = this.#updateFeature(feature, now)
      return { feature, score: this.lexicalBurst(stats, now), fastActivity: stats.fast }
    }).sort((left, right) => right.score - left.score || left.feature.localeCompare(right.feature))

    const moderate = scoredFeatures.filter(({ score, fastActivity }) => (
      // An EW count starts decaying between observations, so three recent
      // occurrences will normally be just below the literal value three.
      fastActivity > this.options.lexicalMinFastActivity - 1
      && score >= this.options.lexicalMinBurstScore
    ))
    const candidate = moderate.some(({ score }) => score >= this.options.lexicalStrongBurstScore)
      || moderate.length >= 2
    if (candidate) this.diagnostics.candidates += 1
    return this.#result(message, normalized, scoredFeatures, candidate, false)
  }

  lexicalBurst(stats, now) {
    const current = this.readStats(stats, now)
    const minuteMs = 60_000
    const fastRate = current.fast * minuteMs / this.options.lexicalFastHalfLifeMs
    const slowRate = current.slow * minuteMs / this.options.lexicalSlowHalfLifeMs
    return ((fastRate + this.options.lexicalEpsilon) / (slowRate + this.options.lexicalEpsilon))
      * Math.log1p(fastRate)
  }

  readStats(stats, now) {
    const elapsedMs = Math.max(0, now - stats.lastUpdatedMs)
    return {
      fast: decay(stats.fast, elapsedMs, this.options.lexicalFastHalfLifeMs),
      medium: decay(stats.medium, elapsedMs, this.options.lexicalMediumHalfLifeMs),
      slow: decay(stats.slow, elapsedMs, this.options.lexicalSlowHalfLifeMs),
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

  #result(message, normalized, scoredFeatures, candidate, duplicate) {
    return { message, normalized, scoredFeatures, candidate, duplicate }
  }

  #isDuplicate(normalized, now) {
    const seenAt = this.recentDuplicates.get(normalized)
    this.recentDuplicates.delete(normalized)
    this.recentDuplicates.set(normalized, now)
    this.#boundMap(this.recentDuplicates, this.options.maxDuplicateSignatures)
    return seenAt !== undefined && now - seenAt <= this.options.duplicateTtlMs
  }

  #updateFeature(feature, now) {
    const previous = this.features.get(feature)
    const stats = previous
      ? this.readStats(previous, now)
      : { fast: 0, medium: 0, slow: 0, lastUpdatedMs: now }
    stats.fast += 1
    stats.medium += 1
    stats.slow += 1
    stats.lastUpdatedMs = Math.max(now, stats.lastUpdatedMs)
    this.features.delete(feature)
    this.features.set(feature, stats)
    this.#boundMap(this.features, this.options.maxFeatures, 'featuresPruned')
    return stats
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
  const minuteMs = 60_000
  const fastRate = current.fast * minuteMs / options.topicFastHalfLifeMs
  const slowRate = current.slow * minuteMs / options.topicSlowHalfLifeMs
  const ratio = (fastRate + options.lexicalEpsilon) / (slowRate + options.lexicalEpsilon)
  return clamp(Math.log1p(Math.max(0, ratio - 1)) / Math.log(21))
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
    const match = this.findMatchingTopic(embedding)
    if (!match) return { topic: this.#createTopic(message, embedding), created: true, suppressed: false }
    if (this.#sourceIsThrottled(match.topic, message.sourceId, now)) {
      this.diagnostics.sourceContributionsSuppressed += 1
      return { topic: match.topic, created: false, suppressed: true, similarity: match.similarity }
    }
    this.#updateTopic(match.topic, message, embedding, match.similarity)
    this.diagnostics.topicAssignments += 1
    return { topic: match.topic, created: false, suppressed: false, similarity: match.similarity }
  }

  findMatchingTopic(embedding) {
    let topic
    let similarity = -1
    for (const current of this.topics.values()) {
      const candidateSimilarity = dot(embedding, current.centroid)
      if (candidateSimilarity > similarity) {
        topic = current
        similarity = candidateSimilarity
      }
    }
    return topic && similarity >= this.options.topicSimilarityThreshold ? { topic, similarity } : undefined
  }

  scoreTopic(topic, now = Date.now()) {
    this.#pruneTopicSources(topic, now)
    const current = topicRates(topic, now, this.options)
    const minuteMs = 60_000
    const fastRate = current.fast * minuteMs / this.options.topicFastHalfLifeMs
    const slowRate = current.slow * minuteMs / this.options.topicSlowHalfLifeMs
    const components = {
      burst: topicBurst(topic, now, this.options),
      volume: clamp(Math.log1p(current.fast) / Math.log1p(this.options.volumeCap)),
      coherence: clamp((topic.coherence + 1) / 2),
      novelty: clamp(1 / (1 + slowRate)),
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
      hasSourceIdentity: Boolean(message.sourceId),
    }
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
    this.#retainSamples(topic, this.#sample(message, similarity))
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
    const assignment = this.semantic.observe(message, embedding)
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
