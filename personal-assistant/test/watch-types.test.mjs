import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWatch, encodeWatchPayload, parseWatchPayload, validateWatch } from '../src/watches/watch-types.js'

const VALID = { repo: 'acme/api', prNumber: 42, everySeconds: 300 }

test('createWatch builds a valid v1 record with defaults', () => {
  const watch = createWatch(VALID)
  assert.equal(watch.version, 1)
  assert.equal(watch.kind, 'github_codex_review')
  assert.equal(watch.exitCondition, 'codex_thumbs_up')
  assert.ok(watch.watchId)
})

test('validation rejects bad input with actionable errors', () => {
  assert.throws(() => createWatch({ ...VALID, repo: 'noslash' }), /owner\/repo/)
  assert.throws(() => createWatch({ ...VALID, prNumber: 0 }), /prNumber/)
  assert.throws(() => createWatch({ ...VALID, everySeconds: 299 }), /at least 300/)
  assert.throws(() => createWatch({ ...VALID, exitCondition: 'whenever' }), /exitCondition/)
  assert.throws(() => validateWatch(null), /object/)
})

test('encode/parse round-trips a watch', () => {
  const watch = createWatch({ ...VALID, watchId: 'w-1', exitCondition: 'pr_merged' })
  const parsed = parseWatchPayload(encodeWatchPayload(watch))
  assert.equal(parsed.watchId, 'w-1')
  assert.equal(parsed.repo, 'acme/api')
  assert.equal(parsed.prNumber, 42)
  assert.equal(parsed.exitCondition, 'pr_merged')
})

test('parser tolerates surrounding reminder framing text', () => {
  const watch = createWatch({ ...VALID, watchId: 'w-2' })
  const framed = ['[SCHEDULE REMINDER]', 'some instruction line', encodeWatchPayload(watch), 'trailing noise'].join('\n')
  assert.equal(parseWatchPayload(framed)?.watchId, 'w-2')
})

test('malformed payloads parse to undefined, never throw', () => {
  assert.equal(parseWatchPayload(undefined), undefined)
  assert.equal(parseWatchPayload('no marker here'), undefined)
  assert.equal(parseWatchPayload('[watch] {not json'), undefined)
  assert.equal(parseWatchPayload('[watch] {"version":1,"watchId":"x"}'), undefined)
})
