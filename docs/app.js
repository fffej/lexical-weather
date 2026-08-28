import {
  DEFAULT_STOP_WORDS,
  EntityDictionary,
  FirehosePostSample,
  STOP_WORDS,
  addStopWord,
  countEntityTypes,
  extractEntities,
  postUri,
  rankEntities,
  removeStopWord,
  unwrapJetstreamEvent,
} from './analysis.js'

const ENDPOINTS = [
  'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
]
const CUSTOM_STOP_KEY = 'lexical-weather-custom-stop-words-v1'
const MAX_DRAWER_POSTS = 50
const MAX_POST_SAMPLES = 250

const elements = Object.fromEntries([
  'connection', 'connection-label', 'entity-count', 'mention-count', 'post-rate', 'freshness',
  'sample-age', 'pause-button', 'reset-button', 'control-status', 'word-table-body', 'empty-state',
  'stop-count', 'custom-stop-list', 'custom-stop-empty', 'built-in-stop-list',
  'person-count', 'place-count', 'organization-count', 'thing-count',
].map((id) => [id, document.getElementById(id)]))

const savedStopWords = loadCustomStopWords()
for (const value of savedStopWords) addStopWord(value)

const state = {
  dictionary: new EntityDictionary(Number(elements['sample-age'].value)),
  postSample: new FirehosePostSample(MAX_POST_SAMPLES, Number(elements['sample-age'].value)),
  customStopWords: new Set(savedStopWords),
  activeEntity: null,
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
      ? saved.filter((value) => typeof value === 'string' && value.trim())
      : []
  } catch {
    return []
  }
}

function saveCustomStopWords() {
  try {
    localStorage.setItem(CUSTOM_STOP_KEY, JSON.stringify([...state.customStopWords].sort()))
  } catch (error) {
    elements['control-status'].textContent = `Could not save in this browser: ${error.message}`
  }
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
  const entities = extractEntities(record.text)
  const post = {
    id,
    did: event.did,
    rkey: commit.rkey,
    text: record.text,
    entityKeys: [...new Set(entities.map((entity) => entity.key))],
    createdAt: record.createdAt,
  }
  state.dictionary.observe(entities, now, id)
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
  return new Intl.NumberFormat('en', {
    notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1,
  }).format(value)
}

