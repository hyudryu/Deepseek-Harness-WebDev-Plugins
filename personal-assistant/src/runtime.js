import { tool } from '@strands-agents/sdk'
import { createNotifier } from './supervisor/notify.js'
import { createSupervisorAgent, invoke as invokeSupervisor } from './supervisor/agent.js'
import { buildSystemPrompt } from './supervisor/prompt.js'
import { SupervisorActor } from './supervisor/actor.js'
import { EventQueue } from './supervisor/event-queue.js'
import { enforcePermissions } from './supervisor/permissions.js'
import { SessionIndex } from './sessions/session-index.js'
import { createSessionToolSpecs } from './sessions/session-tools.js'
import { createJsonFileStore } from './sessions/assistant-store.js'
import { eventForIdleTransition } from './sessions/completion-classifier.js'
import { createTerminalBridge } from './terminal/terminal-bridge.js'
import { createTuiToolSpecs } from './terminal/tui-tools.js'
import { createGithubClient } from './github/github-client.js'
import { createGithubToolSpecs } from './github/github-tools.js'
import { computePrReviewState } from './github/pr-review-state.js'
import { createScheduleBridge } from './watches/schedule-bridge.js'
import { createWatchManager } from './watches/watch-manager.js'
import { createWatchToolSpecs } from './watches/watch-tools.js'

// Fixed identity for the ONE control session, so a Harness restart resumes it
// instead of stacking a fresh one.
export const CONTROL_SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const CONTROL_SESSION_TITLE = 'Personal Assistant'

