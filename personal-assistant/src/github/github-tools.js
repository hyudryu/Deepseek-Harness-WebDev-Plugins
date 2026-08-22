import { computePrReviewState } from './pr-review-state.js'

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Pure tool specs; the runtime wraps them with the policy-enforcing tool()
// seam. gh/GraphQL failures become error RESULTS, not throws — the
// supervisor should see the failure and decide, not crash its loop.
export function createGithubToolSpecs({ github, config }) {
  return [
    {
      name: 'github_pr_review_state',
      description: 'Compute the review state of a GitHub pull request: latest activity (Codex comment, other comment, review, commit/push), whether Codex thumbs-upped the main post, PR state, and a stable fingerprint for change detection.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'pr_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo, e.g. "acme/api".' },
          pr_number: { type: 'integer', description: 'Pull request number.' },
        },
      },
      callback: async (args = {}) => {
        if (typeof args.repo !== 'string' || !REPO_PATTERN.test(args.repo)) {
          throw new Error('github_pr_review_state: repo must be in owner/repo format, e.g. "acme/api"')
        }
        if (!Number.isInteger(args.pr_number) || args.pr_number <= 0) {
          throw new Error('github_pr_review_state: pr_number must be a positive integer')
        }
        try {
          const timeline = await github.getPrReviewTimeline({ repo: args.repo, prNumber: args.pr_number })
          const state = computePrReviewState({ timeline, codexActorLogins: config.github.codexActorLogins })
          return { ok: true, repo: args.repo, pr_number: args.pr_number, ...state }
        } catch (error) {
          return { ok: false, reason: 'github_error', message: error instanceof Error ? error.message : String(error) }
        }
      },
    },
  ]
}
