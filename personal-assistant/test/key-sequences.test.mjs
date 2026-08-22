import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NAMED_KEYS, isNamedKey, keySequence } from '../src/terminal/key-sequences.js'

test('full named-key mapping', () => {
  assert.equal(NAMED_KEYS.UP, '\x1b[A')
  assert.equal(NAMED_KEYS.DOWN, '\x1b[B')
  assert.equal(NAMED_KEYS.LEFT, '\x1b[D')
  assert.equal(NAMED_KEYS.RIGHT, '\x1b[C')
  assert.equal(NAMED_KEYS.TAB, '\t')
  assert.equal(NAMED_KEYS.SPACE, ' ')
  assert.equal(NAMED_KEYS.ESC, '\x1b')
  assert.equal(NAMED_KEYS.BACKSPACE, '\x7f')
  assert.equal(NAMED_KEYS.CTRL_C, '\x03')
  assert.equal(NAMED_KEYS.CTRL_D, '\x04')
  assert.ok(Object.isFrozen(NAMED_KEYS))
})

test('ENTER is not a byte sequence', () => {
  assert.equal(isNamedKey('ENTER'), false)
  assert.throws(() => keySequence('ENTER'), /submit/)
})

test('keySequence and isNamedKey', () => {
  assert.equal(keySequence('UP'), '\x1b[A')
  assert.equal(isNamedKey('CTRL_C'), true)
  assert.equal(isNamedKey('NOPE'), false)
  assert.throws(() => keySequence('NOPE'), /unknown named key "NOPE"/)
})
