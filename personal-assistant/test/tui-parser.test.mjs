import assert from 'node:assert/strict'
import { test } from 'node:test'
import { movementFor, parseMenu, stripAnsi } from '../src/terminal/tui-parser.js'

test('stripAnsi removes CSI, OSC, and charset escapes', () => {
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m plain'), 'green plain')
  assert.equal(stripAnsi('\x1b]0;window title\x07text'), 'text')
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07'), 'link')
  assert.equal(stripAnsi('\x1b(B\x1b[1;2Hpositioned'), 'positioned')
  assert.equal(stripAnsi('no escapes'), 'no escapes')
})

test('spec §24.4 menu: > cursor, two options, selected 0, high confidence', () => {
  const menu = parseMenu('Select an option:\n> Use existing API\n  Create new API\n')
  assert.equal(menu.confidence, 'high')
  assert.equal(menu.selectedIndex, 0)
  assert.deepEqual(menu.options, [
    { index: 1, label: 'Use existing API' },
    { index: 2, label: 'Create new API' },
  ])
})

test('arrow-variant markers ❯ ▶ › are recognized', () => {
  for (const marker of ['❯', '▶', '›']) {
    const menu = parseMenu(`  first\n${marker} second\n  third`)
    assert.equal(menu.confidence, 'high', marker)
    assert.equal(menu.selectedIndex, 1, marker)
    assert.equal(menu.options.length, 3, marker)
    assert.equal(menu.options[1].label, 'second', marker)
  }
})

test('selection below the first option moves selectedIndex', () => {
  const menu = parseMenu('  One\n  Two\n> Three')
  assert.equal(menu.confidence, 'high')
  assert.equal(menu.selectedIndex, 2)
})

test('inverse-video (SGR 7) line is preferred as high confidence without markers', () => {
  const raw = 'Pick one:\n  Alpha\n\x1b[7m  Beta\x1b[27m\n  Gamma'
  const menu = parseMenu(stripAnsi(raw), raw)
  assert.equal(menu.confidence, 'high')
  assert.equal(menu.selectedIndex, 1)
  assert.deepEqual(menu.options.map(o => o.label), ['Alpha', 'Beta', 'Gamma'])
})

test('ambiguous menus are low confidence', () => {
  // multiple marked lines
  const multi = parseMenu('> first\n> second')
  assert.equal(multi.confidence, 'low')
  // a lone marked line with no siblings
  const lone = parseMenu('doing things\n> only option\ndone')
  assert.equal(lone.confidence, 'low')
  // markers only mid-text
  const mid = parseMenu('a > b\nx > y')
  assert.equal(mid.confidence, 'low')
})

test('scrollback with two cursor-marked menus is ambiguous and bottom-most wins', () => {
  const scrollback = [
    '> stale one',
    '  stale two',
    '$ npm run build',
    'building...',
    '> fresh one',
    '  fresh two',
  ].join('\n')
  const menu = parseMenu(scrollback)
  assert.equal(menu.confidence, 'low')
  assert.deepEqual(menu.options.map(option => option.label), ['fresh one', 'fresh two'])
})

test('non-menu text returns undefined', () => {
  assert.equal(parseMenu('$ npm test\nall tests pass\n$'), undefined)
  assert.equal(parseMenu(''), undefined)
  assert.equal(parseMenu('single > comparison alone'), undefined)
})

test('movement math', () => {
  assert.deepEqual(movementFor(0, 1), ['DOWN'])
  assert.deepEqual(movementFor(2, 0), ['UP', 'UP'])
  assert.deepEqual(movementFor(1, 1), [])
  assert.equal(movementFor(1, undefined), undefined)
})
