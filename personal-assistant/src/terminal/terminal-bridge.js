import { NAMED_KEYS, isNamedKey, keySequence } from './key-sequences.js'

// Privileged cross-session terminal access for the supervisor ONLY. The
// owner-fenced terminal service is unlocked by resolving the target coding
// agent and passing it as `owner`. This bridge feeds the supervisor's Strands
// tools and must never be registered as a Harness tool for coding agents.
export function createTerminalBridge({ agents, terminals }) {
  function available() {
    return terminals !== undefined && terminals !== null
  }

  function resolve(sessionId) {
    const agent = agents.get(sessionId)
    if (!agent) throw new Error(`session "${sessionId}" is unknown or disposed — call sessions_list to see active sessions`)
    return agent
  }

  function requireTerminals() {
    if (!available()) throw new Error('terminal service unavailable in this deployment')
  }

  function listTerminals(sessionId) {
    requireTerminals()
    return terminals.list(resolve(sessionId))
  }

  // No activity timestamps on terminal snapshots; the most recently created
  // (last in registry order) is the practical default.
  function defaultTerminalId(sessionId) {
    const list = listTerminals(sessionId)
    if (list.length === 0) throw new Error(`session "${sessionId}" has no live terminals`)
    return list[list.length - 1].sessionId
  }

  function readTerminal(sessionId, terminalId) {
    requireTerminals()
    const agent = resolve(sessionId)
    const id = terminalId ?? defaultTerminalId(sessionId)
    const page = terminals.read(agent, id)
    return { terminalId: id, text: page.text, truncated: page.truncated }
  }

  // One startSend per key, awaited sequentially — exactly one send operation
  // may be active per PTY session. Named keys only; raw bytes never pass
  // through. ENTER is a separate submit operation, never mixed into keys.
  async function sendKeys(sessionId, terminalId, keys, { submit = false } = {}) {
    requireTerminals()
    if (!Array.isArray(keys)) throw new Error('sendKeys: keys must be an array of named keys')
    for (const key of keys) {
      if (!isNamedKey(key)) throw new Error(`sendKeys: "${key}" is not a named key — valid keys: ${Object.keys(NAMED_KEYS).join(', ')}; ENTER is sent via submit`)
    }
    const agent = resolve(sessionId)
    const id = terminalId ?? defaultTerminalId(sessionId)
    if (keys.length === 0 && !submit) return { terminalId: id, deltas: [] }
    const deltas = []
    for (const key of keys) {
      const operation = terminals.startSend(agent, id, { text: keySequence(key), submit: false })
      await operation.done
      deltas.push(operation.readOutput().delta)
    }
    if (submit) {
      const operation = terminals.startSend(agent, id, { text: '', submit: true })
      await operation.done
      deltas.push(operation.readOutput().delta)
    }
    return { terminalId: id, deltas }
  }

  return { available, resolve, listTerminals, readTerminal, sendKeys }
}
