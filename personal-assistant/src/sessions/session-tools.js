import { randomUUID } from 'node:crypto'

const MAX_LISTED_SESSIONS = 50
const SEND_MODES = Object.freeze(['auto', 'followup', 'steer', 'inject'])

function requireString(args, key, toolName) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${toolName}: ${key} is required`)
  return value
}

function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'personal-assistant' },
  }
}

function publicRecord(record) {
  return {
    sessionId: record.sessionId,
    friendlyName: record.friendlyName,
    cwd: record.cwd,
    repo: record.repo,
    branch: record.branch,
    prNumber: record.prNumber,
    status: record.status,
    lastActivityAt: record.lastActivityAt,
    currentTask: record.currentTask,
  }
}

function resolveMode(args, agent) {
  const mode = args.mode ?? 'auto'
  if (!SEND_MODES.includes(mode)) throw new Error(`session_send: mode must be one of: ${SEND_MODES.join(', ')}`)
  if (mode !== 'auto') return mode
  if (agent.status !== 'running') return 'followup'
  return args.urgent === true ? 'steer' : 'inject'
}

// Pure tool specs ({ name, description, inputSchema, callback }) so the logic
// is testable without the Strands SDK; the runtime wraps them with the
// policy-enforcing tool() seam.
export function createSessionToolSpecs({ sessionIndex, agents }) {
  function requireRecord(sessionId) {
    const record = sessionIndex.get(sessionId)
    if (!record) throw new Error(`session "${sessionId}" is not a known active session — call sessions_list to see active sessions`)
    return record
  }

  return [
    {
      name: 'sessions_list',
      description: 'List active DeepSeek Harness sessions with friendly name, status, cwd, PR association, and last activity. Use this to orient yourself before addressing a session.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['all', 'running', 'idle'], description: 'Filter by status; "all" (default) returns every session.' },
          recent_seconds: { type: 'integer', minimum: 1, description: 'Only sessions active within the last N seconds.' },
        },
      },
      callback: async (args = {}) => {
        if (args.recent_seconds !== undefined && (!Number.isInteger(args.recent_seconds) || args.recent_seconds <= 0)) {
          throw new Error('sessions_list: recent_seconds must be a positive integer')
        }
        const sessions = sessionIndex.list({ status: args.status ?? 'all', recentSeconds: args.recent_seconds })
          .slice(0, MAX_LISTED_SESSIONS)
          .map(publicRecord)
        return { ok: true, sessions }
      },
    },
    {
      name: 'session_get',
      description: 'Get normalized metadata for one session by exact session id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id'],
        properties: {
          session_id: { type: 'string' },
        },
      },
      callback: async (args = {}) => {
        const sessionId = requireString(args, 'session_id', 'session_get')
        return { ok: true, session: publicRecord(requireRecord(sessionId)) }
      },
    },
    {
      name: 'session_send',
      description: 'Send a message to a session. mode "auto" (default): followup when idle, inject when running, steer only when urgent=true. Prefer messaging over terminal typing.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'message'],
        properties: {
          session_id: { type: 'string' },
          message: { type: 'string' },
          mode: { type: 'string', enum: [...SEND_MODES] },
          urgent: { type: 'boolean', description: 'With mode "auto", steer a running session instead of injecting context.' },
        },
      },
      callback: async (args = {}) => {
        const sessionId = requireString(args, 'session_id', 'session_send')
        const message = requireString(args, 'message', 'session_send')
        requireRecord(sessionId)
        const agent = agents.get(sessionId)
        if (!agent) throw new Error(`session "${sessionId}" is listed but has no live agent; it may have just closed — call sessions_list to refresh`)
        const mode = resolveMode(args, agent)
        agent[mode](userMessage(message))
        return { ok: true, session_id: sessionId, mode }
      },
    },
  ]
}
