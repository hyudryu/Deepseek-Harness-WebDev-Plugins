import { randomUUID } from 'node:crypto'
import { parseWatchPayload } from './watch-types.js'

// Delivery framing emitted by dsh-schedule when a reminder comes due (read
// from dsh-schedule/lib/index.js renderReminderFraming/renderEveryReminderBatchFraming).
const REMINDER_HEADER = '[SCHEDULE REMINDER]'
const BATCH_HEADER = '[SCHEDULE REMINDER BATCH]'

// Bridges watches onto Harness scheduling. Primary path: the durable
// agent-scoped schedule_create/schedule_delete tools (they survive restart).
// Fallback: an in-process recurring timer, used when the schedule tool is
// missing or refuses (boot order is not guaranteed for our control agent).
export function createScheduleBridge({ ctx, agent, logger, setIntervalImpl, clearIntervalImpl } = {}) {
  const timers = new Map()
  // Set by the runtime once the watch manager exists (manager ↔ bridge cycle).
  let onTick

  // cordis ctx.setInterval returns a disposer; the global returns a handle
  // passed to clearInterval. The pair must match, so both are chosen here.
  const useCordisTimers = setIntervalImpl === undefined && typeof ctx.setInterval === 'function'
  const startTimer = setIntervalImpl ?? (useCordisTimers
    ? ctx.setInterval.bind(ctx)
    : (callback, ms) => {
      const timer = setInterval(callback, ms)
      timer.unref?.()
      return timer
    })
  const stopTimer = clearIntervalImpl ?? (useCordisTimers
    ? disposer => disposer()
    : timer => clearInterval(timer))

  async function execute(name, args) {
    const result = await ctx.tools.execute({
      callId: randomUUID(),
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(result.error?.message ?? `tool ${name} failed`)
    return result.value
  }

  function armInternalTimer(watchId, everySeconds) {
    disarmInternalTimer(watchId)
    timers.set(watchId, startTimer(() => onTick?.(watchId), everySeconds * 1000))
  }

  function disarmInternalTimer(watchId) {
    const timer = timers.get(watchId)
    if (timer !== undefined) {
      stopTimer(timer)
      timers.delete(watchId)
    }
  }

  async function createRecurring({ watchId, everySeconds, prompt }) {
    try {
      const value = await execute('schedule_create', { prompt, every_seconds: everySeconds })
      if (typeof value?.id !== 'string') {
        throw new Error(value?.message ?? 'schedule_create returned no schedule id')
      }
      return { scheduleId: value.id, fallback: false }
    } catch (error) {
      logger?.warn?.(`personal-assistant: schedule_create unavailable (${error instanceof Error ? error.message : String(error)}); using an in-process timer — this watch will not survive restart scheduling`)
      armInternalTimer(watchId, everySeconds)
      return { fallback: true }
    }
  }

  // The internal timer is always disarmed; a failed durable delete is
  // rethrown so the caller can keep a tombstone and retry (otherwise the
  // recurring schedule survives with no record holding its id).
  async function deleteSchedule({ scheduleId, watchId }) {
    disarmInternalTimer(watchId)
    if (typeof scheduleId !== 'string') return
    try {
      await execute('schedule_delete', { id: scheduleId })
    } catch (error) {
      logger?.warn?.(`personal-assistant: schedule_delete failed for ${scheduleId}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  // Parses due-reminder framing into watch ticks. Single reminders yield
  // { watchId }; a batch yields { watchIds } plus `forwarded`: the prompts of
  // any non-watch reminders in the batch, which the caller must still route
  // to the supervisor (a mixed batch must not swallow ordinary reminders).
  // Batches without any watch payload and unparseable payloads return
  // undefined (left for the normal path).
  function onReminderText(text) {
    if (typeof text !== 'string') return undefined
    if (text.startsWith(BATCH_HEADER)) {
      const line = text.split('\n').find(candidate => candidate.startsWith('reminders_json: '))
      if (!line) return undefined
      try {
        const reminders = JSON.parse(line.slice('reminders_json: '.length))
        const watchIds = []
        const forwarded = []
        for (const reminder of reminders) {
          const watchId = parseWatchPayload(reminder.reminder_prompt)?.watchId
          if (watchId === undefined) forwarded.push(reminder.reminder_prompt)
          else watchIds.push(watchId)
        }
        return watchIds.length > 0 ? { watchIds, forwarded } : undefined
      } catch {
        return undefined
      }
    }
    if (text.startsWith(REMINDER_HEADER)) {
      const line = text.split('\n').find(candidate => candidate.startsWith('reminder_prompt_json: '))
      if (!line) return undefined
      try {
        const watch = parseWatchPayload(JSON.parse(line.slice('reminder_prompt_json: '.length)))
        return watch === undefined ? undefined : { watchId: watch.watchId }
      } catch {
        return undefined
      }
    }
    return undefined
  }

  function dispose() {
    for (const watchId of [...timers.keys()]) disarmInternalTimer(watchId)
  }

  return {
    createRecurring,
    deleteSchedule,
    armInternalTimer,
    disarmInternalTimer,
    onReminderText,
    dispose,
    set onTick(handler) { onTick = handler },
  }
}
