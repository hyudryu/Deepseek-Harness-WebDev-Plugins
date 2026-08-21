import { randomUUID } from 'node:crypto'

// Posts supervisor output onto the control session WITHOUT a model call, by
// committing the same bracketed event sequence the agent loop commits for a
// real turn: turn/start → step/start → assistant/message → step/end →
// turn/end. Turn numbers derive from the session log (the loop's own
// `lastTurn` rule) so synthetic turns never collide with loop turns, and so
// numbers survive a resume.
export function createNotifier({ session, logger } = {}) {
  let fallbackTurn = 0

  function nextTurn() {
    const logged = session.events.findLast(event => event.type === 'turn/start')?.data.turn
    if (Number.isInteger(logged)) fallbackTurn = Math.max(fallbackTurn, logged)
    fallbackTurn += 1
    return fallbackTurn
  }

  function postAssistantMessage(text) {
    try {
      const turn = nextTurn()
      const step = 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step })
      session.append('assistant/message', {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'personal-assistant', model: 'supervisor' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      session.append('step/end', { turn, step })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return true
    } catch (error) {
      logger?.info?.(`personal-assistant: could not post to control session: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return { postAssistantMessage }
}
