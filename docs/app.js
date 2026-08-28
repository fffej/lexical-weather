import { postUri, unwrapJetstreamEvent } from './analysis.js'
import { WorkerEmbedder } from './embedder.js'
import { StreamingTrendDetector } from './trends.js'

const ENDPOINTS = [
  'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents',
]
const MAX_PENDING_CANDIDATES = 100

const elements = Object.fromEntries([
  'connection', 'connection-label', 'feature-count', 'candidate-percent', 'topic-count',
  'freshness', 'pause-button', 'reset-button', 'control-status', 'word-table-body',
  'empty-state', 'post-rate', 'candidate-count', 'embedding-count', 'duplicate-count',
  'embedding-status', 'dropped-count',
].map((id) => [id, document.getElementById(id)]))

const state = {
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  shouldRun: true,
  lastSeq: 0,
  lastPostAt: 0,
  intakeTimes: [],
  renderTimer: null,
  activeTopicId: null,
  pendingCandidates: 0,
  droppedCandidates: 0,
  generation: 0,
  candidateQueue: Promise.resolve(),
  nextMaintenanceAt: 0,
}

const embedder = new WorkerEmbedder({
  onStatus: ({ status, progress }) => {
    elements['embedding-status'].textContent = status === 'ready'
      ? 'Ready'
      : `Loading${Number.isFinite(progress) ? ` ${Math.round(progress)}%` : '…'}`
  },
})
const detector = new StreamingTrendDetector((text) => embedder.embed(text))

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
  if (commit.operation === 'delete') return

  const record = commit.record
  if (!record || typeof record.text !== 'string' || !acceptsLanguage(record)) return
  const now = Date.now()
  const message = {
    id: postUri({ did: event.did, rkey: commit.rkey }),
    text: record.text,
    timestampMs: now,
    sourceId: event.did,
  }
  const lexical = detector.lexical.process(message)
  if (lexical.candidate) queueCandidate(message, lexical.normalized)

  state.lastPostAt = now
  state.intakeTimes.push(now)
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  scheduleRender()
}

