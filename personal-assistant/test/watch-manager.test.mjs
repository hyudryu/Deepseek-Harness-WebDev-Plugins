import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryStore } from '../src/sessions/assistant-store.js'
import { createWatchManager } from '../src/watches/watch-manager.js'

function reviewStateResult(overrides = {}) {
  return {
    latestActivity: { kind: 'none', actor: undefined, createdAt: undefined, text: undefined },
    codexThumbsUpOnMainPost: false,
    reviewComplete: false,
    prState: 'open',
    fingerprint: '',
    ...overrides,
  }
}

function setup(state = reviewStateResult(), notifications) {
  const store = createMemoryStore()
  const events = []
  const deletions = []
  let current = state
  const manager = createWatchManager({
    store,
    reviewState: async () => current,
    emitEvent: event => events.push(event),
    deleteSchedule: async args => deletions.push(args),
    notifications,
  })
  return {
    store,
    events,
    deletions,
    manager,
    setState: next => { current = next },
  }
}

const WATCH = { repo: 'acme/api', prNumber: 42, everySeconds: 300 }

test('thumbs-up tick: WATCH_CONDITION_MET, schedule deleted, watch terminal, no repeat', async () => {
  const { manager, events, deletions, store, setState } = setup()
  const { watch } = manager.createWatch(WATCH)
  manager.attachSchedule(watch.watchId, 'sched-1')
  setState(reviewStateResult({ codexThumbsUpOnMainPost: true, reviewComplete: true, fingerprint: 'thumbsup:RE1' }))

  const first = await manager.handleTick(watch.watchId)
  assert.equal(first.acted, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'WATCH_CONDITION_MET')
  assert.equal(events[0].dedupeKey, `watch:${watch.watchId}:thumbs-up:thumbsup:RE1`)
  assert.deepEqual(deletions, [{ scheduleId: 'sched-1', watchId: watch.watchId }])
  assert.equal(store.state.watches[0].status, 'terminal')
  assert.equal(store.state.watches[0].terminalReason, 'codex_thumbs_up')

  const second = await manager.handleTick(watch.watchId)
  assert.equal(second.acted, false)
  assert.equal(events.length, 1)
})

test('codex comment: exactly one REVIEW_RECEIVED per fingerprint', async () => {
  const { manager, events, setState } = setup()
  const { watch } = manager.createWatch(WATCH)
  setState(reviewStateResult({
    latestActivity: { kind: 'codex_comment', actor: 'codex', createdAt: '2026-08-20T10:00:00Z', text: 'Two findings.' },
    fingerprint: 'codex-comment:C1',
  }))
  await manager.handleTick(watch.watchId)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'REVIEW_RECEIVED')
  assert.equal(events[0].dedupeKey, 'pr:acme/api#42:codex-comment:codex-comment:C1')

  // same fingerprint again: silent
  await manager.handleTick(watch.watchId)
  assert.equal(events.length, 1)

  // a new codex comment: notifies again
  setState(reviewStateResult({
    latestActivity: { kind: 'codex_comment', actor: 'codex', createdAt: '2026-08-20T11:00:00Z', text: 'Fixed.' },
    fingerprint: 'codex-comment:C2',
  }))
  await manager.handleTick(watch.watchId)
  assert.equal(events.length, 2)
})

test('commit/push latest: silent, watch retained', async () => {
  const { manager, events, store, setState } = setup()
  const { watch } = manager.createWatch(WATCH)
  setState(reviewStateResult({ latestActivity: { kind: 'commit' }, fingerprint: 'commit:abc' }))
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(events.length, 0)
  assert.equal(store.state.watches[0].status, 'active')
})

test('merged PR terminates a codex_thumbs_up watch; manual watch keeps polling', async () => {
  const { manager, events, setState } = setup()
  const { watch } = manager.createWatch(WATCH)
  setState(reviewStateResult({ prState: 'merged', reviewComplete: true }))
  await manager.handleTick(watch.watchId)
  assert.equal(events[0].kind, 'WATCH_CONDITION_MET')
  assert.equal(events[0].payload.reason, 'pr_merged')

  const manual = setup(reviewStateResult({ prState: 'merged', reviewComplete: true }))
  const { watch: manualWatch } = manual.manager.createWatch({ ...WATCH, prNumber: 7, exitCondition: 'manual' })
  assert.equal((await manual.manager.handleTick(manualWatch.watchId)).acted, false)
  assert.equal(manual.events.length, 0)
})

test('manual watches keep polling after a Codex thumbs-up', async () => {
  const { manager, events, store } = setup(reviewStateResult({
    codexThumbsUpOnMainPost: true,
    reviewComplete: true,
    fingerprint: 'thumbsup:RE1',
  }))
  const { watch } = manager.createWatch({ ...WATCH, exitCondition: 'manual' })
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(events.length, 0)
  assert.equal(store.state.watches[0].status, 'active')
})

test('reviewReceived=false records the fingerprint without emitting', async () => {
  const state = reviewStateResult({
    latestActivity: { kind: 'codex_comment', actor: 'codex', text: 'Finding' },
    fingerprint: 'codex-comment:C1',
  })
  const { manager, events, store } = setup(state, { reviewReceived: false })
  const { watch } = manager.createWatch(WATCH)
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(events.length, 0)
  assert.equal(store.state.watches[0].lastFingerprint, 'codex-comment:C1')
})

