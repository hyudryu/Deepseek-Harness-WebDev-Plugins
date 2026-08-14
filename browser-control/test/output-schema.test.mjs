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

test('browser output schema uses object-level required arrays', () => {
  const schema = registeredOutputSchema()

  assert.deepEqual(schema.required, ['ok', 'action'])
  assert.equal(schema.properties.ok.required, undefined)
  assert.equal(schema.properties.action.required, undefined)

  const pageSchema = schema.properties.pages.items
  assert.deepEqual(pageSchema.required, ['index', 'url', 'title'])
  assert.equal(pageSchema.properties.index.required, undefined)
  assert.equal(pageSchema.properties.url.required, undefined)
  assert.equal(pageSchema.properties.title.required, undefined)
})
