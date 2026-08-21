const DEFAULT_DEDUPE_CACHE_SIZE = 500

// Priority queue for supervisor events. Highest priority (lowest number)
// first, FIFO within one priority. Events with a dedupeKey already seen
// recently are dropped on push.
export class EventQueue {
  constructor({ dedupeCacheSize = DEFAULT_DEDUPE_CACHE_SIZE, seenKeys } = {}) {
    this.dedupeCacheSize = dedupeCacheSize
    this.buckets = new Map()
    this.seenKeys = seenKeys === undefined ? [] : [...seenKeys].slice(-dedupeCacheSize)
    this.seenSet = new Set(this.seenKeys)
  }

  push(event) {
    if (event.dedupeKey !== undefined && this.seenSet.has(event.dedupeKey)) return false
    if (event.dedupeKey !== undefined) {
      this.seenKeys.push(event.dedupeKey)
      this.seenSet.add(event.dedupeKey)
      if (this.seenKeys.length > this.dedupeCacheSize) {
        this.seenSet.delete(this.seenKeys.shift())
      }
    }
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

  get size() {
    let total = 0
    for (const bucket of this.buckets.values()) total += bucket.length
    return total
  }

  clear() {
    this.buckets.clear()
  }

  topPriority() {
    let best
    for (const priority of this.buckets.keys()) {
      if (best === undefined || priority < best) best = priority
    }
    return best
  }
}
