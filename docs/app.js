import {
  DEFAULT_STOP_WORDS,
  FirehosePostSample,
  FrequencyDictionary,
  STOP_WORDS,
  addStopWord,
  loadBaseline,
  makeSnapshot,
  postUri,
  rankLiveWords,
  removeStopWord,
  tokenize,
  unwrapJetstreamEvent,
} from './analysis.js'

const ENDPOINTS = [
  'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
]
const SNAPSHOT_KEY = 'lexical-weather-snapshots-v1'
const CUSTOM_STOP_KEY = 'lexical-weather-custom-stop-words-v1'
const MAX_SNAPSHOTS = 8
const MAX_DRAWER_POSTS = 50
const MAX_POST_SAMPLES = 250

const elements = Object.fromEntries([
  'connection', 'connection-label', 'word-count', 'occurrence-count', 'post-rate', 'freshness',
  'sample-age', 'capture-button', 'capture-status', 'pause-button',
  'reset-button', 'loading-card', 'loading-message', 'word-table-wrap', 'word-table-body',
  'empty-state', 'comparison-label', 'reference-heading', 'historical-button', 'snapshot-list',
  'stop-count', 'custom-stop-list', 'custom-stop-empty', 'built-in-stop-list',
].map((id) => [id, document.getElementById(id)]))

const savedStopWords = loadCustomStopWords()
for (const word of savedStopWords) addStopWord(word)

const state = {
  baseline: new Map(),
  baselineReady: false,
  frequency: new FrequencyDictionary(Number(elements['sample-age'].value)),
  postSample: new FirehosePostSample(MAX_POST_SAMPLES, Number(elements['sample-age'].value)),
  snapshots: loadSnapshots(),
  activeSnapshotId: null,
  customStopWords: new Set(savedStopWords),
  activeWord: null,
  activePostIndex: 0,
  activePostId: null,
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  shouldRun: true,
  lastSeq: 0,
  lastPostAt: 0,
  intakeTimes: [],
  renderTimer: null,
}

function loadCustomStopWords() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_STOP_KEY) ?? '[]')
    return Array.isArray(saved)
      ? saved.filter((word) => typeof word === 'string' && word.trim())
      : []
  } catch {
    return []
  }
}

function saveCustomStopWords() {
  try {
    localStorage.setItem(CUSTOM_STOP_KEY, JSON.stringify([...state.customStopWords].sort()))
  } catch (error) {
    elements['capture-status'].textContent = `Could not save in this browser: ${error.message}`
  }
}

function loadSnapshots() {
  try {
    const saved = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? '[]')
    if (!Array.isArray(saved)) return []
    return saved.map((item) => {
      if (item?.id && item?.words) return item
      if (!item?.id || !item?.tokenCount || !item?.counts) return null
      return {
        id: item.id,
        capturedAt: item.capturedAt ?? item.id,
        words: Object.fromEntries(Object.entries(item.counts).map(([word, occurrences]) => [word, {
          occurrences: Number(occurrences),
          frequency: Number(occurrences) / item.tokenCount * 100,
        }])),
      }
    }).filter(Boolean)
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
    if (state.postSample.remove(id)) scheduleRender()
    return
  }
  const record = commit.record
  if (!record || typeof record.text !== 'string' || !acceptsLanguage(record)) {
    if (commit.operation === 'update' && state.postSample.remove(id)) scheduleRender()
    return
  }

  const now = Date.now()
  const post = {
    id,
    did: event.did,
    rkey: commit.rkey,
    text: record.text,
    tokens: tokenize(record.text),
    createdAt: record.createdAt,
  }
  state.frequency.observe(post.tokens, now)
  state.postSample.upsert(post, now)
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

function ignoreWord(word) {
  addStopWord(word)
  state.customStopWords.add(word)
  state.activeWord = null
  state.activePostIndex = 0
  state.activePostId = null
  saveCustomStopWords()
  renderStopList()
  renderWords()
  elements['capture-status'].textContent = `“${word}” added to your stop list.`
}

