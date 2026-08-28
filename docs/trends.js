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
  return { ...TrendDetectionDefaults, ...options }
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
