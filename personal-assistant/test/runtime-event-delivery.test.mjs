import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PersonalAssistantRuntime } from '../src/runtime.js'
import { createMemoryStore } from '../src/sessions/assistant-store.js'
import { createEvent } from '../src/supervisor/event-types.js'

async function drained(runtime) {
  while (runtime.eventDispatching || runtime.eventQueue.size > 0) await new Promise(resolve => setTimeout(resolve, 1))
}

function setup(submitEvent) {
  const store = createMemoryStore()
  const runtime = new PersonalAssistantRuntime({ logger: {} }, {}, { store })
  runtime.actor = { submitEvent }
  return { runtime, store }
}

test('queued events are dispatched by priority after the active presentation', async () => {
  const presented = []
  let release
  const { runtime } = setup(async event => {
    presented.push(event.kind)
    if (presented.length === 1) await new Promise(resolve => { release = resolve })
    return { ok: true }
  })
  runtime.notifyEvent(createEvent({ kind: 'COMPLETED', dedupeKey: 'active-low' }))
  await Promise.resolve()
  runtime.notifyEvent(createEvent({ kind: 'CI_PASSED', dedupeKey: 'queued-low' }))
  runtime.notifyEvent(createEvent({ kind: 'FAILED', dedupeKey: 'queued-high' }))
  release()
  await drained(runtime)
  assert.deepEqual(presented, ['COMPLETED', 'FAILED', 'CI_PASSED'])
  assert.deepEqual(runtime.eventQueue.seenKeys, ['active-low', 'queued-high', 'queued-low'])
})

test('failed delivery does not persist dedupe and a later occurrence retries', async () => {
  let succeed = false
  let calls = 0
  const { runtime, store } = setup(async () => {
    calls += 1
    return { ok: succeed }
  })
  const event = createEvent({ kind: 'FAILED', dedupeKey: 'retry-me' })
  runtime.notifyEvent(event)
  await drained(runtime)
  assert.deepEqual(store.state.dedupeKeys, [])

  succeed = true
  runtime.notifyEvent(createEvent({ kind: 'FAILED', dedupeKey: 'retry-me' }))
  await drained(runtime)
  assert.equal(calls, 2)
  assert.deepEqual(store.state.dedupeKeys, ['retry-me'])
})
