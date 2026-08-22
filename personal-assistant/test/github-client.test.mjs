import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createGithubClient } from '../src/github/github-client.js'

// Minimal ChildProcess stand-in: stdout/stderr emitters plus kill/close.
function fakeGh(respond) {
  const calls = []
  const spawnImpl = (command, args) => {
    assert.equal(command, 'gh')
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { end() {} }
    child.kill = () => respond.kill(child)
    respond.start(child, args)
    return child
  }
  return { calls, spawnImpl }
}

function respondWith(payloadFor) {
  return {
    start(child, args) {
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(payloadFor(args))))
        child.emit('close', 0)
      })
    },
    kill(child) {
      process.nextTick(() => child.emit('close', null))
    },
  }
}

function page(reactions, hasNextPage, endCursor) {
  return {
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          merged: false,
          closed: false,
          reactions: { nodes: reactions, pageInfo: { hasNextPage, endCursor } },
          timelineItems: { nodes: [] },
        },
      },
    },
  }
}

test('main-post reactions are paginated until hasNextPage is false', async () => {
  const pages = [
    page([{ id: 'RE1', createdAt: '2026-08-20T10:00:00Z', user: { login: 'alice' } }], true, 'cursor-1'),
    page([{ id: 'RE2', createdAt: '2026-08-20T11:00:00Z', user: { login: 'codex' } }], false, null),
  ]
  const { calls, spawnImpl } = fakeGh(respondWith(args => {
    const cursorArg = args.find(arg => arg.startsWith('reactionCursor='))
    return cursorArg === undefined ? pages[0] : pages[1]
  }))
  const client = createGithubClient({ spawnImpl })
  const pr = await client.getPrReviewTimeline({ repo: 'acme/api', prNumber: 42 })
  assert.equal(calls.length, 2)
  assert.ok(calls[1].some(arg => arg === 'reactionCursor=cursor-1'))
  assert.deepEqual(pr.reactions.nodes.map(reaction => reaction.id), ['RE1', 'RE2'])
})

test('a hung gh child is aborted by the poll timeout', async () => {
  let killed = false
  const { spawnImpl } = fakeGh({
    start() {}, // never closes: simulates a hung gh process
    kill(child) {
      killed = true
      process.nextTick(() => child.emit('close', null))
    },
  })
  const client = createGithubClient({ spawnImpl, pollTimeoutMs: 20 })
  await assert.rejects(() => client.getPrReviewTimeline({ repo: 'acme/api', prNumber: 42 }), /aborted/)
  assert.equal(killed, true)
})

test('createGithubClient validates the poll timeout', () => {
  assert.throws(() => createGithubClient({ pollTimeoutMs: 0 }), /pollTimeoutMs/)
  assert.throws(() => createGithubClient({ pollTimeoutMs: Number.NaN }), /pollTimeoutMs/)
})
