import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, normalizeConfig } from '../src/config.js'

test('normalizeConfig fills defaults from empty input', () => {
  const config = normalizeConfig()
  assert.equal(config.enabled, true)
  assert.deepEqual(config.strands, DEFAULTS.strands)
  assert.deepEqual(config.personality, DEFAULTS.personality)
  assert.deepEqual(config.notifications, DEFAULTS.notifications)
  assert.deepEqual(config.github, DEFAULTS.github)
  assert.deepEqual(config.permissions, DEFAULTS.permissions)
})

test('normalizeConfig rejects invalid enum values', () => {
  assert.throws(() => normalizeConfig({ personality: { preset: 'weird' } }), /personality\.preset/)
  assert.throws(() => normalizeConfig({ strands: { modelProvider: 'bedrock' } }), /strands\.modelProvider/)
})

test('normalizeConfig rejects non-positive and non-integer ints', () => {
  assert.throws(() => normalizeConfig({ strands: { maxTurnsPerInvocation: 0 } }), /maxTurnsPerInvocation/)
  assert.throws(() => normalizeConfig({ strands: { maxTurnsPerInvocation: 1.5 } }), /maxTurnsPerInvocation/)
  assert.throws(() => normalizeConfig({ strands: { maxTurnsPerInvocation: '8' } }), /maxTurnsPerInvocation/)
})

test('normalizeConfig rejects watch interval below 300 seconds', () => {
  assert.throws(() => normalizeConfig({ github: { defaultWatchIntervalSeconds: 299 } }), /defaultWatchIntervalSeconds/)
  assert.equal(normalizeConfig({ github: { defaultWatchIntervalSeconds: 300 } }).github.defaultWatchIntervalSeconds, 300)
})

test('personality preset custom requires customPrompt', () => {
  assert.throws(() => normalizeConfig({ personality: { preset: 'custom' } }), /customPrompt/)
  const config = normalizeConfig({ personality: { preset: 'custom', customPrompt: 'Be terse.' } })
  assert.equal(config.personality.customPrompt, 'Be terse.')
})

test('normalizeConfig validates booleans and login arrays', () => {
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled/)
  assert.throws(() => normalizeConfig({ notifications: { ciPassed: 1 } }), /ciPassed/)
  assert.throws(() => normalizeConfig({ github: { codexActorLogins: [''] } }), /codexActorLogins/)
  assert.throws(() => normalizeConfig({ permissions: { autonomyLevel: 1 } }), /only Level 2/)
  assert.throws(() => normalizeConfig({ permissions: { autonomyLevel: 3 } }), /only Level 2/)
})

test('normalizeConfig rejects unknown fields at every level', () => {
  assert.throws(() => normalizeConfig({ enabld: true }), /config contains unknown field: enabld/)
  assert.throws(() => normalizeConfig({ notifications: { inputRequred: false } }), /notifications contains unknown field: inputRequred/)
  assert.throws(() => normalizeConfig({ strands: { extra: true } }), /strands contains unknown field: extra/)
  assert.throws(() => normalizeConfig({ personality: { extra: true } }), /personality contains unknown field: extra/)
  assert.throws(() => normalizeConfig({ github: { extra: true } }), /github contains unknown field: extra/)
  assert.throws(() => normalizeConfig({ permissions: { extra: true } }), /permissions contains unknown field: extra/)
})

test('normalizeConfig rejects non-object sections', () => {
  assert.throws(() => normalizeConfig(null), /config must be an object/)
  assert.throws(() => normalizeConfig({ notifications: [] }), /notifications must be an object/)
})

test('normalizeConfig never stores an api key value, only the env var name', () => {
  const config = normalizeConfig({ strands: { apiKeyEnv: 'MY_KEY' } })
  assert.equal(config.strands.apiKeyEnv, 'MY_KEY')
  assert.ok(!('apiKey' in config.strands))
})
