import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computePrReviewState, isCodexLogin } from '../src/github/pr-review-state.js'

const CODEX = ['codex']

function comment(id, login, createdAt, body = 'text') {
  return { __typename: 'IssueComment', id, createdAt, author: { login }, body }
}

function review(id, login, createdAt, body = 'review body') {
  return { __typename: 'PullRequestReview', id, createdAt, author: { login }, body, state: 'COMMENTED' }
}

function commit(id, oid, committedDate) {
  return { __typename: 'PullRequestCommit', id, commit: { oid, committedDate } }
}

function forcePush(id, login, createdAt) {
  return { __typename: 'HeadRefForcePushedEvent', id, createdAt, actor: { login } }
}

function merged(id, login, createdAt) {
  return { __typename: 'MergedEvent', id, createdAt, actor: { login } }
}

function timeline({ state = 'OPEN', mergedFlag = false, closedFlag = false, reactions = [], items = [] }) {
  return {
    state,
    merged: mergedFlag,
    closed: closedFlag,
    reactions: { nodes: reactions },
    timelineItems: { nodes: items },
  }
}

test('isCodexLogin is exact and case-insensitive, never substring', () => {
  assert.equal(isCodexLogin('codex', CODEX), true)
  assert.equal(isCodexLogin('Codex', CODEX), true)
  assert.equal(isCodexLogin('codex-bot', CODEX), false)
  assert.equal(isCodexLogin('notcodex', CODEX), false)
  assert.equal(isCodexLogin(undefined, CODEX), false)
})

test('§24.5 latest activity is a commit: no review notification', () => {
  const state = computePrReviewState({
    timeline: timeline({
      items: [
        comment('C1', 'codex', '2026-08-20T10:00:00Z', 'Please fix the typo.'),
        commit('K1', 'abc123', '2026-08-20T11:00:00Z'),
      ],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'commit')
  assert.equal(state.reviewComplete, false)
  assert.equal(state.fingerprint, 'commit:abc123')
})

test('§24.5 force-push as latest activity: kind push, not reviewed', () => {
  const state = computePrReviewState({
    timeline: timeline({
      items: [
        review('R1', 'codex', '2026-08-20T10:00:00Z'),
        forcePush('FP1', 'alice', '2026-08-20T12:00:00Z'),
      ],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'push')
  assert.equal(state.reviewComplete, false)
  assert.equal(state.fingerprint, 'push:FP1')
})

test('§24.6 latest comment by another user is other_comment, not Codex', () => {
  const state = computePrReviewState({
    timeline: timeline({ items: [comment('C9', 'alice', '2026-08-20T10:00:00Z', 'LGTM?')] }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'other_comment')
  assert.equal(state.latestActivity.actor, 'alice')
  assert.equal(state.reviewComplete, false)
  assert.equal(state.fingerprint, 'comment:C9')
})

test('§24.7 new Codex comment: codex_comment with bounded text and stable fingerprint', () => {
  const longBody = `Review findings. ${'x'.repeat(5000)}`
  const state = computePrReviewState({
    timeline: timeline({ items: [comment('C42', 'codex', '2026-08-20T10:00:00Z', longBody)] }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'codex_comment')
  assert.equal(state.latestActivity.text.length, 2000)
  assert.equal(state.fingerprint, 'codex-comment:C42')
  assert.equal(state.reviewComplete, false)
})

test('§24.8 Codex thumbs-up on the main post completes the review', () => {
  const state = computePrReviewState({
    timeline: timeline({
      reactions: [{ id: 'RE1', createdAt: '2026-08-20T13:00:00Z', user: { login: 'Codex' } }],
      items: [commit('K1', 'abc123', '2026-08-20T11:00:00Z')],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.codexThumbsUpOnMainPost, true)
  assert.equal(state.reviewComplete, true)
  assert.equal(state.fingerprint, 'thumbsup:RE1')
  // latestActivity still reflects the timeline independently
  assert.equal(state.latestActivity.kind, 'commit')
})

test('merged PR: prState merged, reviewComplete, thumbs-up stays false', () => {
  const state = computePrReviewState({
    timeline: timeline({
      state: 'MERGED',
      mergedFlag: true,
      items: [merged('M1', 'alice', '2026-08-20T14:00:00Z'), comment('C1', 'codex', '2026-08-20T10:00:00Z')],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.prState, 'merged')
  assert.equal(state.reviewComplete, true)
  assert.equal(state.codexThumbsUpOnMainPost, false)
  // lifecycle events never become latestActivity
  assert.equal(state.latestActivity.kind, 'codex_comment')
})

test('unsorted timeline input is ordered by createdAt, not array order', () => {
  const state = computePrReviewState({
    timeline: timeline({
      items: [
        comment('C2', 'alice', '2026-08-20T12:00:00Z', 'newer'),
        comment('C1', 'codex', '2026-08-20T10:00:00Z', 'older'),
      ],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'other_comment')
  assert.equal(state.fingerprint, 'comment:C2')
})

test('a cherry-picked old commit is ordered by its push time, not committedDate', () => {
  const state = computePrReviewState({
    timeline: timeline({
      items: [
        // Old commit metadata, but the push is the newest PR activity.
        { __typename: 'PullRequestCommit', id: 'K9', createdAt: '2026-08-20T13:00:00Z', commit: { oid: 'old123', committedDate: '2026-08-01T09:00:00Z' } },
        comment('C1', 'codex', '2026-08-20T12:00:00Z', 'reviewed'),
      ],
    }),
    codexActorLogins: CODEX,
  })
  assert.equal(state.latestActivity.kind, 'commit')
  assert.equal(state.fingerprint, 'commit:old123')
})

test('non-Codex review is kind review; Codex review counts as codex_comment', () => {
  const human = computePrReviewState({
    timeline: timeline({ items: [review('R7', 'bob', '2026-08-20T10:00:00Z', 'Looks good')] }),
    codexActorLogins: CODEX,
  })
  assert.equal(human.latestActivity.kind, 'review')
  assert.equal(human.fingerprint, 'review:R7')

  const codex = computePrReviewState({
    timeline: timeline({ items: [review('R8', 'codex', '2026-08-20T10:00:00Z', 'Automated review')] }),
    codexActorLogins: CODEX,
  })
  assert.equal(codex.latestActivity.kind, 'codex_comment')
  assert.equal(codex.fingerprint, 'codex-comment:R8')
})

test('empty timeline: kind none, empty fingerprint, open PR incomplete', () => {
  const state = computePrReviewState({ timeline: timeline({}), codexActorLogins: CODEX })
  assert.equal(state.latestActivity.kind, 'none')
  assert.equal(state.fingerprint, '')
  assert.equal(state.prState, 'open')
  assert.equal(state.reviewComplete, false)
})
