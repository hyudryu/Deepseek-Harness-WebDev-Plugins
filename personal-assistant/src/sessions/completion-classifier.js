import { createEvent } from '../supervisor/event-types.js'

// Deterministic idle-transition classification. Rule order matters and is
// the contract (first match wins):
//   1. no assistant text            → NO_NOTIFICATION (idle ≠ complete)
//   2. question directed at user    → INPUT_REQUIRED
//   3. blocked on something external → BLOCKED
//   4. unrecovered failure          → FAILED
//   5. completion summary           → COMPLETED
//   6. anything else                → NO_NOTIFICATION
// Seam: an optional Strands model classification for the ambiguous tail is a
// later refinement — deliberately not wired here (this module stays pure).

const QUESTION_PATTERN = /(should i|shall i|which|do you want|want me to|would you like me)/i
const BLOCKED_PATTERN = /(i can't continue|i cannot continue|can't proceed|cannot proceed|until you provide|blocked)/i
const BLOCKED_NEED_PATTERN = /need.*(credential|secret|password|input|decision)/i
const FAILURE_PATTERN = /(still fails?|build failed|tests? (are )?failing|error:)/i
const SUCCESS_PATTERN = /(implemented|fixed|done|resolved|succeeded|tests? pass|all checks pass|working now)/i
const COMPLETION_PATTERN = /(implemented|done|fixed|completed|finished|tests? pass|all checks pass)/i

function lastMatchIndex(text, pattern) {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
  let last = -1
  let match
  while ((match = global.exec(text)) !== null) last = match.index
  return last
}

export function classifyIdleTransition({ lastAssistantText, recentToolResults } = {}) {
  if (typeof lastAssistantText !== 'string' || lastAssistantText.trim() === '') return 'NO_NOTIFICATION'
  const text = lastAssistantText.trim()

  if (text.endsWith('?') || QUESTION_PATTERN.test(text)) return 'INPUT_REQUIRED'
  if (BLOCKED_PATTERN.test(text) || BLOCKED_NEED_PATTERN.test(text)) return 'BLOCKED'

  const failureAt = lastMatchIndex(text, FAILURE_PATTERN)
  const successAt = lastMatchIndex(text, SUCCESS_PATTERN)
  // A failure counts only when nothing AFTER it reads as recovery; the same
  // "no recovery" rule covers an errored recent tool result.
  const hasErroredTool = (recentToolResults ?? []).some(result => result.isError === true)
  if ((failureAt !== -1 && failureAt > successAt) || (hasErroredTool && successAt === -1)) return 'FAILED'

  if (COMPLETION_PATTERN.test(text)) return 'COMPLETED'
  return 'NO_NOTIFICATION'
}

const NOTIFICATION_KEY = Object.freeze({
  COMPLETED: 'completed',
  INPUT_REQUIRED: 'inputRequired',
  FAILED: 'failed',
  BLOCKED: 'blocked',
})

// Builds the supervisor event for one idle transition, or undefined when the
// classifier stays silent or the notification kind is toggled off. The
// dedupeKey pins to the classified assistant message, so the same message
// never notifies twice but a later message can.
export function eventForIdleTransition(record, notifications = {}) {
  const kind = classifyIdleTransition(record)
  const toggle = NOTIFICATION_KEY[kind]
  if (toggle === undefined || notifications[toggle] === false) return undefined
  return createEvent({
    kind,
    dedupeKey: `session:${record.sessionId}:assistant-message:${record.lastAssistantSeq ?? 'none'}`,
    sourceSessionId: record.sessionId,
    friendlyName: record.friendlyName,
    payload: { summary: record.lastAssistantText.slice(0, 200) },
  })
}
