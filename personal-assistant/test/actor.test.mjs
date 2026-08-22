import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SupervisorActor } from '../src/supervisor/actor.js'
import { createEvent } from '../src/supervisor/event-types.js'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function drained(actor) {
  while (actor.draining || actor.queue.length > 0) await actor.drainPromise
}

test('invocations are serialized: no overlap, submission order preserved', async () => {
  const calls = []
  let active = false
  const actor = new SupervisorActor({
    invoke: async prompt => {
      assert.equal(active, false, 'overlapping invocation detected')
      active = true
      await sleep(30)
      active = false
      calls.push(prompt)
      return `response ${calls.length}`
    },
    present: () => {},
  })

  actor.submitEvent(createEvent({ kind: 'FAILED' }))
  await sleep(5) // first invocation is now in flight
  actor.submitEvent(createEvent({ kind: 'COMPLETED' }))
  actor.submitEvent(createEvent({ kind: 'BLOCKED' }))
  actor.submitEvent(createEvent({ kind: 'COMPLETED' }))
  await drained(actor)

  assert.equal(calls.length, 4)
  assert.ok(calls[0].includes('FAILED'))
  assert.ok(calls[1].includes('COMPLETED'))
  assert.ok(calls[2].includes('BLOCKED'))
  assert.ok(calls[3].includes('COMPLETED'))
})

test('user answer binds to the pending question', async () => {
  const prompts = []
  const questionEvent = createEvent({ kind: 'INPUT_REQUIRED' })
  const actor = new SupervisorActor({
    invoke: async prompt => {
      prompts.push(prompt)
      return 'noted'
    },
    present: () => {},
  })

  actor.submitEvent(questionEvent)
  await drained(actor)
  assert.deepEqual(actor.state.pendingQuestions, [{
    eventId: questionEvent.id,
    kind: 'INPUT_REQUIRED',
    sourceSessionId: undefined,
    friendlyName: undefined,
  }])

  actor.submitUserAnswer('yes, go ahead')
  await drained(actor)
  assert.deepEqual(actor.state.pendingQuestions, [])
  assert.equal(prompts.length, 2)
  assert.ok(prompts[1].includes(questionEvent.id))
  assert.ok(prompts[1].includes('yes, go ahead'))
})

test('non-question events do not create a pending question', async () => {
  const actor = new SupervisorActor({ invoke: async () => 'ok', present: () => {} })
  actor.submitEvent(createEvent({ kind: 'COMPLETED' }))
  await drained(actor)
  assert.deepEqual(actor.state.pendingQuestions, [])
})

test('multiple unresolved questions require event or session disambiguation', async () => {
  const prompts = []
  const first = createEvent({ kind: 'INPUT_REQUIRED', sourceSessionId: 'session-a', friendlyName: 'Alpha' })
  const second = createEvent({ kind: 'INPUT_REQUIRED', sourceSessionId: 'session-b', friendlyName: 'Beta' })
  const actor = new SupervisorActor({
    invoke: async prompt => { prompts.push(prompt); return 'noted' },
    present: () => {},
  })
  actor.submitEvent(first)
  actor.submitEvent(second)
  await drained(actor)
  assert.equal(actor.state.pendingQuestions.length, 2)

  actor.submitUserAnswer('yes, proceed')
  await drained(actor)
  assert.equal(actor.state.pendingQuestions.length, 2)
  assert.ok(prompts.at(-1).includes('Multiple session questions are unresolved'))

  actor.submitUserAnswer('For session-b: use the safe option.')
  await drained(actor)
  assert.equal(actor.state.pendingQuestions.length, 1)
  assert.equal(actor.state.pendingQuestions[0].eventId, first.id)
  assert.ok(prompts.at(-1).includes(second.id))
})

test('a failed answer invocation leaves its question unresolved', async () => {
  let calls = 0
  const event = createEvent({ kind: 'INPUT_REQUIRED', sourceSessionId: 'session-a' })
  const actor = new SupervisorActor({
    invoke: async () => {
      calls += 1
      if (calls === 2) throw new Error('temporary failure')
      return 'question presented'
    },
    present: () => {},
  })
  actor.submitEvent(event)
  await drained(actor)
  actor.submitUserAnswer('yes')
  await drained(actor)
  assert.equal(actor.state.pendingQuestions.length, 1)
  assert.equal(actor.state.pendingQuestions[0].eventId, event.id)
  assert.equal(actor.reservedQuestionIds.size, 0)
})

test('queue keeps accepting submissions during presentation', async () => {
  const presented = []
  let held = true
  let releaseInvoke
  const actor = new SupervisorActor({
    invoke: () => held
      ? new Promise(resolve => {
        releaseInvoke = () => {
          held = false
          resolve('held')
        }
      })
      : Promise.resolve('held'),
    present: text => presented.push(text),
  })

  actor.submitEvent(createEvent({ kind: 'FAILED' }))
  await sleep(5)
  assert.equal(actor.state.activePresentation, true)

  actor.submitEvent(createEvent({ kind: 'COMPLETED' }))
  actor.submitUserAnswer('more context')
  assert.equal(actor.state.queuedEvents, 2)

  releaseInvoke()
  await drained(actor)
  assert.deepEqual(presented, ['held', 'held', 'held'])
  assert.equal(actor.state.queuedEvents, 0)
})

test('invoke errors are routed to onError and do not stall the queue', async () => {
  const errors = []
  const presented = []
  let calls = 0
  const actor = new SupervisorActor({
    invoke: async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return 'fine'
    },
    present: text => presented.push(text),
    onError: error => errors.push(error.message),
  })
  actor.submitEvent(createEvent({ kind: 'FAILED' }))
  actor.submitEvent(createEvent({ kind: 'COMPLETED' }))
  await drained(actor)
  assert.deepEqual(errors, ['boom'])
  assert.deepEqual(presented, ['fine'])
})
