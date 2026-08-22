import { createEvent } from '../supervisor/event-types.js'
import { createWatch, validateWatch } from './watch-types.js'

// Durable watch bookkeeping and tick decisions. All side effects are
// injected: reviewState (the Phase-4 pipeline), emitEvent (into the
// supervisor EventQueue), deleteSchedule (the schedule bridge). Watches
// persist in the assistant store's `watches` array and survive restarts.
export function createWatchManager({ store, reviewState, emitEvent, deleteSchedule, notifications = {}, now, logger } = {}) {
  const clock = now ?? (() => Date.now())
  const inFlight = new Map()

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

  function isActive(watchId) {
    const candidate = findWatch(watchId)
    return candidate !== undefined && candidate.status === 'active'
  }

  async function pollWatch(watchId) {
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

    if (!isActive(watchId)) return { acted: false }

    if (state.codexThumbsUpOnMainPost && watch.exitCondition === 'codex_thumbs_up') {
      await terminate(watch, 'codex_thumbs_up', state.fingerprint)
      return { acted: true }
    }
    if (state.prState === 'merged' && state.reviewComplete && watch.exitCondition !== 'manual') {
      await terminate(watch, `pr_${state.prState}`, state.fingerprint)
      return { acted: true }
    }
    if (state.latestActivity.kind === 'codex_comment' && state.fingerprint !== watch.lastFingerprint) {
      watch.lastFingerprint = state.fingerprint
      store.save()
      if (notifications.reviewReceived === false) return { acted: false }
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

  function handleTick(watchId) {
    const existing = inFlight.get(watchId)
    if (existing) return existing
    const pending = pollWatch(watchId).finally(() => {
      if (inFlight.get(watchId) === pending) inFlight.delete(watchId)
    })
    inFlight.set(watchId, pending)
    return pending
  }

  async function cancelWatch(watchId) {
    const watch = findWatch(watchId)
    if (!watch) throw new Error(`watch "${watchId}" not found — call watch_list to see active watches`)
    const pending = inFlight.get(watchId)
    if (pending !== undefined) inFlight.delete(watchId)
    watch.status = 'terminal'
    watch.terminalReason = 'cancelled'
    watch.terminalAt = clock()
    try {
      await deleteSchedule({ scheduleId: watch.scheduleId, watchId })
    } catch (error) {
      // Keep the tombstone: it holds the schedule id, and recover() retries
      // the durable delete on the next start.
      store.save()
      logger?.warn?.(`personal-assistant: watch ${watchId} cancelled but its schedule could not be deleted yet: ${error instanceof Error ? error.message : String(error)}`)
      return { watchId, cancelled: true, scheduleDeletePending: true }
    }
    store.state.watches = store.state.watches.filter(candidate => candidate.watchId !== watchId)
    store.save()
    return { watchId, cancelled: true }
  }

  function listWatches() {
    return store.state.watches.map(watch => ({ ...watch }))
  }

  // Boot recovery: terminal watches still holding a scheduleId are deletion
  // tombstones — retry the durable delete and forget them once it succeeds.
  // Active watches with a scheduleId are durable in dsh-schedule and assumed
  // live; timer-fallback watches must be re-armed by the caller (the bridge
  // owns timers).
  async function recover() {
    const tombstones = store.state.watches.filter(watch => watch.status === 'terminal' && typeof watch.scheduleId === 'string')
    for (const tombstone of tombstones) {
      try {
        await deleteSchedule({ scheduleId: tombstone.scheduleId, watchId: tombstone.watchId })
        store.state.watches = store.state.watches.filter(candidate => candidate.watchId !== tombstone.watchId)
      } catch {
        // Still unreachable; the tombstone stays for the next restart.
      }
    }
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
