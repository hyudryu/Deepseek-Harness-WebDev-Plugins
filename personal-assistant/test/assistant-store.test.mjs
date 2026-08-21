import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultStatePath } from '../src/sessions/assistant-store.js'

test('default state path is stable and profile-scoped', () => {
  assert.equal(
    defaultStatePath({ env: {}, argv: ['node', 'dsh', '--profile', 'tui'], homeDir: '/users/me' }),
    '/users/me/.dsh/profiles/tui/personal-assistant-state.json',
  )
  assert.equal(
    defaultStatePath({ env: { DSH_HOME: '/var/dsh' }, argv: ['node', 'dsh', '--profile=web'], homeDir: '/users/me' }),
    '/var/dsh/profiles/web/personal-assistant-state.json',
  )
})

test('explicit state-file override wins', () => {
  assert.equal(
    defaultStatePath({ env: { DSH_PERSONAL_ASSISTANT_STATE: '/tmp/assistant.json' }, argv: [], homeDir: '/users/me' }),
    '/tmp/assistant.json',
  )
})