function makeCell(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function ignoreEntity(key, label) {
  addStopWord(key)
  state.customStopWords.add(key)
  state.activeEntity = null
  state.activePostIndex = 0
  state.activePostId = null
  saveCustomStopWords()
  renderStopList()
  renderEntities()
  elements['control-status'].textContent = `“${label}” added to your stop list.`
}

function restoreEntity(key) {
  state.customStopWords.delete(key)
  removeStopWord(key)
  saveCustomStopWords()
  renderStopList()
  renderEntities()
  elements['control-status'].textContent = `“${key}” restored to What’s hot.`
}

function renderStopList() {
  elements['stop-count'].textContent = `${STOP_WORDS.size} entries`
  elements['built-in-stop-list'].textContent = [...DEFAULT_STOP_WORDS].sort().join(' · ')
  elements['custom-stop-list'].replaceChildren()
  const customValues = [...state.customStopWords].sort()
  elements['custom-stop-empty'].hidden = customValues.length > 0
  for (const value of customValues) {
    const button = makeCell('button', 'stop-chip', value)
    button.type = 'button'
    button.title = `Restore “${value}”`
    button.setAttribute('aria-label', `Restore ${value} to What’s hot`)
    button.addEventListener('click', () => restoreEntity(value))
    elements['custom-stop-list'].append(button)
  }
}

function postsForEntity(key) {
  return state.postSample.postsForEntity(key).slice(-MAX_DRAWER_POSTS).reverse()
}

function postUrl(post) {
  return `https://bsky.app/profile/${encodeURIComponent(post.did)}/post/${encodeURIComponent(post.rkey)}`
}

function makeEntityDrawer(row) {
  const posts = postsForEntity(row.key)
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
    : 'No posts remain in the recent drill-down sample')
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
    renderEntities()
  })
  const next = makeCell('button', '', '→')
  next.type = 'button'
  next.title = 'Next post'
  next.setAttribute('aria-label', 'Next matching post')
  next.disabled = state.activePostIndex >= posts.length - 1
  next.addEventListener('click', () => {
    state.activePostIndex += 1
    state.activePostId = posts[state.activePostIndex]?.id ?? null
    renderEntities()
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
    const search = makeCell('a', '', `Search “${row.label}” ↗`)
    search.href = `https://bsky.app/search?q=${encodeURIComponent(row.label)}`
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

function entityTypeLabel(type) {
  return type === 'organization' ? 'Organization' : `${type[0].toUpperCase()}${type.slice(1)}`
}

function renderEntities() {
  const rows = rankEntities(state.dictionary, { limit: 50 })
  elements['word-table-body'].replaceChildren()
  elements['empty-state'].hidden = rows.length > 0
  const maximumPosts = rows[0]?.postCount || 1

  for (const [index, row] of rows.entries()) {
    const tr = document.createElement('tr')
    tr.className = 'word-row'
    tr.classList.toggle('expanded', state.activeEntity === row.key)
    const entityCell = document.createElement('td')
    entityCell.className = 'word-cell'
    const line = document.createElement('div')
    line.className = 'word-line'
    line.append(makeCell('span', 'rank', String(index + 1).padStart(2, '0')))
    const entityButton = makeCell('button', 'word', row.label)
    entityButton.type = 'button'
    entityButton.title = `Show recent posts mentioning “${row.label}”`
    entityButton.setAttribute('aria-expanded', String(state.activeEntity === row.key))
    entityButton.addEventListener('click', () => {
      state.activeEntity = state.activeEntity === row.key ? null : row.key
      state.activePostIndex = 0
      state.activePostId = null
      renderEntities()
    })
    line.append(entityButton)
    const ignore = makeCell('button', 'ignore-word', 'Ignore')
    ignore.type = 'button'
    ignore.title = `Add “${row.label}” to your stop list`
    ignore.addEventListener('click', () => ignoreEntity(row.key, row.label))
    line.append(ignore)
    const track = document.createElement('div')
    track.className = 'signal-track'
    const fill = document.createElement('span')
    fill.className = `signal-fill type-${row.type}`
    fill.style.width = `${Math.max(2, row.postCount / maximumPosts * 100)}%`
    track.append(fill)
    entityCell.append(line, track)
    tr.append(entityCell)
    tr.append(makeCell('td', `entity-type type-${row.type}`, entityTypeLabel(row.type)))
    const posts = makeCell('td', 'rate', compactNumber(row.postCount))
    posts.title = `${row.postPercent.toFixed(2)}% of accepted posts in this window`
    tr.append(posts)
    tr.append(makeCell('td', 'rate', compactNumber(row.mentionCount)))
    elements['word-table-body'].append(tr)
    if (state.activeEntity === row.key) elements['word-table-body'].append(makeEntityDrawer(row))
  }
}

function renderMetrics() {
  const now = Date.now()
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  elements['entity-count'].textContent = compactNumber(state.dictionary.entities.size)
  elements['mention-count'].textContent = compactNumber(state.dictionary.mentionCount)
  const counts = countEntityTypes(state.dictionary)
  elements['person-count'].textContent = compactNumber(counts.person)
  elements['place-count'].textContent = compactNumber(counts.place)
  elements['organization-count'].textContent = compactNumber(counts.organization)
  elements['thing-count'].textContent = compactNumber(counts.thing)
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
  renderEntities()
}

elements['sample-age'].addEventListener('change', () => {
  const maxAgeMs = Number(elements['sample-age'].value)
  state.dictionary.setMaxAge(maxAgeMs)
  state.postSample.setMaxAge(maxAgeMs)
  render()
})
elements['reset-button'].addEventListener('click', () => {
  state.dictionary.clear()
  state.postSample.clear()
  state.intakeTimes.length = 0
  state.activeEntity = null
  state.activePostIndex = 0
  state.activePostId = null
  elements['control-status'].textContent = 'Live entity sample cleared. Your stop list remains.'
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
  const dictionaryChanged = state.dictionary.prune(now)
  const postSampleChanged = state.postSample.prune(now)
  if (dictionaryChanged || postSampleChanged) render()
  else renderMetrics()
}, 1000)
renderStopList()
render()
connect()