function queueCandidate(message, normalized) {
  if (state.pendingCandidates >= MAX_PENDING_CANDIDATES) {
    state.droppedCandidates += 1
    return
  }
  state.pendingCandidates += 1
  const generation = state.generation
  state.candidateQueue = state.candidateQueue.then(async () => {
    try {
      const embedding = await embedder.embed(normalized)
      if (generation === state.generation) detector.semantic.observe(message, embedding)
    } catch (error) {
      elements['embedding-status'].textContent = 'Unavailable'
      elements['control-status'].textContent = `Semantic model error: ${error.message}`
    } finally {
      state.pendingCandidates -= 1
      scheduleRender()
    }
  })
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

function topicLabel(topic) {
  const sample = topic.samples[0] ?? `Topic ${topic.topicId}`
  const shortened = sample.replaceAll(/\s+/g, ' ').trim()
  return shortened.length > 76 ? `${shortened.slice(0, 73)}…` : shortened
}

function percent(value) {
  return `${Math.round(value * 100)}%`
}

function makeTopicDrawer(topic) {
  const detailRow = document.createElement('tr')
  detailRow.className = 'word-detail-row'
  const cell = document.createElement('td')
  cell.colSpan = 4
  const drawer = document.createElement('div')
  drawer.className = 'word-drawer'
  drawer.append(makeCell('p', 'drawer-position', 'Why this topic is ranked here'))
  const signals = document.createElement('dl')
  signals.className = 'trend-signals'
  for (const [label, value] of [
    ['Burst', topic.burst],
    ['Volume', topic.volume],
    ['Coherence', topic.coherence],
    ['Novelty', topic.novelty],
    ...(topic.diversity === undefined ? [] : [['Diversity', topic.diversity]]),
  ]) {
    const item = document.createElement('div')
    item.append(makeCell('dt', '', label), makeCell('dd', '', percent(value)))
    signals.append(item)
  }
  drawer.append(signals, makeCell('p', 'drawer-position', 'Representative posts'))
  for (const sample of topic.samples) {
    drawer.append(makeCell('p', 'drawer-post-text', sample.replaceAll(/\s+/g, ' ').trim()))
  }
  cell.append(drawer)
  detailRow.append(cell)
  return detailRow
}

function renderTopics() {
  const topics = detector.rank(Date.now(), 20)
  elements['word-table-body'].replaceChildren()
  elements['empty-state'].hidden = topics.length > 0
  if (!topics.some(({ topicId }) => topicId === state.activeTopicId)) state.activeTopicId = null
  const maximumScore = topics[0]?.score || 1

  for (const [index, topic] of topics.entries()) {
    const tr = document.createElement('tr')
    tr.className = 'word-row'
    tr.classList.toggle('expanded', state.activeTopicId === topic.topicId)
    const topicCell = document.createElement('td')
    topicCell.className = 'word-cell'
    const line = document.createElement('div')
    line.className = 'word-line'
    line.append(makeCell('span', 'rank', String(index + 1).padStart(2, '0')))
    const button = makeCell('button', 'word', topicLabel(topic))
    button.type = 'button'
    button.title = 'Show score components and representative posts'
    button.setAttribute('aria-expanded', String(state.activeTopicId === topic.topicId))
    button.addEventListener('click', () => {
      state.activeTopicId = state.activeTopicId === topic.topicId ? null : topic.topicId
      renderTopics()
    })
    line.append(button)
    const track = document.createElement('div')
    track.className = 'signal-track'
    const fill = document.createElement('span')
    fill.className = `signal-fill state-${topic.state.toLowerCase()}`
    fill.style.width = `${Math.max(2, topic.score / maximumScore * 100)}%`
    track.append(fill)
    topicCell.append(line, track)
    tr.append(topicCell)
    tr.append(makeCell('td', `entity-type state-${topic.state.toLowerCase()}`, topic.state))
    tr.append(makeCell('td', 'rate', compactNumber(topic.messageCount)))
    tr.append(makeCell('td', 'rate', percent(topic.score)))
    elements['word-table-body'].append(tr)
    if (state.activeTopicId === topic.topicId) {
      elements['word-table-body'].append(makeTopicDrawer(topic))
    }
  }
}

function renderMetrics() {
  const now = Date.now()
  while (state.intakeTimes[0] < now - 30_000) state.intakeTimes.shift()
  const diagnostics = detector.snapshotDiagnostics()
  elements['feature-count'].textContent = compactNumber(diagnostics.activeFeatures)
  elements['candidate-percent'].textContent = `${diagnostics.candidatePercentage.toFixed(1)}%`
  elements['topic-count'].textContent = compactNumber(diagnostics.activeTopics)
  elements['candidate-count'].textContent = compactNumber(diagnostics.candidates)
  elements['embedding-count'].textContent = compactNumber(diagnostics.embeddings)
  elements['duplicate-count'].textContent = compactNumber(diagnostics.duplicatesSuppressed)
  elements['dropped-count'].textContent = compactNumber(state.droppedCandidates)
  const observedSeconds = state.intakeTimes.length
    ? Math.min(30, Math.max(1, (now - state.intakeTimes[0]) / 1000))
    : 0
  elements['post-rate'].textContent = observedSeconds
    ? (state.intakeTimes.length / observedSeconds).toFixed(1)
    : '—'
  if (!state.lastPostAt) elements.freshness.textContent = '—'
  else {
    const seconds = Math.max(0, Math.round((now - state.lastPostAt) / 1000))
    elements.freshness.textContent = seconds < 2 ? 'now' : `${seconds}s`
  }
}

function render() {
  renderMetrics()
  renderTopics()
}

elements['reset-button'].addEventListener('click', () => {
  state.generation += 1
  detector.clear()
  state.intakeTimes.length = 0
  state.activeTopicId = null
  state.droppedCandidates = 0
  elements['control-status'].textContent = 'Trend history cleared; incoming posts are still live.'
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
  if (now >= state.nextMaintenanceAt) {
    detector.maintain(now)
    state.nextMaintenanceAt = now + 10_000
    render()
  } else renderMetrics()
}, 1_000)

render()
connect()
