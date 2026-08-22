// Pure PR review-state computation over the GraphQL timeline JSON returned by
// github-client. No gh/process access here — fully testable with fixtures.
//
// Precedence (spec §12.1):
//   1. A Codex THUMBS_UP on the main post ends the review watch immediately:
//      codexThumbsUpOnMainPost + reviewComplete, fingerprint thumbsup:<id>.
//   2. Otherwise the chronologically latest timeline item decides
//      latestActivity. Dated items sort by createdAt; PullRequestCommit
//      exposes no createdAt in the GitHub schema, so commits take their
//      position from the chronological connection order (never from
//      commit.committedDate — a cherry-picked old commit's push is still
//      the newest PR activity). Codex comment/review → codex_comment (a
//      Codex PULL_REQUEST_REVIEW counts as codex_comment — the watch exists
//      to catch Codex output); commit or force-push → commit/push (latest
//      state NOT yet reviewed); anyone else's comment → other_comment;
//      non-Codex review → review.
//   3. reviewComplete is also true for a merged PR (watch auto-stop), but
//      codexThumbsUpOnMainPost stays reaction-driven only.
// MERGED_EVENT/CLOSED_EVENT nodes never become latestActivity — the PR state
// field already carries that fact.

export function isCodexLogin(login, codexActorLogins) {
  if (typeof login !== 'string') return false
  return codexActorLogins.some(codex => codex.toLowerCase() === login.toLowerCase())
}

function bound(text, max) {
  if (typeof text !== 'string') return undefined
  return text.length <= max ? text : text.slice(0, max)
}

// Normalize the heterogeneous timeline node union into one comparable shape.
function normalizeNode(node) {
  switch (node.__typename) {
    case 'IssueComment':
      return { kind: 'comment', id: node.id, createdAt: node.createdAt, actor: node.author?.login, body: node.body }
    case 'PullRequestReview':
      return { kind: 'review', id: node.id, createdAt: node.createdAt, actor: node.author?.login, body: node.body }
    case 'PullRequestCommit':
      // No createdAt exists on this type; ordering is filled in below from
      // the connection order. committedDate is deliberately NOT a fallback.
      return { kind: 'commit', id: node.id, createdAt: undefined, oid: node.commit?.oid }
    case 'HeadRefForcePushedEvent':
      return { kind: 'push', id: node.id, createdAt: node.createdAt, actor: node.actor?.login }
    case 'MergedEvent':
    case 'ClosedEvent':
      return { kind: 'lifecycle', id: node.id, createdAt: node.createdAt, actor: node.actor?.login }
    default:
      return undefined
  }
}

export function computePrReviewState({ timeline, codexActorLogins, maxCommentChars = 2000 }) {
  const prState = timeline.merged === true || timeline.state === 'MERGED'
    ? 'merged'
    : timeline.closed === true || timeline.state === 'CLOSED' ? 'closed' : 'open'

  const thumbsUp = (timeline.reactions?.nodes ?? []).find(
    reaction => isCodexLogin(reaction.user?.login, codexActorLogins),
  )

  const items = (timeline.timelineItems?.nodes ?? [])
    .map(normalizeNode)
    .filter(item => item !== undefined && item.kind !== 'lifecycle')
    .map((item, index) => ({ ...item, index }))

  // Undated items (commits) inherit the nearest dated neighbor's timestamp —
  // forward pass, so a filled neighbor propagates — and array position (the
  // connection's chronological order) breaks the tie.
  for (let index = 0; index < items.length; index += 1) {
    if (typeof items[index].createdAt === 'string') continue
    const after = items.slice(index + 1).find(item => typeof item.createdAt === 'string')
    const before = index > 0 ? items[index - 1].createdAt : undefined
    items[index].createdAt = after?.createdAt ?? (typeof before === 'string' ? before : '')
  }

  items.sort((a, b) => {
    const order = a.createdAt.localeCompare(b.createdAt)
    if (order !== 0) return order
    return a.index - b.index
  })

  const latest = items[items.length - 1]
  let latestActivity = { kind: 'none', actor: undefined, createdAt: undefined, text: undefined }
  let fingerprint = ''

  if (latest !== undefined) {
    const codex = isCodexLogin(latest.actor, codexActorLogins)
    if (latest.kind === 'comment' && codex) {
      latestActivity = { kind: 'codex_comment', actor: latest.actor, createdAt: latest.createdAt, text: bound(latest.body, maxCommentChars) }
      fingerprint = `codex-comment:${latest.id}`
    } else if (latest.kind === 'review' && codex) {
      latestActivity = { kind: 'codex_comment', actor: latest.actor, createdAt: latest.createdAt, text: bound(latest.body, maxCommentChars) }
      fingerprint = `codex-comment:${latest.id}`
    } else if (latest.kind === 'comment') {
      latestActivity = { kind: 'other_comment', actor: latest.actor, createdAt: latest.createdAt, text: bound(latest.body, maxCommentChars) }
      fingerprint = `comment:${latest.id}`
    } else if (latest.kind === 'review') {
      latestActivity = { kind: 'review', actor: latest.actor, createdAt: latest.createdAt, text: bound(latest.body, maxCommentChars) }
      fingerprint = `review:${latest.id}`
    } else if (latest.kind === 'commit') {
      latestActivity = { kind: 'commit', actor: latest.actor, createdAt: latest.createdAt }
      fingerprint = `commit:${latest.oid ?? latest.id}`
    } else if (latest.kind === 'push') {
      latestActivity = { kind: 'push', actor: latest.actor, createdAt: latest.createdAt }
      fingerprint = `push:${latest.id}`
    }
  }

  if (thumbsUp !== undefined) fingerprint = `thumbsup:${thumbsUp.id}`

  return {
    latestActivity,
    codexThumbsUpOnMainPost: thumbsUp !== undefined,
    reviewComplete: thumbsUp !== undefined || prState === 'merged',
    prState,
    fingerprint,
  }
}
