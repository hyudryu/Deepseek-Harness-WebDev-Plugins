// Named-key → byte-sequence mapping. ENTER is deliberately absent: it is
// sent via `submit: true` on the send operation, never as a raw byte. Raw
// escape bytes from callers are never accepted — named keys only.
export const NAMED_KEYS = Object.freeze({
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  TAB: '\t',
  SPACE: ' ',
  ESC: '\x1b',
  BACKSPACE: '\x7f',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
})

export function isNamedKey(name) {
  return Object.hasOwn(NAMED_KEYS, name)
}

export function keySequence(name) {
  if (!isNamedKey(name)) {
    throw new Error(`unknown named key "${name}" — valid keys: ${Object.keys(NAMED_KEYS).join(', ')}; ENTER is sent via submit, not a byte sequence`)
  }
  return NAMED_KEYS[name]
}
