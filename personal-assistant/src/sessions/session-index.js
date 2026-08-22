import { deriveFriendlyName } from './friendly-name.js'

const MAX_RECENT_TOOL_RESULTS = 10
const PR_URL_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/

function messageText(message) {
  return (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

// Live index of every Harness session except the assistant's own control
// session. Record logic is ctx-free: the runtime wires ctx events to the
// note* methods, tests drive them directly. Persisted fields (customName,
// repo, branch, task, and prNumber round-trip through the injected store.
export class SessionIndex {
  constructor({ excludeSessionId, now, store } = {}) {
    this.excludeSessionId = excludeSessionId
    this.now = now ?? (() => Date.now())
    this.store = store
    this.records = new Map()
  }

  noteAgentCreated({ agent }) {
    const sessionId = String(agent.id)
    if (sessionId === this.excludeSessionId) return
    const persisted = this.store?.state.sessions[sessionId] ?? {}
    const cwd = agent.session?.header?.cwd
    const record = {
      sessionId,
      friendlyName: undefined,
      customName: persisted.customName,
      cwd,
      repo: persisted.repo ?? (cwd === undefined ? undefined : basename(cwd)),
      branch: persisted.branch,
      prNumber: persisted.prNumber,
      status: agent.status ?? 'idle',
      lastActivityAt: this.now(),
      currentTask: persisted.currentTask,
      terminalIds: [],
      task: persisted.task,
      lastAssistantText: undefined,
      lastAssistantSeq: undefined,
      recentToolResults: [],
    }
    record.friendlyName = this.assignName(record)
    this.records.set(sessionId, record)
    this.persist(record)
  }

  noteAgentStatus({ agent, status }) {
    const sessionId = String(agent.id)
    if (sessionId === this.excludeSessionId) return
    const record = this.records.get(sessionId)
    if (!record) {
      this.noteAgentCreated({ agent })
      return this.noteAgentStatus({ agent, status })
    }
    record.status = status
    record.lastActivityAt = this.now()
  }

  noteAgentDisposed({ agent }) {
    this.records.delete(String(agent.id))
  }

  // session/event feed: captures the first user task, the latest assistant
  // text (for idle classification), recent tool results, and PR references.
  noteSessionEvent(session, event) {
    const sessionId = String(session.id)
    if (sessionId === this.excludeSessionId) return
    const record = this.records.get(sessionId)
    if (!record) return

    if (event.type === 'user/message') {
      record.recentToolResults = []
      const text = messageText(event.data).trim()
      if (text !== '') {
        if (record.task === undefined && event.data.source?.kind === 'user') {
          record.task = text
          record.friendlyName = this.assignName(record)
        }
        record.currentTask = text.slice(0, 120)
      }
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message).trim()
      if (text !== '') {
        record.lastAssistantText = text
        record.lastAssistantSeq = event.seq
        const pr = PR_URL_PATTERN.exec(text)
        if (pr) {
          record.repo = `${pr[1]}/${pr[2]}`
          record.prNumber = Number(pr[3])
        }
      }
    } else if (event.type === 'tool/result') {
      const block = event.data.message?.content?.[0]
      record.recentToolResults.push({ isError: block?.isError === true, text: messageText(block).slice(0, 200) })
      if (record.recentToolResults.length > MAX_RECENT_TOOL_RESULTS) {
        record.recentToolResults.splice(0, record.recentToolResults.length - MAX_RECENT_TOOL_RESULTS)
      }
    }
    record.lastActivityAt = this.now()
    this.persist(record)
  }

  // Explicit rename: a custom name wins forever over derived names.
  rename(sessionId, name) {
    const record = this.records.get(sessionId)
    if (!record) throw new Error(`session "${sessionId}" is not a known active session`)
    if (typeof name !== 'string' || name.trim() === '') throw new Error('rename: name must be a non-empty string')
    record.customName = name.trim()
    record.friendlyName = record.customName
    this.persist(record)
  }

  // Name priority: customName → derived from task/repo → Session <shortid>.
  // Derived names pass through collision resolution against live records;
  // the shortid fallback is unique by construction.
  assignName(record) {
    if (record.customName !== undefined) return record.customName
    const derived = deriveFriendlyName({ task: record.task, repo: record.repo, branch: record.branch })
    if (derived === undefined) return `Session ${record.sessionId.slice(0, 8)}`
    return this.resolveCollision(derived, record)
  }

  resolveCollision(base, record) {
    const taken = new Set()
    for (const other of this.records.values()) {
      if (other.sessionId !== record.sessionId) taken.add(other.friendlyName)
    }
    if (!taken.has(base)) return base
    const contexts = [record.repo?.split('/').pop(), record.branch, record.sessionId.slice(0, 8)]
    for (const context of contexts) {
      if (context === undefined) continue
      const candidate = `${base} (${context})`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} (${record.sessionId.slice(0, 8)})`
  }

  persist(record) {
    if (!this.store) return
    this.store.state.sessions[record.sessionId] = {
      customName: record.customName,
      prNumber: record.prNumber,
      repo: record.repo,
      branch: record.branch,
      task: record.task,
      currentTask: record.currentTask,
    }
    this.store.save()
  }

  list({ status, recentSeconds } = {}) {
    const cutoff = recentSeconds === undefined ? undefined : this.now() - recentSeconds * 1000
    const result = []
    for (const record of this.records.values()) {
      if (status !== undefined && status !== 'all' && record.status !== status) continue
      if (cutoff !== undefined && record.lastActivityAt < cutoff) continue
      result.push({ ...record })
    }
    return result.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  get(sessionId) {
    const record = this.records.get(sessionId)
    return record === undefined ? undefined : { ...record }
  }
}

function basename(path) {
  const trimmed = path.replace(/[/\\]+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || undefined
}
