import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

test('QA block is appended once and moved to bottom on update', () => {
  const state = __test.newState('abc123', [{ id: 'QA-001', text: 'Loads dashboard' }], 3)
  const block = __test.renderBlock(state)
  const once = __test.upsertBlock('## Summary\nhello', block)
  const twice = __test.upsertBlock(`${once}\n\nextra`, block)
  assert.equal((twice.match(/<!-- dsh-qa:start -->/g) ?? []).length, 1)
  assert.ok(twice.endsWith('<!-- dsh-qa:end -->'))
  assert.ok(twice.includes('extra'))
})

test('machine state round trips through rendered block', () => {
  const state = __test.newState('abc123', [{ id: 'QA-001', text: 'Loads dashboard' }], 3)
  const block = __test.renderBlock(state)
  const parsed = __test.parseState(block)
  assert.equal(parsed.headSha, 'abc123')
  assert.equal(parsed.checks[0].id, 'QA-001')
  assert.equal(parsed.checks[0].status, 'PENDING')
})
