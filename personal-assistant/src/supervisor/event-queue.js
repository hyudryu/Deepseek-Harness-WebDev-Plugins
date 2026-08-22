const DEFAULT_DEDUPE_CACHE_SIZE = 500

// Priority queue for supervisor events. Highest priority (lowest number)
// first, FIFO within one priority. Dedupe keys become durable only after the
// consumer acknowledges successful delivery; pending keys still coalesce
// duplicate producers while an event is queued or in flight.
export class EventQueue {
  constructor({ dedupeCacheSize = DEFAULT_DEDUPE_CACHE_SIZE, seenKeys } = {}) {
    this.dedupeCacheSize = dedupeCacheSize
    this.buckets = new Map()
    this.seenKeys = seenKeys === undefined ? [] : [...seenKeys].slice(-dedupeCacheSize)
    this.seenSet = new Set(this.seenKeys)
    this.pendingSet = new Set()
  }

  push(event) {
    if (event.dedupeKey !== undefined && (this.seenSet.has(event.dedupeKey) || this.pendingSet.has(event.dedupeKey))) return false
    if (event.dedupeKey !== undefined) this.pendingSet.add(event.dedupeKey)
    const bucket = this.buckets.get(event.priority)
    if (bucket) bucket.push(event)
    else this.buckets.set(event.priority, [event])
    return true
  }

  peek() {
    const bucket = this.buckets.get(this.topPriority())
    return bucket === undefined ? undefined : bucket[0]
  }

  next() {
    const priority = this.topPriority()
    if (priority === undefined) return undefined
    const bucket = this.buckets.get(priority)
    const event = bucket.shift()
    if (bucket.length === 0) this.buckets.delete(priority)
    return event
  }

  ack(event) {
    const key = event?.dedupeKey
    if (key === undefined) return
    this.pendingSet.delete(key)
    if (this.seenSet.has(key)) return
    this.seenKeys.push(key)
    this.seenSet.add(key)
    if (this.seenKeys.length > this.dedupeCacheSize) {
      this.seenSet.delete(this.seenKeys.shift())
    }
  }

  release(event) {
    if (event?.dedupeKey !== undefined) this.pendingSet.delete(event.dedupeKey)
  }

  get size() {
    let total = 0
    for (const bucket of this.buckets.values()) total += bucket.length
    return total
  }

  clear() {
    this.buckets.clear()
    this.pendingSet.clear()
  }

  topPriority() {
    let best
    for (const priority of this.buckets.keys()) {
      if (best === undefined || priority < best) best = priority
    }
    return best
  }
}
