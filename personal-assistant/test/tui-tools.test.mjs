import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTuiToolSpecs } from '../src/terminal/tui-tools.js'

const MENU_TEXT = 'Pick one:\n> Use existing API\n  Create new API'

function moveCursor(text, delta) {
  const lines = text.split('\n')
  const current = lines.findIndex(line => line.startsWith('> '))
  const target = current + delta
  if (current === -1 || target < 0 || target >= lines.length || !lines[target].startsWith('  ')) return text
  lines[current] = `  ${lines[current].slice(2)}`
  lines[target] = `> ${lines[target].slice(2)}`
  return lines.join('\n')
}

function fakeBridge(initialText, { available = true } = {}) {
  let text = initialText
  const sent = []
  return {
    sent,
    available: () => available,
    readTerminal: (sessionId, terminalId) => ({ terminalId: terminalId ?? 'term-1', text }),
    sendKeys: async (sessionId, terminalId, keys, { submit = false } = {}) => {
      sent.push({ keys: [...keys], submit })
      for (const key of keys) {
        if (key === 'DOWN') text = moveCursor(text, 1)
        if (key === 'UP') text = moveCursor(text, -1)
      }
      return { terminalId: terminalId ?? 'term-1', deltas: [''] }
    },
  }
}

function setup(text = MENU_TEXT, options) {
  const bridge = fakeBridge(text, options)
  const sessionIndex = { get: id => (id === 'session-a' ? { sessionId: id } : undefined) }
  const specs = createTuiToolSpecs({ sessionIndex, bridge })
  const byName = Object.fromEntries(specs.map(spec => [spec.name, spec]))
  return { bridge, byName }
}

test('tui_snapshot returns bounded clean text and a parsed menu', async () => {
  const { byName } = setup()
  const result = await byName.tui_snapshot.callback({ session_id: 'session-a' })
  assert.equal(result.ok, true)
  assert.equal(result.terminal_id, 'term-1')
  assert.ok(result.clean_text.includes('Use existing API'))
  assert.equal(result.menu.confidence, 'high')
  assert.equal(result.menu.options.length, 2)
})

test('tui_select happy path: keys sent in order, evidence returned', async () => {
  const { byName, bridge } = setup()
  const result = await byName.tui_select.callback({ session_id: 'session-a', option_index: 2 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.moved, ['DOWN'])
  assert.deepEqual(bridge.sent, [{ keys: ['DOWN'], submit: true }])
  assert.equal(result.selected, 'Create new API')
  assert.ok(result.after.includes('> Create new API'))
})

test('tui_select on the current option sends no movement keys but still submits', async () => {
  const { byName, bridge } = setup()
  const result = await byName.tui_select.callback({ session_id: 'session-a', option_index: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.moved, [])
  assert.deepEqual(bridge.sent, [{ keys: [], submit: true }])
})

test('tui_select refuses ambiguous menus and never sends keys', async () => {
  const { byName, bridge } = setup('a > b\nx > y')
  const result = await byName.tui_select.callback({ session_id: 'session-a', option_index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ambiguous_menu')
  assert.deepEqual(bridge.sent, [])
})

test('tui_select rejects out-of-range options', async () => {
  const { byName } = setup()
  const result = await byName.tui_select.callback({ session_id: 'session-a', option_index: 9 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'option_out_of_range')
  assert.equal(result.option_count, 2)
})

test('tui_keypress validates named keys and forwards them', async () => {
  const { byName, bridge } = setup()
  const ok = await byName.tui_keypress.callback({ session_id: 'session-a', keys: ['CTRL_C'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(bridge.sent, [{ keys: ['CTRL_C'], submit: false }])
  await assert.rejects(() => byName.tui_keypress.callback({ session_id: 'session-a', keys: ['ENTER'] }), /not a named key/)
  await assert.rejects(() => byName.tui_keypress.callback({ session_id: 'session-a', keys: [] }), /non-empty/)
  await assert.rejects(() => byName.tui_keypress.callback({ session_id: 'session-a', keys: ['UP', '\x1b[A'] }), /not a named key/)
})

test('unknown sessions get actionable errors from every tui tool', async () => {
  const { byName } = setup()
  await assert.rejects(() => byName.tui_snapshot.callback({ session_id: 'gone' }), /sessions_list/)
  await assert.rejects(() => byName.tui_select.callback({ session_id: 'gone', option_index: 1 }), /sessions_list/)
  await assert.rejects(() => byName.tui_keypress.callback({ session_id: 'gone', keys: ['ESC'] }), /sessions_list/)
})

test('missing terminal service yields an actionable result, not a crash', async () => {
  const { byName } = setup(MENU_TEXT, { available: false })
  const result = await byName.tui_snapshot.callback({ session_id: 'session-a' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'terminal_unavailable')
  const select = await byName.tui_select.callback({ session_id: 'session-a', option_index: 1 })
  assert.equal(select.reason, 'terminal_unavailable')
})
