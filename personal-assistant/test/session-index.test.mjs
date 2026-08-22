import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryStore } from '../src/sessions/assistant-store.js'
import { SessionIndex } from '../src/sessions/session-index.js'

function fakeAgent(id, cwd) {
  return { id, status: 'idle', session: { header: { cwd } } }
}

function userEvent(text, seq = 1) {
  return { type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(text, seq) {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

function toolResultEvent(isError, text) {
  return { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }] } } }
}

test('first user task assigns the friendly name', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/toolbar-app') })
  assert.equal(index.get('session-aaa').friendlyName, 'Toolbar-app')

  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Implement toolbar enhancement'))
  assert.equal(index.get('session-aaa').friendlyName, 'Toolbar enhancement')
  assert.equal(index.get('session-aaa').currentTask, 'Implement toolbar enhancement')
})

test('name is stable once assigned: later user messages do not rename', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Implement toolbar enhancement'))
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Also fix the footer alignment', 2))
  assert.equal(index.get('session-aaa').friendlyName, 'Toolbar enhancement')
  assert.equal(index.get('session-aaa').currentTask, 'Also fix the footer alignment')
})

test('colliding names get repo or branch context, not numbers', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/web-app') })
  index.noteAgentCreated({ agent: fakeAgent('session-bbb', '/work/api') })
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Fix auth redirect bug'))
  index.noteSessionEvent({ id: 'session-bbb' }, userEvent('Fix auth redirect bug'))
  assert.equal(index.get('session-aaa').friendlyName, 'Auth redirect bug')
  assert.equal(index.get('session-bbb').friendlyName, 'Auth redirect bug (api)')
})

test('customName from explicit rename wins forever and persists', () => {
  const store = createMemoryStore()
  const index = new SessionIndex({ store })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  index.rename('session-aaa', 'Release work')
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Implement toolbar enhancement'))
  assert.equal(index.get('session-aaa').friendlyName, 'Release work')
  assert.equal(store.state.sessions['session-aaa'].customName, 'Release work')

  // A fresh index over the same store restores the custom name.
  const restored = new SessionIndex({ store })
  restored.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  restored.noteSessionEvent({ id: 'session-aaa' }, userEvent('Implement toolbar enhancement'))
  assert.equal(restored.get('session-aaa').friendlyName, 'Release work')
})

test('rename validates input and unknown sessions', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  assert.throws(() => index.rename('session-aaa', '  '), /non-empty/)
  assert.throws(() => index.rename('session-gone', 'x'), /not a known active session/)
})

test('PR URL in an assistant message sets repo and prNumber and persists', () => {
  const store = createMemoryStore()
  const index = new SessionIndex({ store })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/api') })
  index.noteSessionEvent({ id: 'session-aaa' }, assistantEvent('Opened https://github.com/acme/api/pull/42 for review.', 9))
  const record = index.get('session-aaa')
  assert.equal(record.prNumber, 42)
  assert.equal(record.repo, 'acme/api')
  assert.equal(record.lastAssistantText, 'Opened https://github.com/acme/api/pull/42 for review.')
  assert.equal(record.lastAssistantSeq, 9)
  assert.equal(store.state.sessions['session-aaa'].prNumber, 42)
})

test('assistant text and tool results are captured for idle classification', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/api') })
  index.noteSessionEvent({ id: 'session-aaa' }, toolResultEvent(true, 'exit code 1'))
  index.noteSessionEvent({ id: 'session-aaa' }, assistantEvent('The build failed again.', 5))
  const record = index.get('session-aaa')
  assert.equal(record.recentToolResults.length, 1)
  assert.equal(record.recentToolResults[0].isError, true)
  assert.equal(record.lastAssistantSeq, 5)
})

test('new user turns clear stale tool failures', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/api') })
  index.noteSessionEvent({ id: 'session-aaa' }, toolResultEvent(true, 'exit code 1'))
  assert.equal(index.get('session-aaa').recentToolResults.length, 1)
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('What port is configured?', 4))
  assert.deepEqual(index.get('session-aaa').recentToolResults, [])
})

test('plugin-routed user instructions refresh currentTask', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/api') })
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Initial task'))
  index.noteSessionEvent({ id: 'session-aaa' }, {
    type: 'user/message',
    seq: 2,
    data: { source: { kind: 'plugin', plugin: 'personal-assistant' }, content: [{ type: 'text', text: 'Fix the follow-up review findings' }] },
  })
  assert.equal(index.get('session-aaa').currentTask, 'Fix the follow-up review findings')
})

test('task-derived friendly name and currentTask survive a restart', () => {
  const store = createMemoryStore()
  const index = new SessionIndex({ store })
  index.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  index.noteSessionEvent({ id: 'session-aaa' }, userEvent('Implement toolbar enhancement'))
  assert.equal(store.state.sessions['session-aaa'].task, 'Implement toolbar enhancement')

  const restored = new SessionIndex({ store })
  restored.noteAgentCreated({ agent: fakeAgent('session-aaa', '/work/app') })
  assert.equal(restored.get('session-aaa').friendlyName, 'Toolbar enhancement')
  assert.equal(restored.get('session-aaa').currentTask, 'Implement toolbar enhancement')
})

test('control session is excluded from events and records', () => {
  const index = new SessionIndex({ excludeSessionId: 'control-id', store: createMemoryStore() })
  index.noteAgentCreated({ agent: fakeAgent('control-id', '/work/app') })
  index.noteSessionEvent({ id: 'control-id' }, userEvent('hello'))
  assert.equal(index.get('control-id'), undefined)
  assert.equal(index.list().length, 0)
})

test('events for unknown sessions are ignored', () => {
  const index = new SessionIndex({ store: createMemoryStore() })
  index.noteSessionEvent({ id: 'session-ghost' }, userEvent('hi'))
  assert.equal(index.get('session-ghost'), undefined)
})
