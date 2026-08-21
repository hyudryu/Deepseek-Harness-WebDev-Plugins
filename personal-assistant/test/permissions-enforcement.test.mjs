import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkToolCall, enforcePermissions } from '../src/supervisor/permissions.js'

function setup(specs) {
  const warnings = []
  const wrapped = enforcePermissions(specs, { logger: { warn: message => warnings.push(message) } })
  return { wrapped, warnings }
}

test('allow-listed tool calls execute normally', async () => {
  const calls = []
  const { wrapped } = setup([{ name: 'session_send', callback: async input => { calls.push(input); return { ok: true } } }])
  const result = await wrapped[0].callback({ session_id: 's-1', message: 'hi' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [{ session_id: 's-1', message: 'hi' }])
})

test('non-listed tools refuse WITHOUT executing and log a warning', async () => {
  let executed = false
  const { wrapped, warnings } = setup([{ name: 'evil_tool', callback: async () => { executed = true } }])
  const result = await wrapped[0].callback({})
  assert.equal(executed, false)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'approval_required')
  assert.ok(result.message.includes('not on the personal-assistant autonomy allow-list'))
  assert.equal(warnings.length, 1)
})

test('destructive-name calls refuse (e.g. a hypothetical github_merge_pr)', async () => {
  let executed = false
  const { wrapped } = setup([
    { name: 'github_merge_pr', callback: async () => { executed = true } },
    { name: 'session_close', callback: async () => { executed = true } },
  ])
  for (const spec of wrapped) {
    const result = await spec.callback({})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'approval_required')
  }
  assert.equal(executed, false)
})

test('spec shape and extra callback arguments pass through untouched', async () => {
  const { wrapped } = setup([{ name: 'sessions_list', description: 'd', inputSchema: { type: 'object' }, callback: async (input, extra) => ({ ok: true, extra }) }])
  assert.equal(wrapped[0].description, 'd')
  assert.deepEqual(wrapped[0].inputSchema, { type: 'object' })
  const result = await wrapped[0].callback({}, 'ctx-arg')
  assert.equal(result.extra, 'ctx-arg')
})

test('checkToolCall verdicts', () => {
  assert.deepEqual(checkToolCall('tui_select', {}), { allowed: true })
  assert.equal(checkToolCall('tui_select', { submit: false }).allowed, true)
  assert.equal(checkToolCall('tui_select', { submit: true }).allowed, false)
  assert.equal(checkToolCall('tui_keypress', { submit: true }).allowed, false)
  assert.equal(checkToolCall('watch_delete_all').allowed, false)
  assert.ok(checkToolCall('unknown').reason.length > 0)
})
