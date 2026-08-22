// Watch record vocabulary and the durable prompt payload encoding. A watch's
// metadata rides inside the schedule prompt as a single-line JSON marker so
// it survives restart alongside the durable schedule itself.

import { randomUUID } from 'node:crypto'
import { MIN_WATCH_INTERVAL_SECONDS } from '../config.js'

export const WATCH_MARKER = '[watch]'
export const WATCH_KINDS = Object.freeze(['github_codex_review'])
export const EXIT_CONDITIONS = Object.freeze(['codex_thumbs_up', 'pr_merged', 'manual'])

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function validateWatch(watch) {
  if (!watch || typeof watch !== 'object') throw new Error('watch must be an object')
  if (typeof watch.watchId !== 'string' || watch.watchId.trim() === '') throw new Error('watch.watchId must be a non-empty string')
  if (!WATCH_KINDS.includes(watch.kind)) throw new Error(`watch.kind must be one of: ${WATCH_KINDS.join(', ')}`)
  if (typeof watch.repo !== 'string' || !REPO_PATTERN.test(watch.repo)) throw new Error('watch.repo must be in owner/repo format')
  if (!Number.isInteger(watch.prNumber) || watch.prNumber <= 0) throw new Error('watch.prNumber must be a positive integer')
  if (!Number.isInteger(watch.everySeconds) || watch.everySeconds < MIN_WATCH_INTERVAL_SECONDS) {
    throw new Error(`watch.everySeconds must be an integer of at least ${MIN_WATCH_INTERVAL_SECONDS}`)
  }
  if (!EXIT_CONDITIONS.includes(watch.exitCondition)) throw new Error(`watch.exitCondition must be one of: ${EXIT_CONDITIONS.join(', ')}`)
  return watch
}

export function createWatch({ watchId = randomUUID(), kind = 'github_codex_review', repo, prNumber, everySeconds, exitCondition = 'codex_thumbs_up' }) {
  return validateWatch({
    version: 1,
    watchId,
    kind,
    repo,
    prNumber,
    everySeconds,
    exitCondition,
    lastFingerprint: undefined,
    scheduleId: undefined,
  })
}

export function encodeWatchPayload(watch) {
  return `${WATCH_MARKER} ${JSON.stringify(validateWatch(watch))}`
}

// Finds the marker line anywhere in surrounding text (schedule-reminder
// framing, user prose) and parses the JSON tail. Malformed payloads parse to
// undefined — never throw on untrusted text.
export function parseWatchPayload(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${WATCH_MARKER} `)) continue
    try {
      const parsed = JSON.parse(trimmed.slice(WATCH_MARKER.length + 1))
      return validateWatch(parsed)
    } catch {
      return undefined
    }
  }
  return undefined
}
