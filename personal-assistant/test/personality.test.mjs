import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig, PERSONALITY_PRESETS } from '../src/config.js'
import { buildSystemPrompt } from '../src/supervisor/prompt.js'
import { checkToolCall } from '../src/supervisor/permissions.js'

function promptFor(preset, customPrompt) {
  return buildSystemPrompt(normalizeConfig({ personality: { preset, customPrompt } }))
}

// The prompt is a rules block plus exactly one trailing style directive line.
function rulesBlock(prompt) {
  const lines = prompt.split('\n')
  return lines.slice(0, -1).join('\n')
}

test('personality preset changes only the style directive, never the rules', () => {
  const presets = PERSONALITY_PRESETS.filter(preset => preset !== 'custom')
  const blocks = presets.map(preset => rulesBlock(promptFor(preset)))
  for (const block of blocks) assert.equal(block, blocks[0], 'core rules block must be byte-identical across presets')

  const directives = new Set(presets.map(preset => promptFor(preset).split('\n').at(-1)))
  assert.equal(directives.size, presets.length, 'each preset has its own style directive')
  assert.notEqual(promptFor('friendly'), promptFor('playful'))
})

test('custom preset appends the custom prompt verbatim as the style directive', () => {
  const prompt = promptFor('custom', 'Style: answer like a lighthouse keeper.')
  assert.equal(prompt.split('\n').at(-1), 'Style: answer like a lighthouse keeper.')
  assert.equal(rulesBlock(prompt), rulesBlock(promptFor('friendly')))
})

test('every rules line is present regardless of preset', () => {
  const prompt = promptFor('minimal')
  for (const expected of ['global supervisor', 'NOT a coding worker', 'Level-2 autonomy', 'idle', 'session_send']) {
    assert.ok(prompt.includes(expected), `missing rule fragment: ${expected}`)
  }
})

test('permissions are independent of personality', () => {
  for (const preset of PERSONALITY_PRESETS.filter(p => p !== 'custom')) {
    promptFor(preset) // building a prompt must not touch policy
    assert.deepEqual(checkToolCall('session_send', {}), { allowed: true }, preset)
    assert.equal(checkToolCall('github_merge_pr', {}).allowed, false, preset)
  }
})