function restoreWord(word) {
  state.customStopWords.delete(word)
  removeStopWord(word)
  saveCustomStopWords()
  renderStopList()
  renderWords()
  elements['capture-status'].textContent = `“${word}” restored to What’s hot.`
}

function renderStopList() {
  elements['stop-count'].textContent = `${STOP_WORDS.size} words`
  elements['built-in-stop-list'].textContent = [...DEFAULT_STOP_WORDS].sort().join(' · ')
  elements['custom-stop-list'].replaceChildren()
  const customWords = [...state.customStopWords].sort()
  elements['custom-stop-empty'].hidden = customWords.length > 0
  for (const word of customWords) {
    const button = makeCell('button', 'stop-chip', word)
    button.type = 'button'
    button.title = `Restore “${word}”`
    button.setAttribute('aria-label', `Restore ${word} to What’s hot`)
    button.addEventListener('click', () => restoreWord(word))
    elements['custom-stop-list'].append(button)
  }
}

function postsForWord(word) {
  return state.postSample.postsForWord(word)
    .slice(-MAX_DRAWER_POSTS)
    .reverse()
}

function postUrl(post) {
  return `https://bsky.app/profile/${encodeURIComponent(post.did)}/post/${encodeURIComponent(post.rkey)}`
}

function makeWordDrawer(word) {
  const posts = postsForWord(word)
  const preservedIndex = posts.findIndex((post) => post.id === state.activePostId)
  if (preservedIndex >= 0) state.activePostIndex = preservedIndex
  state.activePostIndex = Math.min(state.activePostIndex, Math.max(0, posts.length - 1))
  const post = posts[state.activePostIndex]
  state.activePostId = post?.id ?? null
  const detailRow = document.createElement('tr')
  detailRow.className = 'word-detail-row'
  const cell = document.createElement('td')
  cell.colSpan = 4
  const drawer = document.createElement('div')
  drawer.className = 'word-drawer'

  const top = document.createElement('div')
  top.className = 'drawer-top'
  const label = makeCell('span', 'drawer-position', post
    ? `Post ${state.activePostIndex + 1} of ${posts.length}${posts.length === MAX_DRAWER_POSTS ? ' most recent' : ''}`
    : 'No posts remain in the current sample')
  const navigation = document.createElement('div')
  navigation.className = 'drawer-navigation'
  const previous = makeCell('button', '', '←')
  previous.type = 'button'
  previous.title = 'Previous post'
  previous.setAttribute('aria-label', 'Previous matching post')
  previous.disabled = state.activePostIndex === 0
  previous.addEventListener('click', () => {
    state.activePostIndex -= 1
    state.activePostId = posts[state.activePostIndex]?.id ?? null
    renderWords()
  })
  const next = makeCell('button', '', '→')
  next.type = 'button'
  next.title = 'Next post'
  next.setAttribute('aria-label', 'Next matching post')
  next.disabled = state.activePostIndex >= posts.length - 1
  next.addEventListener('click', () => {
    state.activePostIndex += 1
    state.activePostId = posts[state.activePostIndex]?.id ?? null
    renderWords()
  })
  navigation.append(previous, next)
  top.append(label, navigation)
  drawer.append(top)

  if (post) {
    drawer.append(makeCell('p', 'drawer-post-text', post.text.replaceAll(/\s+/g, ' ').trim()))
    const meta = document.createElement('div')
    meta.className = 'drawer-meta'
    const time = post.createdAt ? new Date(post.createdAt) : new Date()
    meta.append(makeCell('span', '', `${time.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${post.did}`))
    const links = document.createElement('span')
    const open = makeCell('a', '', 'Open post ↗')
    open.href = postUrl(post)
    open.target = '_blank'
    open.rel = 'noreferrer'
    const search = makeCell('a', '', `Search “${word}” ↗`)
    search.href = `https://bsky.app/search?q=${encodeURIComponent(word)}`
    search.target = '_blank'
    search.rel = 'noreferrer'
    links.append(open, search)
    meta.append(links)
    drawer.append(meta)
  }
  cell.append(drawer)
  detailRow.append(cell)
  return detailRow
}

