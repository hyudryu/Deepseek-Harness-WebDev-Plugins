import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoke } from '../src/supervisor/agent.js'

test('invoke applies the configured per-invocation turn limit', async () => {
  const calls = []
  const agent = {
    invoke: async (...args) => {
      calls.push(args)
      return { toString: () => 'done' }
    },
  }
  assert.equal(await invoke(agent, 'prompt', 3), 'done')
  assert.deepEqual(calls, [['prompt', { limits: { turns: 3 } }]])
})
