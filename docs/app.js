import {
  SlidingPostWindow,
  loadBaseline,
  postUri,
  rankHistoricalWords,
  rankLiveWords,
  tokenize,
  unwrapJetstreamEvent,
} from './analysis.js'

const ENDPOINTS = [
  'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
]

const elements = Object.fromEntries([
  'connection', 'connection-label', 'post-count', 'token-count', 'post-rate', 'freshness',
  'window-size', 'minimum-count', 'comparison-period', 'language-filter', 'word-search',
  'include-stop-words', 'pause-button', 'reset-button', 'loading-card', 'loading-message',
  'word-table-wrap', 'word-table-body', 'empty-state', 'historical-movers', 'post-feed',
].map((id) => [id, document.getElementById(id)]))

const state = {
  baseline: new Map(),
  historicalVocabulary: null,
  baselineReady: false,
  window: new SlidingPostWindow(Number(elements['window-size'].value)),
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  shouldRun: true,
  lastSeq: 0,
  lastPostAt: 0,
  intakeTimes: [],
  renderTimer: null,
  historicalDirection: 'rising',
}

function setConnection(label, status) {
  elements.connection.dataset.state = status
  elements['connection-label'].textContent = label
}

function socketUrl() {
  const endpoint = ENDPOINTS[state.reconnectAttempt % ENDPOINTS.length]
  const url = new URL(endpoint)
  url.searchParams.append('kinds', 'commit')
  url.searchParams.append('collections', 'app.bsky.feed.post')
  if (state.lastSeq) url.searchParams.set('cursor', String(state.lastSeq))
  return url
}

function connect() {
  if (!state.shouldRun) return
  clearTimeout(state.reconnectTimer)
  setConnection(state.reconnectAttempt ? 'Reconnecting' : 'Connecting', 'connecting')

  const socket = new WebSocket(socketUrl())
  state.socket = socket
  socket.addEventListener('open', () => {
    setConnection('Live stream', 'live')
  })
  socket.addEventListener('message', ({ data }) => {
    try {
      handleEvent(unwrapJetstreamEvent(JSON.parse(data)))
    } catch (error) {
      console.warn('Ignored an unreadable Jetstream event', error)
    }
  })
  socket.addEventListener('error', () => socket.close())
  socket.addEventListener('close', () => {
    if (state.socket !== socket || !state.shouldRun) return
    state.reconnectAttempt += 1
    const delay = Math.min(30_000, 750 * 2 ** Math.min(state.reconnectAttempt, 5))
    setConnection(`Retrying in ${Math.ceil(delay / 1000)}s`, 'offline')
    state.reconnectTimer = setTimeout(connect, delay)
  })
}

function acceptsLanguage(record) {
  if (elements['language-filter'].value === 'all') return true
  if (!Array.isArray(record.langs) || record.langs.length === 0) return true
  return record.langs.some((lang) => String(lang).toLowerCase().startsWith('en'))
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return
  const type = String(event.$type ?? '')
  if (!type.endsWith('#commit') && event.kind !== 'commit') return

  const commit = event.commit ?? event
  if (commit.collection !== 'app.bsky.feed.post') return
  const seq = Number(event.seq ?? event.cursor ?? 0)
  if (seq && seq <= state.lastSeq) return
  if (seq) state.lastSeq = seq
  state.reconnectAttempt = 0

  const normalized = { did: event.did, rkey: commit.rkey }
  const id = postUri(normalized)
  if (commit.operation === 'delete') {
    if (state.window.remove(id)) scheduleRender()
    return
  }

  const record = commit.record
  if (!record || typeof record.text !== 'string' || !acceptsLanguage(record)) {
    if (commit.operation === 'update' && state.window.remove(id)) scheduleRender()
    return
  }

  const now = Date.now()
  state.window.upsert({
    id,
    did: event.did,
    rkey: commit.rkey,
    text: record.text,
    tokens: tokenize(record.text),
    createdAt: record.createdAt,
  })
  state.lastPostAt = now
  state.intakeTimes.push(now)
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  scheduleRender()
}

function scheduleRender() {
  if (state.renderTimer) return
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null
    render()
  }, 450)
}

