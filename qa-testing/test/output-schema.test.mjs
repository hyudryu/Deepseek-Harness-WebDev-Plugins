import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function registeredOutputSchema() {
  let registration
  const ctx = {
    effect(callback) {
      callback()
    },
    skills: {
      register() {},
    },
    tools: {
      register(value) {
        registration = value
      },
    },
  }

  apply(ctx)
  return registration.output.schema
}

test('QA output schema uses an object-level required array', () => {
  const schema = registeredOutputSchema()

  assert.deepEqual(schema.required, [
    'ok',
    'operation',
    'prNumber',
    'url',
    'title',
    'headSha',
    'headRefName',
    'baseRefName',
    'overall',
    'checks',
  ])

  for (const property of schema.required) {
    assert.equal(schema.properties[property].required, undefined)
  }
})
