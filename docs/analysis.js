const WORD_PATTERN = /[#@]?[\p{L}\p{M}]+(?:[’'][\p{L}\p{M}]+)*/gu
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,24}(?:\/\S*)?/giu

export const STOP_WORDS = new Set(`
  a about above after again against all am an and any are aren't as at be because been before
  being below between both but by can can't cannot could couldn't did didn't do does doesn't doing
  don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll
  he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't
  it it's its itself just let's me more most mustn't my myself no nor not of off on once only or other
  ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some
  such than that that's the their theirs them themselves then there there's these they they'd they'll
  they're they've this those through to too under until up very was wasn't we we'd we'll we're we've
  were weren't what what's when when's where where's which while who who's whom why why's will with
  won't would wouldn't you you'd you'll you're you've your yours yourself yourselves rt via
  http https www com org net
`.trim().split(/\s+/))

export function tokenize(text) {
  const matches = text.replace(URL_PATTERN, ' ').normalize('NFKC').toLocaleLowerCase('en').match(WORD_PATTERN) ?? []
  return matches
    .map((word) => word.replace(/^[@#]/, '').replaceAll('’', "'"))
    .filter((word) => word.length > 1 && !/^\p{M}+$/u.test(word))
}

export class SlidingPostWindow {
  constructor(limit = 2500) {
    this.limit = limit
    this.posts = []
    this.byId = new Map()
    this.counts = new Map()
    this.tokenCount = 0
  }

  setLimit(limit) {
    this.limit = limit
    this.#trim()
  }

  upsert(post) {
    this.remove(post.id)
    this.posts.push(post)
    this.byId.set(post.id, post)
    this.#changeCounts(post.tokens, 1)
    this.#trim()
  }

  remove(id) {
    const post = this.byId.get(id)
    if (!post) return false
    this.byId.delete(id)
    const index = this.posts.indexOf(post)
    if (index >= 0) this.posts.splice(index, 1)
    this.#changeCounts(post.tokens, -1)
    return true
  }

  clear() {
    this.posts.length = 0
    this.byId.clear()
    this.counts.clear()
    this.tokenCount = 0
  }

  #trim() {
    while (this.posts.length > this.limit) {
      const post = this.posts.shift()
      this.byId.delete(post.id)
      this.#changeCounts(post.tokens, -1)
    }
  }

  #changeCounts(tokens, direction) {
    this.tokenCount += tokens.length * direction
    for (const token of tokens) {
      const next = (this.counts.get(token) ?? 0) + direction
      if (next <= 0) this.counts.delete(token)
      else this.counts.set(token, next)
    }
  }
}

export function loadBaseline(payload) {
  return new Map(payload.words.map(([word, early, late]) => [word, { early, late }]))
}

export function logLift(livePpm, baselinePpm) {
  return Math.log2((livePpm + 1) / (baselinePpm + 1))
}

export function rankLiveWords(window, baseline, options = {}) {
  const {
    minimumCount = 3,
    includeStopWords = false,
    query = '',
    limit = 40,
    comparison = 'late',
  } = options
  if (window.tokenCount === 0) return []
  const foldedQuery = query.trim().toLocaleLowerCase('en')
  const rows = []

  for (const [word, count] of window.counts) {
    if (count < minimumCount) continue
    if (!includeStopWords && STOP_WORDS.has(word)) continue
    if (foldedQuery && !word.includes(foldedQuery)) continue
    const reference = baseline.get(word) ?? { early: 0, late: 0 }
    const livePpm = count / window.tokenCount * 1_000_000
    const earlyLift = logLift(livePpm, reference.early)
    const lateLift = logLift(livePpm, reference.late)
    const selectedLift = comparison === 'early' ? earlyLift : lateLift
    rows.push({
      word,
      count,
      livePpm,
      earlyPpm: reference.early,
      latePpm: reference.late,
      earlyLift,
      lateLift,
      historicalLift: logLift(reference.late, reference.early),
      score: Math.max(0, selectedLift) * Math.sqrt(count),
      isUnseen: reference.early === 0 && reference.late === 0,
    })
  }

  return rows
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit)
}

export function rankHistoricalWords(baseline, direction = 'rising', limit = 12, vocabulary = null) {
  const rows = []
  for (const [word, values] of baseline) {
    if (vocabulary && !vocabulary.has(word)) continue
    if (STOP_WORDS.has(word) || word.length < 3) continue
    if (Math.max(values.early, values.late) < 2) continue
    const lift = logLift(values.late, values.early)
    const weight = Math.log10(Math.max(values.early, values.late) + 1)
    rows.push({ word, ...values, lift, score: lift * weight })
  }
  rows.sort((a, b) => direction === 'rising' ? b.score - a.score : a.score - b.score)
  return rows.slice(0, limit)
}

export function postUri(event) {
  return `at://${event.did}/app.bsky.feed.post/${event.rkey}`
}

export function unwrapJetstreamEvent(message) {
  if (message?.$type === 'message') return message.payload
  return message
}
