import {
  SlidingPostWindow,
  loadBaseline,
  makeSnapshot,
  postUri,
  rankLiveWords,
  tokenize,
  unwrapJetstreamEvent,
} from './analysis.js'

const ENDPOINTS = [
  'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
]
const SNAPSHOT_KEY = 'lexical-weather-snapshots-v1'
const MAX_SNAPSHOTS = 8

const elements = Object.fromEntries([
  'connection', 'connection-label', 'post-count', 'token-count', 'post-rate', 'freshness',
  'window-size', 'capture-button', 'capture-status', 'pause-button',
  'reset-button', 'loading-card', 'loading-message', 'word-table-wrap', 'word-table-body',
  'empty-state', 'comparison-label', 'reference-heading', 'historical-button', 'snapshot-list',
  'post-feed',
].map((id) => [id, document.getElementById(id)]))

const state = {
  baseline: new Map(),
  baselineReady: false,
  window: new SlidingPostWindow(Number(elements['window-size'].value)),
  snapshots: loadSnapshots(),
  activeSnapshotId: null,
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  shouldRun: true,
  lastSeq: 0,
  lastPostAt: 0,
  intakeTimes: [],
  renderTimer: null,
}

function loadSnapshots() {
  try {
    const saved = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((item) => item?.id && item?.tokenCount && item?.counts) : []
  } catch {
    return []
  }
}

function saveSnapshots() {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state.snapshots))
  } catch (error) {
    elements['capture-status'].textContent = `Could not save in this browser: ${error.message}`
  }
}

