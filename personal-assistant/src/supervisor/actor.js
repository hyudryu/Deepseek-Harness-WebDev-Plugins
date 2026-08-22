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
    this.reservedQuestionIds = new Set()
    this.state = {
      activePresentation: false,
      pendingQuestions: [],
      queuedEvents: 0,
    }
  }

  submitEvent(event) {
    return this.enqueue({ type: 'event', event })
  }

  submitUserAnswer(text) {
    let question
    let ambiguousQuestions
    const available = this.state.pendingQuestions.filter(candidate => !this.reservedQuestionIds.has(candidate.eventId))
    if (available.length === 1) {
      question = available[0]
    } else if (available.length > 1) {
      const matches = available.filter(candidate =>
        text.includes(candidate.eventId) || (candidate.sourceSessionId !== undefined && text.includes(candidate.sourceSessionId)),
      )
      if (matches.length === 1) {
        question = matches[0]
      } else {
        ambiguousQuestions = available.map(candidate => ({ ...candidate }))
      }
    }
    if (question) this.reservedQuestionIds.add(question.eventId)
    return this.enqueue({ type: 'answer', text, question, ambiguousQuestions })
  }

  enqueue(item) {
    const completion = new Promise(resolve => {
      this.queue.push({ ...item, resolve })
    })
    this.state.queuedEvents = this.queue.length
    this.kick()
    return completion
  }

  kick() {
    if (this.draining) return
    this.draining = true
    this.drainPromise = this.drain().finally(() => {
      this.draining = false
      if (this.queue.length > 0) this.kick()
    })
  }

  async drain() {
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      this.state.queuedEvents = this.queue.length
      this.state.activePresentation = true
      let outcome
      try {
        const prompt = item.type === 'answer'
          ? buildAnswerPrompt(item.text, item.question, item.ambiguousQuestions)
          : buildEventPrompt(item.event)
        const response = await this.invoke(prompt)
        const presented = await this.present(response, item)
        if (presented === false) throw new Error('notification was not presented to the control session')
        if (typeof presented === 'object' && presented !== null && 'ok' in presented && presented.ok === false) {
          throw new Error(presented.reason ?? 'notification was refused by control session')
        }
        if (item.type === 'event' && QUESTION_KINDS.includes(item.event.kind)) {
          this.state.pendingQuestions.push({
            eventId: item.event.id,
            kind: item.event.kind,
            sourceSessionId: item.event.sourceSessionId,
            friendlyName: item.event.friendlyName,
          })
        } else if (item.type === 'answer' && item.question) {
          this.state.pendingQuestions = this.state.pendingQuestions.filter(candidate => candidate.eventId !== item.question.eventId)
          this.reservedQuestionIds.delete(item.question.eventId)
        }
        outcome = { ok: true }
      } catch (error) {
        if (item.type === 'answer' && item.question) this.reservedQuestionIds.delete(item.question.eventId)
        try {
          if (this.onError) this.onError(error, item)
        } catch {}
        outcome = { ok: false, error }
      } finally {
        this.state.activePresentation = false
        item.resolve(outcome)
      }
    }
  }
}