function messageText(message) {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export class PersonalAssistantRuntime {
  constructor(ctx, config, { store, idleDebounceMs = 500 } = {}) {
    this.ctx = ctx
    this.config = config
    this.logger = ctx.logger
    this.idleDebounceMs = idleDebounceMs
    this.idleTimers = new Map()
    this.eventDispatching = false
    this.store = store ?? createJsonFileStore({ logger: this.logger })
    this.eventQueue = new EventQueue({ seenKeys: this.store.state.dedupeKeys })
    this.sessionIndex = new SessionIndex({ excludeSessionId: CONTROL_SESSION_ID, store: this.store })
  }

  async start() {
    const { ctx } = this

    ctx.effect(() => ctx.on('agent/created', payload => this.sessionIndex.noteAgentCreated(payload)))
    ctx.effect(() => ctx.on('agent/status', payload => this.onAgentStatus(payload)))
    ctx.effect(() => ctx.on('agent/disposed', payload => this.sessionIndex.noteAgentDisposed(payload)))
    ctx.effect(() => ctx.on('session/event', (session, event) => this.sessionIndex.noteSessionEvent(session, event)))
    ctx.effect(() => () => {
      for (const timer of this.idleTimers.values()) clearTimeout(timer)
      return this.store.flush()
    })

    // Sessions already running when the plugin loads get indexed too.
    for (const agent of ctx.agents.list()) this.sessionIndex.noteAgentCreated({ agent })

    const setup = agentCtx => {
      agentCtx.on('agent/pre-step', payload => this.onPreStep(payload))
    }

    let handle
    try {
      handle = await ctx.agents.resume({ resumeSessionId: CONTROL_SESSION_ID, setup })
    } catch {
      handle = await ctx.agents.create({ sessionId: CONTROL_SESSION_ID, meta: { cwd: process.cwd() }, setup })
    }
    this.agent = handle.agent
    this.controlSession = handle.agent.session
    ctx.effect(() => () => handle.dispose().catch(() => {}))

    try {
      ctx.get('sessionTitle')?.rename(this.controlSession, CONTROL_SESSION_TITLE)
    } catch (error) {
      this.logger?.info?.(`personal-assistant: could not rename control session: ${error instanceof Error ? error.message : String(error)}`)
    }

    const notifier = createNotifier({ session: this.controlSession, logger: this.logger })
    this.notifier = notifier

    const systemPrompt = buildSystemPrompt(this.config)
    // The terminal service is optional; the bridge degrades to actionable
    // "terminal_unavailable" results when it is absent.
    this.bridge = createTerminalBridge({ agents: ctx.agents, terminals: ctx.get('terminals') })
    this.github = createGithubClient()

    // Watches ride on durable Harness schedules when available, in-process
    // timers otherwise. Manager and bridge reference each other; the bridge's
    // tick handler is assigned right after the manager exists.
    this.scheduleBridge = createScheduleBridge({ ctx, agent: this.agent, logger: this.logger })
    this.watchManager = createWatchManager({
      store: this.store,
      reviewState: async ({ repo, prNumber }) => computePrReviewState({
        timeline: await this.github.getPrReviewTimeline({ repo, prNumber }),
        codexActorLogins: this.config.github.codexActorLogins,
      }),
      emitEvent: event => this.notifyEvent(event),
      deleteSchedule: args => this.scheduleBridge.deleteSchedule(args),
      notifications: this.config.notifications,
      logger: this.logger,
    })
    this.scheduleBridge.onTick = watchId => this.tickWatch(watchId)
    ctx.effect(() => () => this.scheduleBridge.dispose())

    const recovery = this.watchManager.recover()
    for (const watch of recovery.needsTimer) this.scheduleBridge.armInternalTimer(watch.watchId, watch.everySeconds)
    if (recovery.scheduled.length > 0 || recovery.needsTimer.length > 0) {
      this.logger?.info?.(`personal-assistant: recovered ${recovery.scheduled.length} scheduled and ${recovery.needsTimer.length} timer-backed watches`)
    }

    // Single tool-assembly seam: every supervisor tool callback is wrapped
    // with Level-2 permission enforcement before becoming a Strands tool.
    const specs = enforcePermissions([
      ...createSessionToolSpecs({ sessionIndex: this.sessionIndex, agents: ctx.agents }),
      ...createTuiToolSpecs({ sessionIndex: this.sessionIndex, bridge: this.bridge }),
      ...createGithubToolSpecs({ github: this.github, config: this.config }),
      ...createWatchToolSpecs({ watchManager: this.watchManager, scheduleBridge: this.scheduleBridge, config: this.config }),
    ], { autonomyLevel: this.config.permissions.autonomyLevel, logger: this.logger })
    const tools = specs.map(spec => tool(spec))
    this.supervisor = createSupervisorAgent(this.config, { systemPrompt, tools })

    this.actor = new SupervisorActor({
      invoke: prompt => invokeSupervisor(this.supervisor, prompt, this.config.strands.maxTurnsPerInvocation),
      present: text => notifier.postAssistantMessage(text),
      onError: (error, item) => this.logger?.warn?.(`personal-assistant: supervisor failed on ${item.type}: ${error instanceof Error ? error.message : String(error)}`),
    })
    this.drainEventQueue()
  }

  // Every model call the control session's loop would make is rejected.
  // Schedule-reminder framed messages (dsh-schedule followup deliveries) are
  // parsed into watch ticks; plain user text is logged manually (a rejected
  // message is NOT recorded by the loop) and routed into the supervisor actor.
  onPreStep(payload) {
    const text = payload.messages.map(messageText).filter(part => part !== '').join('\n\n')
    if (text !== '' && this.scheduleBridge) {
      const reminder = this.scheduleBridge.onReminderText(text)
      if (reminder) {
        const watchIds = reminder.watchIds ?? [reminder.watchId]
        for (const watchId of watchIds) this.tickWatch(watchId)
        return { kind: 'reject' }
      }
    }
    if (text !== '') {
      try {
        for (const message of payload.messages) {
          payload.agent.session.append('user/message', message, { surfaceOp: 'append' })
        }
      } catch (error) {
        this.logger?.warn?.(`personal-assistant: could not log user message: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.actor?.submitUserAnswer(text)
    }
    return { kind: 'reject' }
  }

  // Fire-and-forget watch tick; errors are logged, never thrown into the
  // agent loop or the timer callback.
  tickWatch(watchId) {
    this.watchManager.handleTick(watchId).catch(error => {
      this.logger?.warn?.(`personal-assistant: watch tick ${watchId} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Status updates feed the index; an idle transition arms a short debounce
  // (the last events of the turn may still be in flight), then the
  // deterministic classifier decides whether a notification is warranted.
  onAgentStatus(payload) {
    this.sessionIndex.noteAgentStatus(payload)
    const sessionId = String(payload.agent.id)
    clearTimeout(this.idleTimers.get(sessionId))
    this.idleTimers.delete(sessionId)
    if (payload.status !== 'idle') return
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId)
      const record = this.sessionIndex.get(sessionId)
      if (!record || record.status !== 'idle') return
      const event = eventForIdleTransition(record, this.config.notifications)
      if (event) this.notifyEvent(event)
    }, this.idleDebounceMs)
    timer.unref?.()
    this.idleTimers.set(sessionId, timer)
  }

  // Entry point for session-event producers. Events remain in the priority
  // queue until the actor is ready, and their dedupe keys become durable only
  // after the user-facing presentation succeeds.
  notifyEvent(event) {
    if (!this.eventQueue.push(event)) return
    this.drainEventQueue()
  }

  async drainEventQueue() {
    if (this.eventDispatching || !this.actor) return
    this.eventDispatching = true
    try {
      let event
      while ((event = this.eventQueue.next()) !== undefined) {
        const outcome = await this.actor.submitEvent(event)
        if (!outcome.ok) {
          this.eventQueue.release(event)
          continue
        }
        this.eventQueue.ack(event)
        this.store.state.dedupeKeys = [...this.eventQueue.seenKeys]
        this.store.save()
      }
    } finally {
      this.eventDispatching = false
      if (this.eventQueue.size > 0) this.drainEventQueue()
    }
  }
}