function activeSnapshot() {
  return state.snapshots.find((snapshot) => snapshot.id === state.activeSnapshotId) ?? null
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
  socket.addEventListener('open', () => setConnection('Live stream', 'live'))
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

  const id = postUri({ did: event.did, rkey: commit.rkey })
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

function formatPercent(value) {
  if (value === 0) return '0%'
  return `${new Intl.NumberFormat('en', { maximumSignificantDigits: 3 }).format(value)}%`
}

function formatChange(row) {
  if (row.isUnseen) return 'NEW'
  if (row.multiple >= 100) return '100×+'
  return `${row.multiple.toFixed(row.multiple >= 10 ? 0 : 1)}×`
}

function formatSnapshotTime(snapshot, includeDate = false) {
  const date = new Date(snapshot.capturedAt)
  return new Intl.DateTimeFormat([], includeDate
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { hour: '2-digit', minute: '2-digit' }).format(date)
}

function makeCell(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function renderWords() {
  if (!state.baselineReady) return
  const snapshot = activeSnapshot()
  const rows = rankLiveWords(state.window, state.baseline, { limit: 50, snapshot })
  elements['word-table-body'].replaceChildren()
  elements['empty-state'].hidden = rows.length > 0
  elements['empty-state'].querySelector('p').textContent = snapshot
    ? 'No meaningful rise since this snapshot yet.'
    : 'Building a reliable signal…'
  elements['comparison-label'].textContent = snapshot
    ? `Snapshot · ${formatSnapshotTime(snapshot, true)}`
    : 'Historical English · 1900–1999'
  elements['reference-heading'].textContent = snapshot ? 'Snapshot' : 'Historical'
  elements['historical-button'].hidden = !snapshot
  const maximumScore = rows[0]?.score || 1

  rows.forEach((row, index) => {
    const tr = document.createElement('tr')
    const wordCell = document.createElement('td')
    wordCell.className = 'word-cell'
    const line = document.createElement('div')
    line.className = 'word-line'
    line.append(makeCell('span', 'rank', String(index + 1).padStart(2, '0')))
    const link = makeCell('a', 'word', row.word)
    link.href = `https://bsky.app/search?q=${encodeURIComponent(row.word)}`
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.title = `Search Bluesky for “${row.word}”`
    line.append(link)
    if (row.isUnseen) line.append(makeCell('span', 'new-badge', 'new'))
    line.append(makeCell('span', 'count', `${row.posts} posts`))
    const track = document.createElement('div')
    track.className = 'signal-track'
    const fill = document.createElement('span')
    fill.className = 'signal-fill'
    fill.style.width = `${Math.max(2, row.score / maximumScore * 100)}%`
    track.append(fill)
    wordCell.append(line, track)
    tr.append(wordCell)
    tr.append(makeCell('td', 'rate', formatPercent(row.livePercent)))
    tr.append(makeCell('td', 'rate reference-rate', formatPercent(row.referencePercent)))
    const change = makeCell('td', `lift ${row.isUnseen ? 'new' : 'positive'}`, formatChange(row))
    change.title = `${row.count} mentions across ${row.posts} posts by ${row.authors} authors`
    tr.append(change)
    elements['word-table-body'].append(tr)
  })
}

function renderSnapshots() {
  const list = elements['snapshot-list']
  list.replaceChildren()
  if (!state.snapshots.length) {
    list.append(makeCell('p', 'snapshot-empty', 'No snapshots yet. Let the sample build, then capture one.'))
    return
  }
  for (const snapshot of state.snapshots) {
    const item = document.createElement('div')
    item.className = 'snapshot-item'
    item.classList.toggle('active', snapshot.id === state.activeSnapshotId)
    const compare = document.createElement('button')
    compare.className = 'snapshot-compare'
    compare.type = 'button'
    compare.append(makeCell('strong', '', formatSnapshotTime(snapshot, true)))
    compare.append(makeCell('span', '', `${compactNumber(snapshot.postCount)} posts · ${compactNumber(snapshot.tokenCount)} words`))
    compare.addEventListener('click', () => {
      state.activeSnapshotId = snapshot.id
      renderWords()
      renderSnapshots()
    })
    const remove = makeCell('button', 'snapshot-delete', '×')
    remove.type = 'button'
    remove.title = 'Delete snapshot'
    remove.setAttribute('aria-label', `Delete snapshot from ${formatSnapshotTime(snapshot, true)}`)
    remove.addEventListener('click', () => {
      state.snapshots = state.snapshots.filter((candidate) => candidate.id !== snapshot.id)
      if (state.activeSnapshotId === snapshot.id) state.activeSnapshotId = null
      saveSnapshots()
      renderWords()
      renderSnapshots()
    })
    item.append(compare, remove)
    list.append(item)
  }
}

function renderFeed() {
  const posts = state.window.posts.slice(-5).reverse()
  if (!posts.length) {
    elements['post-feed'].replaceChildren(makeCell('p', 'feed-placeholder', 'Live posts will appear here.'))
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
  elements['capture-button'].disabled = state.window.tokenCount === 0
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
    state.baseline = loadBaseline(await response.json())
    state.baselineReady = true
    elements['loading-card'].hidden = true
    elements['word-table-wrap'].hidden = false
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
elements['capture-button'].addEventListener('click', () => {
  if (!state.window.tokenCount) return
  const snapshot = makeSnapshot(state.window)
  state.snapshots = [snapshot, ...state.snapshots].slice(0, MAX_SNAPSHOTS)
  state.activeSnapshotId = snapshot.id
  saveSnapshots()
  elements['capture-status'].textContent = `Captured ${compactNumber(snapshot.tokenCount)} words at ${formatSnapshotTime(snapshot)}.`
  renderWords()
  renderSnapshots()
})
elements['historical-button'].addEventListener('click', () => {
  state.activeSnapshotId = null
  renderWords()
  renderSnapshots()
})
elements['reset-button'].addEventListener('click', () => {
  state.window.clear()
  state.intakeTimes.length = 0
  elements['capture-status'].textContent = 'Live sample cleared. Saved snapshots remain.'
  render()
})
elements['pause-button'].addEventListener('click', () => {
  state.shouldRun = !state.shouldRun
  elements['pause-button'].textContent = state.shouldRun ? 'Pause' : 'Resume'
  if (state.shouldRun) connect()
  else {
    clearTimeout(state.reconnectTimer)
    state.socket?.close()
    setConnection('Paused', 'paused')
  }
})

setInterval(renderMetrics, 1000)
renderSnapshots()
fetchBaseline()
connect()
