import { randomUUID } from 'node:crypto'

// Notification taxonomy, ordered by presentation priority. Lower number
// presents first; P0 interrupts, P3 is informational.
export const EVENT_PRIORITIES = Object.freeze({
  INPUT_REQUIRED: 0,
  DESTRUCTIVE_APPROVAL_REQUIRED: 0,
  FAILED: 0,
  BLOCKED: 0,
  REVIEW_RECEIVED: 1,
  CI_FAILED: 1,
  WATCH_CONDITION_MET: 1,
  COMPLETED: 2,
  CI_PASSED: 3,
  INFO: 3,
})

export const EVENT_KINDS = Object.freeze(Object.keys(EVENT_PRIORITIES))

// Kinds whose presentation asks the user something; the next user answer
// binds back to the pending question.
export const QUESTION_KINDS = Object.freeze(['INPUT_REQUIRED', 'DESTRUCTIVE_APPROVAL_REQUIRED'])

export function createEvent({ kind, dedupeKey, sourceSessionId, friendlyName, payload } = {}) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`event kind must be one of: ${EVENT_KINDS.join(', ')}`)
  if (dedupeKey !== undefined && typeof dedupeKey !== 'string') throw new Error('event dedupeKey must be a string')
  return {
    id: randomUUID(),
    kind,
    priority: EVENT_PRIORITIES[kind],
    createdAt: Date.now(),
    dedupeKey,
    sourceSessionId,
    friendlyName,
    payload,
  }
}
