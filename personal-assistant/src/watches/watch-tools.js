import { encodeWatchPayload, EXIT_CONDITIONS } from './watch-types.js'
import { MIN_WATCH_INTERVAL_SECONDS } from '../config.js'

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function publicWatch(watch) {
  return {
    watchId: watch.watchId,
    kind: watch.kind,
    repo: watch.repo,
    prNumber: watch.prNumber,
    everySeconds: watch.everySeconds,
    exitCondition: watch.exitCondition,
    status: watch.status,
    scheduleId: watch.scheduleId,
  }
}

// Pure tool specs; the runtime wraps them with the policy-enforcing tool() seam.
export function createWatchToolSpecs({ watchManager, scheduleBridge, config }) {
  return [
    {
      name: 'watch_create',
      description: 'Watch a GitHub PR for Codex review activity. Notifies when Codex comments; ends when Codex thumbs-up the main post or the PR merges. Creating a duplicate watch returns the existing one.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'pr_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo, e.g. "acme/api".' },
          pr_number: { type: 'integer' },
          every_seconds: { type: 'integer', description: `Poll interval, at least ${MIN_WATCH_INTERVAL_SECONDS}. Defaults to the configured default watch interval.` },
          exit_condition: { type: 'string', enum: [...EXIT_CONDITIONS] },
        },
      },
      callback: async (args = {}) => {
        if (typeof args.repo !== 'string' || !REPO_PATTERN.test(args.repo)) {
          throw new Error('watch_create: repo must be in owner/repo format, e.g. "acme/api"')
        }
        if (!Number.isInteger(args.pr_number) || args.pr_number <= 0) throw new Error('watch_create: pr_number must be a positive integer')
        const everySeconds = args.every_seconds ?? config.github.defaultWatchIntervalSeconds
        if (!Number.isInteger(everySeconds) || everySeconds < MIN_WATCH_INTERVAL_SECONDS) {
          throw new Error(`watch_create: every_seconds must be an integer of at least ${MIN_WATCH_INTERVAL_SECONDS}`)
        }
        const { watch, created } = watchManager.createWatch({
          repo: args.repo,
          prNumber: args.pr_number,
          everySeconds,
          exitCondition: args.exit_condition ?? 'codex_thumbs_up',
        })
        if (!created) return { ok: true, created: false, watch: publicWatch(watch) }
        const schedule = await scheduleBridge.createRecurring({
          watchId: watch.watchId,
          everySeconds: watch.everySeconds,
          prompt: encodeWatchPayload(watch),
        })
        if (schedule.scheduleId) watchManager.attachSchedule(watch.watchId, schedule.scheduleId)
        return { ok: true, created: true, watch: publicWatch(watchManager.listWatches().find(w => w.watchId === watch.watchId)), fallback: schedule.fallback === true }
      },
    },
    {
      name: 'watch_list',
      description: 'List all durable watches (active and terminal).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      callback: async () => ({ ok: true, watches: watchManager.listWatches().map(publicWatch) }),
    },
    {
      name: 'watch_cancel',
      description: 'Cancel one watch by exact watch id (from watch_list). Deletes its schedule and removes the durable record.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['watch_id'],
        properties: {
          watch_id: { type: 'string' },
        },
      },
      callback: async (args = {}) => {
        if (typeof args.watch_id !== 'string' || args.watch_id.trim() === '') throw new Error('watch_cancel: watch_id is required')
        const result = await watchManager.cancelWatch(args.watch_id)
        return { ok: true, ...result }
      },
    },
  ]
}
