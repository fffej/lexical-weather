const WORD_PATTERN = /[#@]?[\p{L}\p{M}]+(?:[’'][\p{L}\p{M}]+)*/gu
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,24}(?:\/\S*)?/giu

// Function words, conversational filler, post boilerplate, and profanity are excluded.
// Nouns are kept so a new name, product, place, or event can still surface.
export const DEFAULT_STOP_WORDS = new Set(`
  a about above across after afterwards again against ain't all almost alone along already also
  although always am among amongst amount an and another any anyhow anyone anything anyway anywhere
  are aren't around as at away be became because become becomes becoming been before beforehand
  behind being below beside besides between beyond both but by can can't cannot cant could couldn't
  did didn't do does doesn't doing don't done down due during each eight either eleven else elsewhere
  enough even ever every everyone everything everywhere except few fifteen fifty first five for
  former formerly forty four from front full further get gets getting give given gives go goes going
  gonna got gotta had hadn't has hasn't have haven't having he he'd he'll he's hence her here here's
  hereafter hereby herein hereupon hers herself him himself his how how's however hundred i'd i'll i'm
  i've if in indeed into is isn't it it's its itself just keep kinda kind know known knows last latter
  latterly least less let's like literally lol lmao made make makes many may maybe me meanwhile might
  mine more moreover most mostly move much must mustn't my myself namely neither never nevertheless
  next nine no nobody none noone nor not nothing now nowhere of off often okay ok on once one only
  onto or other others otherwise ought our ours ourselves out over own part perhaps please put quite
  rather really regarding rt same say saying says second see seeing seem seemed seeming seems seen
  serious several she she'd she'll she's should shouldn't show side since six sixty so some somehow
  someone something sometime sometimes somewhere still such take ten than that that's the their
  theirs them themselves then thence there there's thereafter thereby therefore therein thereupon
  these they they'd they'll they're they've thing things think thinking thinks third this those though
  three through throughout thru thus to together too top toward towards twelve twenty two under
  unless until up upon us use used using very via want wants was wasn't way we we'd we'll we're we've
  well were weren't what what's whatever when when's whence whenever where where's whereafter whereas
  whereby wherein whereupon wherever whether which while whither who who's whoever whole whom whose
  why why's will with within without won't would wouldn't yeah yes yet you you'd you'll you're you've
  your yours yourself yourselves actually basically definitely especially exactly probably simply
  totally truly haha hahaha hehe hmmm hmm omg oh ooh uh um yep nope hi hey hello thanks thank sorry
  ago bad best better big come coming cool day days feel feels felt good great guess let little live
  look looks lot lots mean means new nice night old people person pretty right stuff sure tell tells
  thought thoughts time today tomorrow tonight try trying week weeks year years
  amp com org net www http https html href png jpg jpeg gif pdf ass asshole bastard bitch bullshit
  crap damn fuck fucked fucking fucks motherfucker piss shitty shit
`.trim().split(/\s+/))

export const STOP_WORDS = new Set(DEFAULT_STOP_WORDS)

export function addStopWord(word) {
  const normalized = String(word).normalize('NFKC').toLocaleLowerCase('en').trim()
  if (!normalized) return false
  STOP_WORDS.add(normalized)
  return true
}

export function removeStopWord(word) {
  if (DEFAULT_STOP_WORDS.has(word)) return false
  return STOP_WORDS.delete(word)
}

