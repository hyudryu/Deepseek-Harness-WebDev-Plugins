import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createJsonFileStore, defaultStatePath, emptyState } from '../src/sessions/assistant-store.js'

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

test('structurally corrupt state files recover to empty state with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-store-'))
  const corrupt = {
    'sessions-null.json': { version: 1, sessions: null, dedupeKeys: [], watches: [] },
    'watches-object.json': { version: 1, sessions: {}, dedupeKeys: [], watches: {} },
    'wrong-version.json': { version: 99, sessions: {}, dedupeKeys: [], watches: [] },
  }
  for (const [name, content] of Object.entries(corrupt)) {
    const filePath = join(dir, name)
    writeFileSync(filePath, JSON.stringify(content))
    const warnings = []
    const store = createJsonFileStore({ filePath, logger: { warn: message => warnings.push(message) } })
    assert.deepEqual(store.state, emptyState(), name)
    assert.equal(warnings.length, 1, name)
    assert.ok(warnings[0].includes('unexpected shape'), name)
  }
})

test('well-formed state files load unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-store-'))
  const filePath = join(dir, 'state.json')
  const persisted = { version: 1, sessions: { s1: { customName: 'Release work' } }, dedupeKeys: ['k1'], watches: [] }
  writeFileSync(filePath, JSON.stringify(persisted))
  const store = createJsonFileStore({ filePath })
  assert.equal(store.state.sessions.s1.customName, 'Release work')
  assert.deepEqual(store.state.dedupeKeys, ['k1'])
})