function renderWords() {
  if (!state.baselineReady) return
  const snapshot = activeSnapshot()
  const rows = rankLiveWords(state.frequency, state.baseline, { limit: 50, snapshot })
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
    tr.className = 'word-row'
    tr.classList.toggle('expanded', state.activeWord === row.word)
    const wordCell = document.createElement('td')
    wordCell.className = 'word-cell'
    const line = document.createElement('div')
    line.className = 'word-line'
    line.append(makeCell('span', 'rank', String(index + 1).padStart(2, '0')))
    const wordButton = makeCell('button', 'word', row.word)
    wordButton.type = 'button'
    wordButton.title = `Show posts containing “${row.word}”`
    wordButton.setAttribute('aria-expanded', String(state.activeWord === row.word))
    wordButton.addEventListener('click', () => {
      state.activeWord = state.activeWord === row.word ? null : row.word
      state.activePostIndex = 0
      state.activePostId = null
      renderWords()
    })
    line.append(wordButton)
    if (row.isUnseen) line.append(makeCell('span', 'new-badge', 'new'))
    line.append(makeCell('span', 'count', `${compactNumber(row.count)} occurrence${row.count === 1 ? '' : 's'}`))
    const ignore = makeCell('button', 'ignore-word', 'Ignore')
    ignore.type = 'button'
    ignore.title = `Add “${row.word}” to your stop list`
    ignore.addEventListener('click', () => ignoreWord(row.word))
    line.append(ignore)
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
    change.title = `${row.count} observed occurrences in the active frequency dictionary`
    tr.append(change)
    elements['word-table-body'].append(tr)
    if (state.activeWord === row.word) {
      elements['word-table-body'].append(makeWordDrawer(row.word))
    }
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
    compare.append(makeCell('span', '', `${compactNumber(Object.keys(snapshot.words).length)} tracked words`))
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

function renderMetrics() {
  const now = Date.now()
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  elements['word-count'].textContent = compactNumber(state.frequency.words.size)
  elements['occurrence-count'].textContent = compactNumber(state.frequency.occurrenceCount)
  elements['capture-button'].disabled = state.frequency.occurrenceCount === 0
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

elements['sample-age'].addEventListener('change', () => {
  const maxAgeMs = Number(elements['sample-age'].value)
  state.frequency.setMaxAge(maxAgeMs)
  state.postSample.setMaxAge(maxAgeMs)
  render()
})
elements['capture-button'].addEventListener('click', () => {
  if (!state.frequency.occurrenceCount) return
  const snapshot = makeSnapshot(state.frequency)
  state.snapshots = [snapshot, ...state.snapshots].slice(0, MAX_SNAPSHOTS)
  state.activeSnapshotId = snapshot.id
  saveSnapshots()
  elements['capture-status'].textContent = `Captured ${compactNumber(Object.keys(snapshot.words).length)} tracked words at ${formatSnapshotTime(snapshot)}.`
  renderWords()
  renderSnapshots()
})
elements['historical-button'].addEventListener('click', () => {
  state.activeSnapshotId = null
  renderWords()
  renderSnapshots()
})
elements['reset-button'].addEventListener('click', () => {
  state.frequency.clear()
  state.postSample.clear()
  state.intakeTimes.length = 0
  state.activeWord = null
  state.activePostIndex = 0
  state.activePostId = null
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

setInterval(() => {
  const now = Date.now()
  const frequencyChanged = state.frequency.prune(now)
  const postSampleChanged = state.postSample.prune(now)
  if (frequencyChanged || postSampleChanged) render()
  else renderMetrics()
}, 1000)
renderSnapshots()
renderStopList()
fetchBaseline()
connect()
