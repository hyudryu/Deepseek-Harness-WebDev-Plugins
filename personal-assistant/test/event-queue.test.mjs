import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvent } from '../src/supervisor/event-types.js'
import { EventQueue } from '../src/supervisor/event-queue.js'

function event(kind, dedupeKey) {
  return createEvent({ kind, dedupeKey })
}

test('createEvent fills id, createdAt, and priority from kind', () => {
  const e = createEvent({ kind: 'FAILED', dedupeKey: 'k' })
  assert.ok(e.id)
  assert.equal(typeof e.createdAt, 'number')
  assert.equal(e.priority, 0)
  assert.equal(createEvent({ kind: 'CI_PASSED' }).priority, 3)
  assert.equal(createEvent({ kind: 'COMPLETED' }).priority, 2)
  assert.throws(() => createEvent({ kind: 'NOPE' }), /kind/)
})

test('next returns highest priority first', () => {
  const queue = new EventQueue()
  const low = event('COMPLETED')
  const high = event('FAILED')
  queue.push(low)
  queue.push(high)
  assert.equal(queue.next(), high)
  assert.equal(queue.next(), low)
  assert.equal(queue.next(), undefined)
})

test('FIFO within one priority', () => {
  const queue = new EventQueue()
  const first = event('FAILED')
  const second = event('BLOCKED') // also P0
  const third = event('FAILED')
  queue.push(first)
  queue.push(second)
  queue.push(third)
  assert.deepEqual([queue.next(), queue.next(), queue.next()], [first, second, third])
})

test('dedupeKey duplicates are dropped', () => {
  const queue = new EventQueue()
  assert.equal(queue.push(event('FAILED', 'dup')), true)
  assert.equal(queue.push(event('FAILED', 'dup')), false)
  assert.equal(queue.size, 1)
  // events without a dedupeKey are never dropped
  assert.equal(queue.push(event('FAILED')), true)
  assert.equal(queue.push(event('FAILED')), true)
  assert.equal(queue.size, 3)
})

test('bounded dedupe cache eviction allows re-push', () => {
  const queue = new EventQueue({ dedupeCacheSize: 2 })
  queue.push(event('INFO', 'a'))
  queue.push(event('INFO', 'b'))
  queue.push(event('INFO', 'c')) // evicts 'a'
  assert.equal(queue.push(event('INFO', 'a')), true) // evicted, so accepted (evicts 'b')
  assert.equal(queue.push(event('INFO', 'c')), false) // still cached
})

test('peek, size, clear', () => {
  const queue = new EventQueue()
  const low = event('COMPLETED')
  const high = event('INPUT_REQUIRED')
  queue.push(low)
  queue.push(high)
  assert.equal(queue.peek(), high)
  assert.equal(queue.size, 2)
  queue.clear()
  assert.equal(queue.size, 0)
  assert.equal(queue.peek(), undefined)
})