function compactNumber(value) {
  return new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function ppm(value) {
  if (value >= 1000) return compactNumber(Math.round(value))
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function liftText(lift, baseline, unseen = false) {
  if (unseen || baseline === 0) return 'NEW'
  return `${lift >= 0 ? '+' : ''}${lift.toFixed(1)}b`
}

function makeCell(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function renderWords() {
  if (!state.baselineReady) return
  const rows = rankLiveWords(state.window, state.baseline, {
    minimumCount: Number(elements['minimum-count'].value),
    includeStopWords: elements['include-stop-words'].checked,
    query: elements['word-search'].value,
    comparison: elements['comparison-period'].value,
    limit: 40,
  })
  elements['word-table-body'].replaceChildren()
  elements['empty-state'].hidden = rows.length > 0
  const maximumScore = rows[0]?.score || 1

  rows.forEach((row, index) => {
    const tr = document.createElement('tr')
    const wordCell = document.createElement('td')
    wordCell.className = 'word-cell'
    const line = document.createElement('div')
    line.className = 'word-line'
    line.append(makeCell('span', 'rank', String(index + 1).padStart(2, '0')))
    line.append(makeCell('span', 'word', row.word))
    if (row.isUnseen) line.append(makeCell('span', 'new-badge', 'new'))
    line.append(makeCell('span', 'count', `${row.count}×`))
    const track = document.createElement('div')
    track.className = 'signal-track'
    const fill = document.createElement('span')
    fill.className = 'signal-fill'
    fill.style.width = `${Math.max(2, row.score / maximumScore * 100)}%`
    track.append(fill)
    wordCell.append(line, track)
    tr.append(wordCell)
    tr.append(makeCell('td', 'rate', ppm(row.livePpm)))

    const early = makeCell('td', `lift ${row.earlyLift >= 0 ? 'positive' : 'negative'} ${row.earlyPpm === 0 ? 'new' : ''}`, liftText(row.earlyLift, row.earlyPpm))
    early.title = row.earlyPpm ? `${(2 ** row.earlyLift).toFixed(1)}× the 1900–1949 rate` : 'Not present in the reference vocabulary for this period'
    const late = makeCell('td', `lift ${row.lateLift >= 0 ? 'positive' : 'negative'} ${row.latePpm === 0 ? 'new' : ''}`, liftText(row.lateLift, row.latePpm))
    late.title = row.latePpm ? `${(2 ** row.lateLift).toFixed(1)}× the 1950–1999 rate` : 'Not present in the reference vocabulary for this period'
    tr.append(early, late)
    elements['word-table-body'].append(tr)
  })
}

function renderHistorical() {
  if (!state.baselineReady) return
  const rows = rankHistoricalWords(state.baseline, state.historicalDirection, 12, state.historicalVocabulary)
  const maximum = Math.max(...rows.map((row) => Math.abs(row.score)), 1)
  const list = elements['historical-movers']
  list.dataset.direction = state.historicalDirection
  list.replaceChildren()
  for (const row of rows) {
    const item = document.createElement('li')
    item.append(makeCell('span', 'mover-word', row.word))
    const track = document.createElement('span')
    track.className = 'mover-track'
    const fill = document.createElement('span')
    fill.style.width = `${Math.abs(row.score) / maximum * 100}%`
    track.append(fill)
    item.append(track)
    item.append(makeCell('span', 'mover-lift', `${row.lift >= 0 ? '+' : ''}${row.lift.toFixed(1)}b`))
    list.append(item)
  }
}

function renderFeed() {
  const posts = state.window.posts.slice(-5).reverse()
  if (!posts.length) {
    const placeholder = makeCell('p', 'feed-placeholder', 'Live posts will appear here.')
    elements['post-feed'].replaceChildren(placeholder)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const post of posts) {
    const link = document.createElement('a')
    link.className = 'post-item'
    link.href = `https://bsky.app/profile/${encodeURIComponent(post.did)}/post/${encodeURIComponent(post.rkey)}`
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.append(makeCell('p', '', post.text.replaceAll(/\s+/g, ' ').trim()))
    const time = post.createdAt ? new Date(post.createdAt) : new Date()
    link.append(makeCell('span', '', `${post.tokens.length} words · ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`))
    fragment.append(link)
  }
  elements['post-feed'].replaceChildren(fragment)
}

function renderMetrics() {
  const now = Date.now()
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  elements['post-count'].textContent = compactNumber(state.window.posts.length)
  elements['token-count'].textContent = compactNumber(state.window.tokenCount)
  const observedSeconds = state.intakeTimes.length
    ? Math.min(30, Math.max(1, (now - state.intakeTimes[0]) / 1000))
    : 0
  elements['post-rate'].textContent = observedSeconds ? (state.intakeTimes.length / observedSeconds).toFixed(1) : '—'
  if (!state.lastPostAt) elements.freshness.textContent = '—'
  else {
    const seconds = Math.max(0, Math.round((now - state.lastPostAt) / 1000))
    elements.freshness.textContent = seconds < 2 ? 'now' : `${seconds}s`
  }
}

function render() {
  renderMetrics()
  renderWords()
  renderFeed()
}

async function fetchBaseline() {
  try {
    const response = await fetch('./data/baseline.json')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    state.baseline = loadBaseline(payload)
    state.historicalVocabulary = new Set(payload.historicalVocabulary ?? [])
    state.baselineReady = true
    elements['loading-card'].hidden = true
    elements['word-table-wrap'].hidden = false
    renderHistorical()
    render()
  } catch (error) {
    elements['loading-message'].textContent = `Could not load the historical baseline: ${error.message}`
    document.querySelector('.loading-line').style.background = 'var(--coral)'
  }
}

elements['window-size'].addEventListener('change', () => {
  state.window.setLimit(Number(elements['window-size'].value))
  render()
})
for (const id of ['minimum-count', 'comparison-period', 'include-stop-words']) {
  elements[id].addEventListener('change', renderWords)
}
elements['word-search'].addEventListener('input', renderWords)
elements['language-filter'].addEventListener('change', () => {
  state.window.clear()
  state.intakeTimes.length = 0
  render()
})
elements['reset-button'].addEventListener('click', () => {
  state.window.clear()
  state.intakeTimes.length = 0
  render()
})
elements['pause-button'].addEventListener('click', () => {
  state.shouldRun = !state.shouldRun
  elements['pause-button'].textContent = state.shouldRun ? 'Pause stream' : 'Resume stream'
  if (state.shouldRun) connect()
  else {
    clearTimeout(state.reconnectTimer)
    state.socket?.close()
    setConnection('Paused', 'paused')
  }
})
document.querySelectorAll('[data-direction]').forEach((button) => {
  button.addEventListener('click', () => {
    state.historicalDirection = button.dataset.direction
    document.querySelectorAll('[data-direction]').forEach((candidate) => candidate.classList.toggle('active', candidate === button))
    renderHistorical()
  })
})

setInterval(renderMetrics, 1000)
fetchBaseline()
connect()
