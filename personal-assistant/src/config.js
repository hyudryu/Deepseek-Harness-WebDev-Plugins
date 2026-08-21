export const PERSONALITY_PRESETS = Object.freeze(['friendly', 'playful', 'professional', 'serious', 'minimal', 'custom'])
export const MODEL_PROVIDERS = Object.freeze(['openai-compatible'])
export const MIN_WATCH_INTERVAL_SECONDS = 300

export const DEFAULTS = Object.freeze({
  enabled: true,
  strands: Object.freeze({
    modelProvider: 'openai-compatible',
    model: 'deepseek-v4-flash',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: 'ASSISTANT_API_KEY',
    maxTurnsPerInvocation: 8,
  }),
  personality: Object.freeze({
    preset: 'friendly',
    customPrompt: undefined,
  }),
  notifications: Object.freeze({
    completed: true,
    inputRequired: true,
    failed: true,
    blocked: true,
    reviewReceived: true,
    ciFailed: true,
    ciPassed: false,
  }),
  github: Object.freeze({
    codexActorLogins: Object.freeze(['codex']),
    defaultWatchIntervalSeconds: 300,
  }),
  permissions: Object.freeze({
    autonomyLevel: 2,
  }),
})

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function booleanValue(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function nonEmptyString(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function enumValue(value, fallback, allowed, name) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`)
  return value
}

function normalizeStrands(input = {}) {
  return {
    modelProvider: enumValue(input.modelProvider, DEFAULTS.strands.modelProvider, MODEL_PROVIDERS, 'strands.modelProvider'),
    model: nonEmptyString(input.model, DEFAULTS.strands.model, 'strands.model'),
    baseUrl: nonEmptyString(input.baseUrl, DEFAULTS.strands.baseUrl, 'strands.baseUrl'),
    // Only the env var NAME is configured; the key value is read from
    // process.env at agent construction and never stored.
    apiKeyEnv: nonEmptyString(input.apiKeyEnv, DEFAULTS.strands.apiKeyEnv, 'strands.apiKeyEnv'),
    maxTurnsPerInvocation: positiveInt(input.maxTurnsPerInvocation, DEFAULTS.strands.maxTurnsPerInvocation, 'strands.maxTurnsPerInvocation'),
  }
}

function normalizePersonality(input = {}) {
  const preset = enumValue(input.preset, DEFAULTS.personality.preset, PERSONALITY_PRESETS, 'personality.preset')
  if (input.customPrompt !== undefined && (typeof input.customPrompt !== 'string' || input.customPrompt.trim() === '')) {
    throw new Error('personality.customPrompt must be a non-empty string')
  }
  if (preset === 'custom' && input.customPrompt === undefined) {
    throw new Error('personality.preset "custom" requires personality.customPrompt')
  }
  return { preset, customPrompt: input.customPrompt }
}

function normalizeNotifications(input = {}) {
  const result = {}
  for (const key of Object.keys(DEFAULTS.notifications)) {
    result[key] = booleanValue(input[key], DEFAULTS.notifications[key], `notifications.${key}`)
  }
  return result
}

function normalizeGithub(input = {}) {
  let logins = DEFAULTS.github.codexActorLogins
  if (input.codexActorLogins !== undefined) {
    if (!Array.isArray(input.codexActorLogins) || input.codexActorLogins.some(login => typeof login !== 'string' || login.trim() === '')) {
      throw new Error('github.codexActorLogins must be an array of non-empty strings')
    }
    logins = [...input.codexActorLogins]
  }
  const interval = positiveInt(input.defaultWatchIntervalSeconds, DEFAULTS.github.defaultWatchIntervalSeconds, 'github.defaultWatchIntervalSeconds')
  if (interval < MIN_WATCH_INTERVAL_SECONDS) {
    throw new Error(`github.defaultWatchIntervalSeconds must be at least ${MIN_WATCH_INTERVAL_SECONDS}`)
  }
  return { codexActorLogins: logins, defaultWatchIntervalSeconds: interval }
}

function normalizePermissions(input = {}) {
  const level = input.autonomyLevel === undefined ? DEFAULTS.permissions.autonomyLevel : input.autonomyLevel
  if (!Number.isInteger(level) || level < 1 || level > 3) throw new Error('permissions.autonomyLevel must be an integer between 1 and 3')
  return { autonomyLevel: level }
}

export function normalizeConfig(input = {}) {
  return {
    enabled: booleanValue(input.enabled, DEFAULTS.enabled, 'enabled'),
    strands: normalizeStrands(input.strands),
    personality: normalizePersonality(input.personality),
    notifications: normalizeNotifications(input.notifications),
    github: normalizeGithub(input.github),
    permissions: normalizePermissions(input.permissions),
  }
}
