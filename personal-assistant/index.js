import { readFileSync } from 'node:fs'
import { normalizeConfig } from './src/config.js'
import { PersonalAssistantRuntime } from './src/runtime.js'

export const name = 'personal-assistant'
export const inject = ['agents', 'sessions', 'tools', 'skills']

const SKILL_CONTENT = readFileSync(new URL('./skills/personal-assistant.md', import.meta.url), 'utf8')

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  ctx.effect(() => ctx.skills.register({
    name: 'personal-assistant',
    description: 'Global personal-assistant supervisor for DeepSeek Harness coding sessions: watches sessions, routes events, and relays concise status updates through a dedicated control session.',
    source: 'runtime',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  }))

  if (!config.enabled) return

  try {
    const runtime = new PersonalAssistantRuntime(ctx, config)
    runtime.start().catch(error => {
      ctx.logger?.error?.(`personal-assistant: startup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    ctx.logger?.error?.(`personal-assistant: initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
