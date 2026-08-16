import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS, normalizeConfig, routeRequest, assembleVisionText, messagesHaveImage } from './core.js'

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
let warnedOff = false

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
  const settings = ctx.get('settings') ?? ctx.settings
  if (settings == null) {
    // No settings service mounted in this composition: fall back to the
    // composition config alone (cordis.patch.yml).
    settingsReady = true
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
    // Mark ready only after registration and watchers are live, so a failed
    // registration (e.g. the settings document transiently invalid) lets a
    // later agent mount retry and restore hot-reloaded config without a restart.
    settingsReady = true
  } catch (error) {
    // Do NOT mark ready: route on composition config for now and let a later
    // mount re-attempt the namespace once settings.yaml is corrected.
    currentSettings = rawConfig
    ctx.logger?.warn?.(`vision-router: settings registration failed (${error?.message ?? error}); using composition config only until settings.yaml is valid`)
  }
}

// Read the effective router state: `off` (no vision target configured -> the
// router deliberately passes every request through), `ok` (validated config),
// or an actionable throw for genuinely invalid settings (a bad field must not
// silently disable routing).
function readConfig() {
  const raw = currentSettings ?? {}
  const visionProvider = typeof raw.visionProvider === 'string' ? raw.visionProvider.trim() : ''
  const visionModel = typeof raw.visionModel === 'string' ? raw.visionModel.trim() : ''
  if (visionProvider === '' || visionModel === '') return { status: 'off' }
  return { status: 'ok', config: normalizeConfig(raw) }
}

function warnOff(ctx) {
  if (warnedOff) return
  warnedOff = true
  ctx.logger?.warn?.(
    'vision-router: no vision target configured; requests pass through unchanged. Set visionProvider/visionModel in settings.yaml (or cordis.patch.yml) to activate routing.',
  )
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
      const read = readConfig()
      if (read.status === 'off') {
        // With no vision target the router is intentionally a pass-through for
        // text, but it must NOT silently forward raw image content to the text
        // model. Fail image requests loudly with an actionable error; invalid
        // settings never reach here because readConfig/normalizeConfig throw.
        if (messagesHaveImage(resolved && resolved.messages)) {
          throw new Error(
            'vision-router: request contains an image but no vision target is configured. Set visionProvider/visionModel in settings.yaml (or cordis.patch.yml) so the vision stage can analyze it.',
          )
        }
        warnOff(ctx)
        return resolved
      }
      return routeRequest(resolved, read.config, (options) => generate(ctx, options))
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
