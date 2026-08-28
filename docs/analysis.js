const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,24}(?:\/\S*)?/giu
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}@#]+|[^\p{L}\p{N}]+$/gu
const TYPE_PRIORITY = { thing: 0, organization: 1, place: 2, person: 3 }

// Function words, conversational filler, post boilerplate, and profanity are excluded.
// Nouns remain available when they are part of a meaningful multi-word phrase.
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

export function normalizeEntity(value) {
  return String(value)
    .normalize('NFKC')
    .replaceAll('’', "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en')
}

export function addStopWord(value) {
  const normalized = normalizeEntity(value)
  if (!normalized) return false
  STOP_WORDS.add(normalized)
  return true
}

export function removeStopWord(value) {
  const normalized = normalizeEntity(value)
  if (DEFAULT_STOP_WORDS.has(normalized)) return false
  return STOP_WORDS.delete(normalized)
}

function cleanEntityPhrase(value) {
  return String(value)
    .normalize('NFKC')
    .replaceAll('’', "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_PUNCTUATION, '')
    .trim()
}

function isViableEntity(value) {
  const normalized = normalizeEntity(value)
  if (normalized.length < 3 || normalized.length > 80) return false
  if (/(.)\1{3}/u.test(normalized)) return false
  const words = normalized.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
  if (words.length === 0 || words.length > 6) return false
  return words.some((word) => word.length > 1 && !DEFAULT_STOP_WORDS.has(word))
}

export function isCandidateEntity(value) {
  const normalized = normalizeEntity(value)
  return isViableEntity(normalized) && !STOP_WORDS.has(normalized)
}

/** Extract people, places, organizations, and common noun phrases with Compromise. */
export function extractEntities(text, parser = globalThis.nlp) {
  if (typeof parser !== 'function') throw new Error('Compromise is not loaded')
  const document = parser(String(text).replace(URL_PATTERN, ' '))
  const entities = []
  const namedTypes = new Map()

  const add = (value, type, named = false) => {
    const label = cleanEntityPhrase(value)
    if (!isViableEntity(label)) return
    const key = normalizeEntity(label)
    const knownType = namedTypes.get(key)
    if (knownType && (!named || knownType !== type)) return
    entities.push({ key, label, type })
    if (named) namedTypes.set(key, type)
  }

  // Resolve overlaps consistently: person, then place, then organization.
  for (const label of document.people().out('array')) add(label, 'person', true)
  for (const label of document.places().out('array')) add(label, 'place', true)
  for (const label of document.organizations().out('array')) add(label, 'organization', true)

  // Keep modifiers inside noun phrases while dropping determiners and trailing clauses.
  for (const noun of document.nouns().json({ terms: true })) add(nounPhrase(noun), 'thing')

  return entities
}

function preferredLabel(forms) {
  let bestLabel = ''
  let bestCount = -1
  for (const [label, count] of forms) {
    if (count > bestCount || (count === bestCount && label.localeCompare(bestLabel) < 0)) {
      bestLabel = label
      bestCount = count
    }
  }
  return bestLabel
}

function nounPhrase(noun) {
  const terms = noun.terms ?? []
  if (terms.some((term) => term.tags?.includes('ProperNoun'))) return noun.noun?.root ?? noun.text
  let selected = terms.slice()
  while (selected[0]?.tags?.some((tag) => ['Determiner', 'Possessive', 'Pronoun'].includes(tag))) {
    selected.shift()
  }
  const prepositionAt = selected.findIndex((term) => term.tags?.includes('Preposition'))
  if (prepositionAt >= 0) selected = selected.slice(0, prepositionAt)
  return selected.map((term) => term.text).join(' ') || noun.noun?.root || noun.text
}

export class EntityDictionary {
  constructor(maxAgeMs = 5 * 60_000, options = {}) {
    this.maxAgeMs = maxAgeMs
    this.maxEntities = options.maxEntities ?? 10_000
    this.entities = new Map()
    this.postCount = 0
    this.mentionCount = 0
    this.events = []
    this.eventStart = 0
    this.postTimes = []
    this.postStart = 0
    this.postIds = new Map()
    this.nextPruneAt = 0
    this.nextEntryId = 1
  }

  setMaxAge(maxAgeMs, now = Date.now()) {
    this.maxAgeMs = maxAgeMs
    return this.prune(now, true)
  }

  observe(items, observedAt = Date.now(), postId = null) {
    this.prune(observedAt)
    if (postId && this.postIds.has(postId)) return false
    if (postId) this.postIds.set(postId, observedAt)
    this.postTimes.push({ at: observedAt, id: postId })
    this.postCount += 1

    const inPost = new Map()
    for (const item of items) {
      if (!item || !isViableEntity(item.key ?? item.label)) continue
      const key = normalizeEntity(item.key ?? item.label)
      const label = cleanEntityPhrase(item.label ?? item.key)
      const type = ['person', 'place', 'organization', 'thing'].includes(item.type) ? item.type : 'thing'
      let grouped = inPost.get(key)
      if (!grouped) {
        grouped = { key, type, mentions: 0, forms: new Map() }
        inPost.set(key, grouped)
      }
      grouped.mentions += 1
      grouped.forms.set(label, (grouped.forms.get(label) ?? 0) + 1)
    }

    for (const grouped of inPost.values()) {
      let entry = this.entities.get(grouped.key)
      if (!entry) {
        entry = {
          id: this.nextEntryId++, key: grouped.key, type: grouped.type, label: '',
          postCount: 0, mentionCount: 0, lastSeenAt: observedAt, forms: new Map(),
        }
      } else {
        this.entities.delete(grouped.key)
        if (TYPE_PRIORITY[grouped.type] > TYPE_PRIORITY[entry.type]) entry.type = grouped.type
      }
      entry.postCount += 1
      entry.mentionCount += grouped.mentions
      entry.lastSeenAt = observedAt
      for (const [label, count] of grouped.forms) {
        entry.forms.set(label, (entry.forms.get(label) ?? 0) + count)
      }
      entry.label = preferredLabel(entry.forms)
      this.entities.set(grouped.key, entry)
      this.mentionCount += grouped.mentions
      this.events.push({
        entryId: entry.id, key: grouped.key, at: observedAt,
        mentions: grouped.mentions, forms: [...grouped.forms],
      })
    }
    this.#boundEntities()
    return true
  }

  prune(now = Date.now(), force = false) {
    if (!force && now < this.nextPruneAt) return false
    this.nextPruneAt = now + Math.min(1_000, this.maxAgeMs)
    const cutoff = now - this.maxAgeMs
    let changed = false

    while (this.postTimes[this.postStart]?.at < cutoff) {
      const post = this.postTimes[this.postStart]
      this.postStart += 1
      this.postCount -= 1
      if (post.id && this.postIds.get(post.id) === post.at) this.postIds.delete(post.id)
      changed = true
    }
    while (this.events[this.eventStart]?.at < cutoff) {
      const event = this.events[this.eventStart++]
      const entry = this.entities.get(event.key)
      if (entry?.id === event.entryId) {
        entry.postCount -= 1
        entry.mentionCount -= event.mentions
        this.mentionCount -= event.mentions
        for (const [label, count] of event.forms) {
          const remaining = (entry.forms.get(label) ?? 0) - count
          if (remaining > 0) entry.forms.set(label, remaining)
          else entry.forms.delete(label)
        }
        if (entry.postCount <= 0) this.entities.delete(event.key)
        else entry.label = preferredLabel(entry.forms)
        changed = true
      }
    }
    this.#compactQueues()
    return changed
  }

  clear() {
    this.entities.clear()
    this.postCount = 0
    this.mentionCount = 0
    this.events = []
    this.eventStart = 0
    this.postTimes = []
    this.postStart = 0
    this.postIds.clear()
    this.nextPruneAt = 0
  }

  #boundEntities() {
    while (this.entities.size > this.maxEntities) {
      const key = this.entities.keys().next().value
      const entry = this.entities.get(key)
      this.mentionCount -= entry.mentionCount
      this.entities.delete(key)
    }
  }

  #compactQueues() {
    if (this.eventStart > 2_000 && this.eventStart > this.events.length / 2) {
      this.events = this.events.slice(this.eventStart)
      this.eventStart = 0
    }
    if (this.postStart > 2_000 && this.postStart > this.postTimes.length / 2) {
      this.postTimes = this.postTimes.slice(this.postStart)
      this.postStart = 0
    }
  }
}