test('concurrent ticks for one watch share one in-flight poll', async () => {
  const store = createMemoryStore()
  let release
  let calls = 0
  const manager = createWatchManager({
    store,
    reviewState: async () => {
      calls += 1
      await new Promise(resolve => { release = resolve })
      return reviewStateResult()
    },
    emitEvent: () => {},
    deleteSchedule: async () => {},
  })
  const { watch } = manager.createWatch(WATCH)
  const first = manager.handleTick(watch.watchId)
  const second = manager.handleTick(watch.watchId)
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [{ acted: false }, { acted: false }])
})

test('other-actor comment stays silent', async () => {
  const { manager, events, setState } = setup()
  const { watch } = manager.createWatch(WATCH)
  setState(reviewStateResult({ latestActivity: { kind: 'other_comment', actor: 'alice' }, fingerprint: 'comment:C9' }))
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(events.length, 0)
})

test('poll failures stay silent and keep the watch', async () => {
  const store = createMemoryStore()
  const manager = createWatchManager({
    store,
    reviewState: async () => { throw new Error('gh offline') },
    emitEvent: () => assert.fail('no event expected'),
    deleteSchedule: async () => {},
  })
  const { watch } = manager.createWatch(WATCH)
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(store.state.watches[0].status, 'active')
})

test('createWatch dedupes by repo + prNumber + kind', () => {
  const { manager, store } = setup()
  const first = manager.createWatch(WATCH)
  const second = manager.createWatch({ ...WATCH, everySeconds: 600 })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.watch.watchId, first.watch.watchId)
  assert.equal(store.state.watches.length, 1)
})

test('cancelWatch deletes the schedule and removes the record', async () => {
  const { manager, deletions, store } = setup()
  const { watch } = manager.createWatch(WATCH)
  manager.attachSchedule(watch.watchId, 'sched-9')
  const result = await manager.cancelWatch(watch.watchId)
  assert.equal(result.cancelled, true)
  assert.deepEqual(deletions, [{ scheduleId: 'sched-9', watchId: watch.watchId }])
  assert.equal(store.state.watches.length, 0)
  await assert.rejects(() => manager.cancelWatch('watch-gone'), /watch_list/)
})

test('a pr_merged watch ignores a Codex thumbs-up', async () => {
  const { manager, events, store } = setup(reviewStateResult({
    codexThumbsUpOnMainPost: true,
    reviewComplete: true,
    fingerprint: 'thumbsup:RE1',
  }))
  const { watch } = manager.createWatch({ ...WATCH, exitCondition: 'pr_merged' })
  assert.equal((await manager.handleTick(watch.watchId)).acted, false)
  assert.equal(events.length, 0)
  assert.equal(store.state.watches[0].status, 'active')
})

test('canceling during an in-flight poll suppresses its late result', async () => {
  const store = createMemoryStore()
  const events = []
  let release
  const manager = createWatchManager({
    store,
    reviewState: async () => {
      await new Promise(resolve => { release = resolve })
      return reviewStateResult({
        latestActivity: { kind: 'codex_comment', actor: 'codex', text: 'Finding' },
        fingerprint: 'codex-comment:C1',
      })
    },
    emitEvent: event => events.push(event),
    deleteSchedule: async () => {},
  })
  const { watch } = manager.createWatch(WATCH)
  const pending = manager.handleTick(watch.watchId)
  await manager.cancelWatch(watch.watchId)
  release()
  assert.deepEqual(await pending, { acted: false })
  assert.equal(events.length, 0)
})

test('recover() sorts durable watches into scheduled vs needs-timer', async () => {
  const store = createMemoryStore()
  store.state.watches.push(
    { version: 1, watchId: 'w-sched', kind: 'github_codex_review', repo: 'acme/api', prNumber: 1, everySeconds: 300, exitCondition: 'codex_thumbs_up', scheduleId: 'sched-1', status: 'active' },
    { version: 1, watchId: 'w-timer', kind: 'github_codex_review', repo: 'acme/api', prNumber: 2, everySeconds: 300, exitCondition: 'codex_thumbs_up', status: 'active' },
    { version: 1, watchId: 'w-done', kind: 'github_codex_review', repo: 'acme/api', prNumber: 3, everySeconds: 300, exitCondition: 'codex_thumbs_up', status: 'terminal' },
  )
  const manager = createWatchManager({ store, reviewState: async () => reviewStateResult(), emitEvent: () => {}, deleteSchedule: async () => {} })
  const summary = await manager.recover()
  assert.deepEqual(summary.scheduled, ['w-sched'])
  assert.deepEqual(summary.needsTimer.map(watch => watch.watchId), ['w-timer'])
  // terminal watches are not re-armed; a terminal tick is a no-op
  assert.equal(manager.listWatches().length, 3)
})

test('a failed schedule delete keeps a tombstone that recover() retries', async () => {
  const store = createMemoryStore()
  const deletions = []
  let failDelete = true
  const manager = createWatchManager({
    store,
    reviewState: async () => reviewStateResult(),
    emitEvent: () => {},
    deleteSchedule: async args => {
      if (failDelete) throw new Error('schedule service down')
      deletions.push(args)
    },
  })
  const { watch } = manager.createWatch(WATCH)
  manager.attachSchedule(watch.watchId, 'sched-7')

  const result = await manager.cancelWatch(watch.watchId)
  assert.equal(result.cancelled, true)
  assert.equal(result.scheduleDeletePending, true)
  // the record survives as a terminal tombstone holding the schedule id
  assert.equal(store.state.watches.length, 1)
  assert.equal(store.state.watches[0].status, 'terminal')
  assert.equal(store.state.watches[0].scheduleId, 'sched-7')

  // next boot: recover retries the delete; success forgets the tombstone
  failDelete = false
  await manager.recover()
  assert.deepEqual(deletions, [{ scheduleId: 'sched-7', watchId: watch.watchId }])
  assert.equal(store.state.watches.length, 0)
})
