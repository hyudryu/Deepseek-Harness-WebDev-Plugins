import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyIdleTransition, eventForIdleTransition } from '../src/sessions/completion-classifier.js'

test('spec examples: the four notification kinds', () => {
  assert.equal(classifyIdleTransition({ lastAssistantText: 'Implemented the toolbar enhancement. All checks pass.' }), 'COMPLETED')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'Should I refactor the auth module next?' }), 'INPUT_REQUIRED')
  assert.equal(classifyIdleTransition({ lastAssistantText: "I can't continue until you provide the API credentials." }), 'BLOCKED')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'The build failed again; the tests are failing after my change.' }), 'FAILED')
})

test('no assistant text or ambiguous text stays silent', () => {
  assert.equal(classifyIdleTransition({}), 'NO_NOTIFICATION')
  assert.equal(classifyIdleTransition({ lastAssistantText: '' }), 'NO_NOTIFICATION')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'I looked at the code and poked around a bit.' }), 'NO_NOTIFICATION')
})

test('rule precedence: question beats completion, blocked beats failure', () => {
  assert.equal(classifyIdleTransition({ lastAssistantText: 'I fixed the typo. Do you want me to commit it?' }), 'INPUT_REQUIRED')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'Build failed and I cannot proceed without a decision.' }), 'BLOCKED')
})

test('recovered failure is not FAILED: later success statement wins', () => {
  assert.equal(classifyIdleTransition({ lastAssistantText: 'Tests were failing, but I fixed the mock and now all tests pass.' }), 'COMPLETED')
})

test('errored recent tool result without recovery statement is FAILED', () => {
  const recentToolResults = [{ isError: true, text: 'exit code 1' }]
  assert.equal(classifyIdleTransition({ lastAssistantText: 'Let me try another approach.', recentToolResults }), 'FAILED')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'The command errored once, but it is done and tests pass now.', recentToolResults }), 'COMPLETED')
})

test('blocked-on-input phrasing', () => {
  assert.equal(classifyIdleTransition({ lastAssistantText: 'I need a password for the staging database.' }), 'BLOCKED')
  assert.equal(classifyIdleTransition({ lastAssistantText: 'I need your decision on the rollout plan.' }), 'BLOCKED')
})

test('eventForIdleTransition builds deduped events and respects toggles', () => {
  const record = {
    sessionId: 'abc123',
    friendlyName: 'Toolbar enhancement',
    lastAssistantText: 'Done. All checks pass.',
    lastAssistantSeq: 17,
    recentToolResults: [],
  }
  const event = eventForIdleTransition(record, { completed: true })
  assert.equal(event.kind, 'COMPLETED')
  assert.equal(event.dedupeKey, 'session:abc123:assistant-message:17')
  assert.equal(event.sourceSessionId, 'abc123')
  assert.equal(event.friendlyName, 'Toolbar enhancement')

  assert.equal(eventForIdleTransition(record, { completed: false }), undefined)
  assert.equal(eventForIdleTransition({ ...record, lastAssistantText: '' }, { completed: true }), undefined)
})
