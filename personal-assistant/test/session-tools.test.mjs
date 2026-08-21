import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionIndex } from '../src/sessions/session-index.js'
import { createSessionToolSpecs } from '../src/sessions/session-tools.js'

function fakeAgent(id, status, cwd = '/repo') {
  const calls = []
  return {
    id,
    status,
    calls,
    session: { header: { cwd } },
    followup(message) { calls.push(['followup', message]) },
    steer(message) { calls.push(['steer', message]) },
    inject(message) { calls.push(['inject', message]) },
  }
}

function setup() {
  const index = new SessionIndex({ excludeSessionId: 'control-session' })
  const live = new Map()
  const running = fakeAgent('session-running-0001', 'running')
  const idle = fakeAgent('session-idle-00000002', 'idle')
  live.set(running.id, running)
  live.set(idle.id, idle)
  index.noteAgentCreated({ agent: running })
  index.noteAgentCreated({ agent: idle })
  index.noteAgentCreated({ agent: fakeAgent('control-session', 'idle') })
  const specs = createSessionToolSpecs({ sessionIndex: index, agents: { get: id => live.get(id) } })
  const byName = Object.fromEntries(specs.map(spec => [spec.name, spec]))
  return { index, byName, running, idle }
}

test('session index excludes the control session and tracks status', () => {
  const { index } = setup()
  assert.equal(index.list().length, 2)
  assert.equal(index.get('control-session'), undefined)
  index.noteAgentStatus({ agent: { id: 'session-idle-00000002' }, status: 'running' })
  assert.equal(index.get('session-idle-00000002').status, 'running')
  index.noteAgentDisposed({ agent: { id: 'session-idle-00000002' } })
  assert.equal(index.list().length, 1)
})

test('sessions_list filters by status', async () => {
  const { byName } = setup()
  const all = await byName.sessions_list.callback({})
  assert.equal(all.sessions.length, 2)
  const idleOnly = await byName.sessions_list.callback({ status: 'idle' })
  assert.deepEqual(idleOnly.sessions.map(s => s.sessionId), ['session-idle-00000002'])
  const runningOnly = await byName.sessions_list.callback({ status: 'running' })
  assert.deepEqual(runningOnly.sessions.map(s => s.sessionId), ['session-running-0001'])
  // normalized metadata only
  assert.deepEqual(Object.keys(idleOnly.sessions[0]).sort(), ['branch', 'currentTask', 'cwd', 'friendlyName', 'lastActivityAt', 'prNumber', 'repo', 'sessionId', 'status'])
})

test('sessions_list filters by recent_seconds', async () => {
  let now = 1_000_000
  const index = new SessionIndex({ now: () => now })
  index.noteAgentCreated({ agent: fakeAgent('session-old-000000001', 'idle') })
  now += 120_000
  index.noteAgentCreated({ agent: fakeAgent('session-new-000000001', 'idle') })
  const specs = createSessionToolSpecs({ sessionIndex: index, agents: { get: () => undefined } })
  const result = await specs[0].callback({ recent_seconds: 60 })
  assert.deepEqual(result.sessions.map(s => s.sessionId), ['session-new-000000001'])
})

test('session_send auto mode: followup for idle, inject for running, steer when urgent', async () => {
  const { byName, running, idle } = setup()
  const sentIdle = await byName.session_send.callback({ session_id: idle.id, message: 'hello' })
  assert.equal(sentIdle.mode, 'followup')
  assert.equal(idle.calls[0][0], 'followup')
  assert.equal(idle.calls[0][1].content[0].text, 'hello')

  const sentRunning = await byName.session_send.callback({ session_id: running.id, message: 'fyi' })
  assert.equal(sentRunning.mode, 'inject')
  assert.equal(running.calls[0][0], 'inject')

  const sentUrgent = await byName.session_send.callback({ session_id: running.id, message: 'stop that', urgent: true })
  assert.equal(sentUrgent.mode, 'steer')
  assert.equal(running.calls[1][0], 'steer')

  const explicit = await byName.session_send.callback({ session_id: running.id, message: 'next task', mode: 'followup' })
  assert.equal(explicit.mode, 'followup')
})

test('session_send rejects unknown sessions and bad input with actionable errors', async () => {
  const { byName } = setup()
  await assert.rejects(() => byName.session_send.callback({ session_id: 'nope', message: 'hi' }), /sessions_list/)
  await assert.rejects(() => byName.session_send.callback({ session_id: 'session-idle-00000002' }), /message is required/)
  await assert.rejects(() => byName.session_send.callback({ session_id: 'session-idle-00000002', message: 'hi', mode: 'yolo' }), /mode must be one of/)
})

test('session_get returns one record or an actionable error', async () => {
  const { byName } = setup()
  const result = await byName.session_get.callback({ session_id: 'session-running-0001' })
  assert.equal(result.session.sessionId, 'session-running-0001')
  assert.equal(result.session.friendlyName, 'Repo') // derived from cwd basename until a task arrives
  await assert.rejects(() => byName.session_get.callback({ session_id: 'gone' }), /not a known active session/)
})

test('session tools expose persisted PR associations', async () => {
  const { index, byName } = setup()
  index.noteSessionEvent({ id: 'session-running-0001' }, {
    type: 'assistant/message',
    seq: 9,
    data: { message: { content: [{ type: 'text', text: 'Opened https://github.com/acme/api/pull/42' }] } },
  })
  const result = await byName.session_get.callback({ session_id: 'session-running-0001' })
  assert.equal(result.session.repo, 'acme/api')
  assert.equal(result.session.prNumber, 42)
})
