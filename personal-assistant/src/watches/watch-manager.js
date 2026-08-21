import { createEvent } from '../supervisor/event-types.js'
import { createWatch, validateWatch } from './watch-types.js'

// Durable watch bookkeeping and tick decisions. All side effects are
// injected: reviewState (the Phase-4 pipeline), emitEvent (into the
// supervisor EventQueue), deleteSchedule (the schedule bridge). Watches
// persist in the assistant store's `watches` array and survive restarts.
export function createWatchManager({ store, reviewState, emitEvent, deleteSchedule, now, logger } = {}) {
  const clock = now ?? (() => Date.now())

  function activeWatches() {
    return store.state.watches.filter(watch => watch.status === 'active')
  }

  function findWatch(watchId) {
    return store.state.watches.find(watch => watch.watchId === watchId)
  }

  function createWatchRecord({ repo, prNumber, everySeconds, exitCondition }) {
    const existing = activeWatches().find(
      watch => watch.kind === 'github_codex_review' && watch.repo === repo && watch.prNumber === prNumber,
    )
    if (existing) return { watch: { ...existing }, created: false }
    const watch = { ...createWatch({ repo, prNumber, everySeconds, exitCondition }), status: 'active', createdAt: clock() }
    store.state.watches.push(watch)
    store.save()
    return { watch: { ...watch }, created: true }
  }

  function attachSchedule(watchId, scheduleId) {
    const watch = findWatch(watchId)
    if (!watch) throw new Error(`watch "${watchId}" not found`)
    watch.scheduleId = scheduleId
    store.save()
  }

  async function terminate(watch, reason, fingerprint) {
    watch.status = 'terminal'
    watch.terminalReason = reason
    watch.terminalAt = clock()
    store.save()
    emitEvent(createEvent({
      kind: 'WATCH_CONDITION_MET',
      dedupeKey: `watch:${watch.watchId}:thumbs-up:${fingerprint}`,
      payload: { repo: watch.repo, prNumber: watch.prNumber, reason },
    }))
    await deleteSchedule({ scheduleId: watch.scheduleId, watchId: watch.watchId })
  }

  async function handleTick(watchId) {
    const watch = findWatch(watchId)
    if (!watch || watch.status !== 'active') return { acted: false }
    let state
    try {
      state = await reviewState({ repo: watch.repo, prNumber: watch.prNumber })
    } catch (error) {
      // Transient gh/network failures stay silent; the watch keeps polling.
      logger?.warn?.(`personal-assistant: watch ${watchId} poll failed: ${error instanceof Error ? error.message : String(error)}`)
      return { acted: false }
    }

    if (state.codexThumbsUpOnMainPost) {
      await terminate(watch, 'codex_thumbs_up', state.fingerprint)
      return { acted: true }
    }
    if ((state.prState === 'merged' || state.prState === 'closed') && watch.exitCondition !== 'manual') {
      await terminate(watch, `pr_${state.prState}`, state.fingerprint)
      return { acted: true }
    }
    if (state.latestActivity.kind === 'codex_comment' && state.fingerprint !== watch.lastFingerprint) {
      watch.lastFingerprint = state.fingerprint
      store.save()
      emitEvent(createEvent({
        kind: 'REVIEW_RECEIVED',
        dedupeKey: `pr:${watch.repo}#${watch.prNumber}:codex-comment:${state.fingerprint}`,
        payload: { repo: watch.repo, prNumber: watch.prNumber, text: state.latestActivity.text },
      }))
      return { acted: true }
    }
    // commit/push/other_comment/none, or an unchanged fingerprint: silent.
    return { acted: false }
  }

  async function cancelWatch(watchId) {
    const watch = findWatch(watchId)
    if (!watch) throw new Error(`watch "${watchId}" not found — call watch_list to see active watches`)
    await deleteSchedule({ scheduleId: watch.scheduleId, watchId })
    store.state.watches = store.state.watches.filter(candidate => candidate.watchId !== watchId)
    store.save()
    return { watchId, cancelled: true }
  }

  function listWatches() {
    return store.state.watches.map(watch => ({ ...watch }))
  }

  // Boot recovery: watches with a scheduleId are durable in dsh-schedule and
  // assumed live; timer-fallback watches must be re-armed by the caller
  // (the bridge owns timers).
  function recover() {
    const durable = store.state.watches.filter(watch => watch.status === undefined || watch.status === 'active')
    for (const watch of durable) {
      watch.status = 'active'
      validateWatch(watch)
    }
    store.save()
    return {
      scheduled: durable.filter(watch => typeof watch.scheduleId === 'string').map(watch => watch.watchId),
      needsTimer: durable.filter(watch => typeof watch.scheduleId !== 'string'),
    }
  }

  return { createWatch: createWatchRecord, attachSchedule, handleTick, cancelWatch, listWatches, recover }
}