export function tokenize(text) {
  const matches = text.replace(URL_PATTERN, ' ').normalize('NFKC').toLocaleLowerCase('en').match(WORD_PATTERN) ?? []
  return matches
    .map((word) => word.replace(/^[@#]/, '').replaceAll('’', "'"))
    .filter((word) => word.length > 1 && !/^\p{M}+$/u.test(word))
}

export function isCandidateWord(word) {
  if (word.length < 3 || word.length > 40) return false
  if (STOP_WORDS.has(word)) return false
  if (/(.)\1{3}/u.test(word)) return false
  return true
}

export class FrequencyDictionary {
  constructor(maxAgeMs = 5 * 60_000, options = {}) {
    this.maxAgeMs = maxAgeMs
    this.maxWords = options.maxWords ?? 10_000
    this.words = new Map()
    this.occurrenceCount = 0
    this.nextPruneAt = 0
  }

  setMaxAge(maxAgeMs, now = Date.now()) {
    this.maxAgeMs = maxAgeMs
    return this.prune(now, true)
  }

  observe(tokens, observedAt = Date.now()) {
    this.prune(observedAt)
    for (const token of tokens) {
      let entry = this.words.get(token)
      if (!entry) {
        entry = { occurrences: 0, lastSeenAt: observedAt }
      } else {
        // Map insertion order doubles as a cheap least-recently-seen index.
        this.words.delete(token)
      }
      entry.occurrences += 1
      entry.lastSeenAt = observedAt
      this.words.set(token, entry)
      this.occurrenceCount += 1
    }
    this.#boundWords()
  }

  prune(now = Date.now(), force = false) {
    if (!force && now < this.nextPruneAt) return false
    this.nextPruneAt = now + Math.min(1_000, this.maxAgeMs)
    const cutoff = now - this.maxAgeMs
    let changed = false
    for (const [word, entry] of this.words) {
      if (entry.lastSeenAt >= cutoff) break
      this.occurrenceCount -= entry.occurrences
      this.words.delete(word)
      changed = true
    }
    return changed
  }

  clear() {
    this.words.clear()
    this.occurrenceCount = 0
    this.nextPruneAt = 0
  }

  #boundWords() {
    while (this.words.size > this.maxWords) {
      const word = this.words.keys().next().value
      const entry = this.words.get(word)
      this.occurrenceCount -= entry.occurrences
      this.words.delete(word)
    }
  }
}

export class FirehosePostSample {
  constructor(limit = 250, maxAgeMs = 5 * 60_000) {
    this.limit = limit
    this.maxAgeMs = maxAgeMs
    this.posts = new Map()
  }

  setMaxAge(maxAgeMs, now = Date.now()) {
    this.maxAgeMs = maxAgeMs
    return this.prune(now)
  }

  upsert(post, observedAt = Date.now()) {
    this.prune(observedAt)
    this.posts.delete(post.id)
    this.posts.set(post.id, { ...post, observedAt })
    while (this.posts.size > this.limit) {
      this.posts.delete(this.posts.keys().next().value)
    }
  }

  remove(id) {
    return this.posts.delete(id)
  }

  prune(now = Date.now()) {
    const cutoff = now - this.maxAgeMs
    let changed = false
    for (const [id, post] of this.posts) {
      if (post.observedAt >= cutoff) break
      this.posts.delete(id)
      changed = true
    }
    return changed
  }

  postsForWord(word) {
    return [...this.posts.values()].filter((post) => post.tokens.includes(word))
  }

  clear() {
    this.posts.clear()
  }
}

export function loadBaseline(payload) {
  return new Map(payload.words.map(([word, first, second]) => [
    word,
    second === undefined ? first : (first + second) / 2,
  ]))
}

export function percentage(count, occurrenceCount) {
  return occurrenceCount ? count / occurrenceCount * 100 : 0
}

export function makeSnapshot(sample, capturedAt = new Date().toISOString(), maximumWords = 2_000) {
  const words = Object.fromEntries([...sample.words]
    .filter(([word]) => isCandidateWord(word))
    .sort(([, left], [, right]) => right.occurrences - left.occurrences || right.lastSeenAt - left.lastSeenAt)
    .slice(0, maximumWords)
    .map(([word, entry]) => [word, {
      occurrences: entry.occurrences,
      frequency: percentage(entry.occurrences, sample.occurrenceCount),
    }]))
  return {
    id: capturedAt,
    capturedAt,
    words,
  }
}

export function rankLiveWords(sample, baseline, options = {}) {
  const { limit = 50, minimumOccurrences = 3, snapshot = null } = options
  if (sample.occurrenceCount === 0) return []

  const rows = []

  for (const [word, entry] of sample.words) {
    const count = entry.occurrences
    if (!isCandidateWord(word) || count < minimumOccurrences) continue

    const livePercent = percentage(count, sample.occurrenceCount)
    const referencePercent = snapshot
      ? Number(snapshot.words?.[word]?.frequency ?? percentage(Number(snapshot.counts?.[word] ?? 0), snapshot.tokenCount ?? 0))
      : (baseline.get(word) ?? 0) / 10_000
    const liveFloor = percentage(0.5, sample.occurrenceCount)
    const referenceFloor = snapshot
      ? Math.max(liveFloor, 0.000001)
      : 0.000001
    const lift = Math.log2((livePercent + liveFloor) / (referencePercent + referenceFloor))

    rows.push({
      word,
      count,
      livePercent,
      referencePercent,
      lift,
      multiple: referencePercent ? livePercent / referencePercent : null,
      score: Math.max(0, lift) * Math.sqrt(count),
      isUnseen: referencePercent === 0,
    })
  }

  return rows
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit)
}

export function postUri(event) {
  return `at://${event.did}/app.bsky.feed.post/${event.rkey}`
}

export function unwrapJetstreamEvent(message) {
  if (message?.$type === 'message') return message.payload
  return message
}
