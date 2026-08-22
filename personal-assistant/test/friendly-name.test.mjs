import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveFriendlyName } from '../src/sessions/friendly-name.js'

test('strips leading verbs and keeps the core phrase', () => {
  assert.equal(deriveFriendlyName({ task: 'Implement toolbar enhancement' }), 'Toolbar enhancement')
  assert.equal(deriveFriendlyName({ task: 'Fix auth redirect bug after login' }), 'Auth redirect bug')
  assert.equal(deriveFriendlyName({ task: 'Migrate user preferences table' }), 'User preferences migration')
})

test('strips politeness scaffolding and articles', () => {
  assert.equal(deriveFriendlyName({ task: 'Please can you fix the login form' }), 'Login form')
  assert.equal(deriveFriendlyName({ task: 'Can you add dark mode toggle?' }), 'Dark mode toggle')
  assert.equal(deriveFriendlyName({ task: 'I need you to update the checkout flow.' }), 'Checkout flow')
})

test('long phrases drop to a shorter core (2–6 words)', () => {
  const name = deriveFriendlyName({ task: 'Implement the new comprehensive authentication flow with oauth providers' })
  assert.equal(name, 'New comprehensive authentication flow with oauth')
  assert.ok(name.split(' ').length <= 6)
})

test('unusable task text falls back to repo, then branch', () => {
  assert.equal(deriveFriendlyName({ task: 'Fix it', repo: 'my-repo' }), 'My-repo')
  assert.equal(deriveFriendlyName({ task: 'ok', branch: 'feature/login' }), 'Login')
  assert.equal(deriveFriendlyName({ task: 'Fix it', repo: 'acme/api-service' }), 'Api-service')
})

test('nothing usable returns undefined (caller falls back to Session <shortid>)', () => {
  assert.equal(deriveFriendlyName({}), undefined)
  assert.equal(deriveFriendlyName({ task: '' }), undefined)
  assert.equal(deriveFriendlyName({ task: 'Fix it' }), undefined)
})

test('deterministic: same input, same name', () => {
  const input = { task: 'Refactor the session index module', repo: 'plugins' }
  assert.equal(deriveFriendlyName(input), deriveFriendlyName(input))
  assert.equal(deriveFriendlyName(input), 'Session index module')
})