export function rankEntities(sample, options = {}) {
  const { limit = 50, minimumPosts = 3, type = null } = options
  const rows = []
  for (const entry of sample.entities.values()) {
    if (!isCandidateEntity(entry.key) || entry.postCount < minimumPosts) continue
    if (type && entry.type !== type) continue
    rows.push({
      key: entry.key, label: entry.label, type: entry.type,
      postCount: entry.postCount, mentionCount: entry.mentionCount,
      postPercent: sample.postCount ? entry.postCount / sample.postCount * 100 : 0,
      lastSeenAt: entry.lastSeenAt,
    })
  }
  return rows
    .sort((left, right) => right.postCount - left.postCount
      || right.mentionCount - left.mentionCount
      || right.lastSeenAt - left.lastSeenAt
      || left.label.localeCompare(right.label))
    .slice(0, limit)
}

export function countEntityTypes(sample, minimumPosts = 3) {
  const counts = { person: 0, place: 0, organization: 0, thing: 0 }
  for (const entry of sample.entities.values()) {
    if (isCandidateEntity(entry.key) && entry.postCount >= minimumPosts) counts[entry.type] += 1
  }
  return counts
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
    while (this.posts.size > this.limit) this.posts.delete(this.posts.keys().next().value)
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

  postsForEntity(key) {
    return [...this.posts.values()].filter((post) => post.entityKeys.includes(key))
  }

  clear() {
    this.posts.clear()
  }
}

export function postUri(event) {
  return `at://${event.did}/app.bsky.feed.post/${event.rkey}`
}

export function unwrapJetstreamEvent(message) {
  if (message?.$type === 'message') return message.payload
  return message
}
