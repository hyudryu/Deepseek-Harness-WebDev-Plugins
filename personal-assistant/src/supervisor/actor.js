import { QUESTION_KINDS } from './event-types.js'
import { buildAnswerPrompt, buildEventPrompt } from './prompt.js'

// Single-threaded actor that serializes all Strands invocations: Strands
// throws ConcurrentInvocationError on overlapping invoke() calls, so every
// piece of work (session events, user answers) drains through one queue,
// one at a time. The drain-loop guard makes overlap impossible by
// construction.
export class SupervisorActor {
  constructor({ invoke, present, onError } = {}) {
    if (typeof invoke !== 'function') throw new Error('SupervisorActor: invoke is required')
    if (typeof present !== 'function') throw new Error('SupervisorActor: present is required')
    this.invoke = invoke
    this.present = present
    this.onError = onError
    this.queue = []
    this.draining = false
    this.state = {
      activePresentation: false,
      pendingQuestion: undefined,
      queuedEvents: 0,
    }
  }

  submitEvent(event) {
    this.queue.push({ type: 'event', event })
    this.state.queuedEvents = this.queue.length
    this.kick()
  }

  submitUserAnswer(text) {
    // Bind the answer to the question that is pending RIGHT NOW; later
    // presentations must not steal it.
    const question = this.state.pendingQuestion
    this.state.pendingQuestion = undefined
    this.queue.push({ type: 'answer', text, question })
    this.state.queuedEvents = this.queue.length
    this.kick()
  }

  kick() {
    if (this.draining) return
    this.draining = true
    this.drainPromise = this.drain().finally(() => {
      this.draining = false
    })
  }

  async drain() {
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      this.state.queuedEvents = this.queue.length
      this.state.activePresentation = true
      try {
        const prompt = item.type === 'answer' ? buildAnswerPrompt(item.text, item.question) : buildEventPrompt(item.event)
        const response = await this.invoke(prompt)
        await this.present(response, item)
        if (item.type === 'event' && QUESTION_KINDS.includes(item.event.kind)) {
          this.state.pendingQuestion = { eventId: item.event.id, kind: item.event.kind }
        }
      } catch (error) {
        if (this.onError) this.onError(error, item)
      } finally {
        this.state.activePresentation = false
      }
    }
  }
}
