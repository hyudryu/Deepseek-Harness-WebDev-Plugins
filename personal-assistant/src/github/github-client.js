import { spawn } from 'node:child_process'

// GraphQL document for one PR review-state poll. Kept as a single template
// constant; variables go through -F/-f per gh conventions.
const PR_REVIEW_TIMELINE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      closed
      reactions(first: 100, content: THUMBS_UP) {
        nodes { id createdAt user { login } }
      }
      timelineItems(last: 30, itemTypes: [
        ISSUE_COMMENT,
        PULL_REQUEST_REVIEW,
        PULL_REQUEST_COMMIT,
        MERGED_EVENT,
        CLOSED_EVENT,
        HEAD_REF_FORCE_PUSHED_EVENT
      ]) {
        nodes {
          __typename
          ... on IssueComment { id createdAt author { login } body }
          ... on PullRequestReview { id createdAt author { login } body state }
          ... on PullRequestCommit { id commit { oid committedDate } }
          ... on MergedEvent { id createdAt actor { login } }
          ... on ClosedEvent { id createdAt actor { login } }
          ... on HeadRefForcePushedEvent { id createdAt actor { login } }
        }
      }
    }
  }
}
`

// Abortable, output-capped gh invocation with actionable errors (same shape
// as qa-testing's runGh; spawn is injectable for tests).
function runGh(args, { signal, maxBytes = 2_000_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('gh command aborted'))
    const child = spawnImpl('gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })

    const append = (which, chunk) => {
      const text = chunk.toString('utf8')
      if (which === 'stdout') stdout += text
      else stderr += text
      if (stdout.length + stderr.length > maxBytes) child.kill()
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.on('error', error => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      reject(new Error(`failed to start gh: ${error.message} — is the GitHub CLI installed and on PATH?`))
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('gh command aborted'))
      if (stdout.length + stderr.length > maxBytes) return reject(new Error(`gh output exceeded ${maxBytes} bytes`))
      if (code !== 0) return reject(new Error(`gh ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`))
      resolve(stdout)
    })
    child.stdin.end()
  })
}

export function createGithubClient({ spawnImpl } = {}) {
  async function getPrReviewTimeline({ repo, prNumber, signal } = {}) {
    const [owner, name] = repo.split('/')
    const stdout = await runGh([
      'api', 'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${prNumber}`,
      '-f', `query=${PR_REVIEW_TIMELINE_QUERY}`,
    ], { signal, spawnImpl })
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error('gh api graphql returned invalid JSON')
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${parsed.errors.map(error => error.message ?? String(error)).join('; ')}`)
    }
    const pullRequest = parsed.data?.repository?.pullRequest
    if (!pullRequest) throw new Error(`pull request ${repo}#${prNumber} not found (check repo and number, and gh auth status)`)
    return pullRequest
  }

  return { getPrReviewTimeline }
}
