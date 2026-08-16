import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS, normalizeConfig, routeRequest, assembleVisionText } from './core.js'

export const name = 'vision-router'
export const inject = ['llm', 'settings', 'skills']

const SKILL_CONTENT = readFileSync(new URL('./skills/vision-router.md', import.meta.url), 'utf8')

const SETTINGS_NS = 'vision-router'

// The settings namespace is a deployment-wide resource, but this bundle mounts
// per agent (so it can attach an `agent/request` listener on its own scoped
// context). Registration therefore runs once per process; every later agent
// reads the shared resolved value, so an edit to settings.yaml applies to all
// of them.
let settingsReady = false
let currentSettings = null

// A permissive schema: the router enforces "vision target required" itself at
// request time (normalizeConfig), so an unconfigured namespace stays valid and
// simply routes as a pass-through until the owner provides models.
const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
  visionPrompt: z.string().default(DEFAULTS.visionPrompt),
  textProvider: z.string().default(''),
  textModel: z.string().default(''),
  maxAnalysisChars: z.number().int().positive().default(DEFAULTS.maxAnalysisChars),
})

function installSettings(ctx, rawConfig) {
  if (settingsReady) {
    // Already registered by an earlier agent mount; nothing more to do.
    return
  }
  settingsReady = true
  const settings = ctx.get('settings') ?? ctx.settings
  if (settings == null) {
    // No settings service mounted in this composition: fall back to the
    // composition config alone (cordis.patch.yml) and still route.
    currentSettings = rawConfig
    return
  }
  try {
    const scope = settings.register(SETTINGS_NS, settingsSchema, { base: rawConfig })
    const update = () => {
      const resolved = scope.get()
      if (resolved != null) currentSettings = { ...rawConfig, ...resolved }
    }
    update()
    if (typeof scope.watch === 'function') scope.watch(() => update())
    if (typeof scope.subscribe === 'function') scope.subscribe(() => update())
  } catch (error) {
    // Duplicate registration or a validation edge: degrade to composition-only
    // routing rather than taking the process down.
    currentSettings = rawConfig
    ctx.logger?.warn?.(`vision-router: settings namespace unavailable (${error?.message ?? error}); using composition config only`)
  }
}

function currentConfig() {
  try {
    return normalizeConfig(currentSettings ?? {})
  } catch {
    // The owner has not yet configured a vision target; pass requests through.
    return null
  }
}

async function generate(ctx, options) {
  const stream = ctx.llm.stream(options)
  return assembleVisionText(stream)
}

export function apply(ctx, rawConfig = {}) {
  installSettings(ctx, rawConfig)

  ctx.effect(() => {
    const dispose = ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const config = currentConfig()
      if (config == null) return resolved
      return routeRequest(resolved, config, (options) => generate(ctx, options))
    })
    return dispose
  })

  ctx.effect(() =>
    ctx.skills.register({
      name: 'vision-router',
      description:
        'Routes each model request: requests without images go to the text model; requests with images first run a configured vision model to produce a written analysis, then hand the analysis plus the original request to the text model. Load for awareness of image handling when working with screenshots or imagery.',
      source: 'runtime',
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    }),
  )
}
