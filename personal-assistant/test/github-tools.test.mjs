import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubToolSpecs } from '../src/github/github-tools.js'

const CONFIG = { github: { codexActorLogins: ['codex'] } }

const TIMELINE = {
  state: 'OPEN',
  merged: false,
  closed: false,
  reactions: { nodes: [] },
  timelineItems: {
    nodes: [
      { __typename: 'IssueComment', id: 'C1', createdAt: '2026-08-20T10:00:00Z', author: { login: 'codex' }, body: 'Two findings.' },
    ],
  },
}

function setup(client = { getPrReviewTimeline: async () => TIMELINE }) {
  const specs = createGithubToolSpecs({ github: client, config: CONFIG })
  return specs[0]
}

test('happy path returns the compact computed shape', async () => {
  const spec = setup()
  const result = await spec.callback({ repo: 'acme/api', pr_number: 42 })
  assert.equal(result.ok, true)
  assert.equal(result.repo, 'acme/api')
  assert.equal(result.pr_number, 42)
  assert.equal(result.latestActivity.kind, 'codex_comment')
  assert.equal(result.prState, 'open')
  assert.equal(result.fingerprint, 'codex-comment:C1')
  assert.equal(result.reviewComplete, false)
})

test('passes repo and prNumber through to the client', async () => {
  const calls = []
  const spec = setup({
    getPrReviewTimeline: async args => {
      calls.push(args)
      return TIMELINE
    },
  })
  await spec.callback({ repo: 'acme/api', pr_number: 7 })
  assert.deepEqual(calls, [{ repo: 'acme/api', prNumber: 7 }])
})

test('repo and pr_number validation', async () => {
  const spec = setup()
  await assert.rejects(() => spec.callback({ repo: 'noslash', pr_number: 1 }), /owner\/repo/)
  await assert.rejects(() => spec.callback({ repo: 'a/b/c', pr_number: 1 }), /owner\/repo/)
  await assert.rejects(() => spec.callback({ repo: 'acme/api' }), /pr_number/)
  await assert.rejects(() => spec.callback({ repo: 'acme/api', pr_number: 0 }), /positive integer/)
  await assert.rejects(() => spec.callback({ repo: 'acme/api', pr_number: 1.5 }), /positive integer/)
})

test('client failures become error results, not throws', async () => {
  const spec = setup({
    getPrReviewTimeline: async () => {
      throw new Error('gh api graphql failed (1): Not Found')
    },
  })
  const result = await spec.callback({ repo: 'acme/api', pr_number: 42 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'github_error')
  assert.ok(result.message.includes('Not Found'))
})
