# DeepSeek Harness Browser + QA Plugins

Two installable DeepSeek Harness bundles designed for coding-agent QA workflows.

## 1. `dsh-browser-control`

A compact native Playwright browser-control plugin. It intentionally exposes one `browser` tool rather than a large MCP tool catalog, plus a progressively loaded `browser-control` skill containing interaction policy.

Capabilities include:

- persistent Chromium context per Harness agent/session;
- semantic role/label/text/test-id locators;
- AI-oriented ARIA snapshots;
- click/fill/press/select/check/uncheck;
- deterministic assertions with polling;
- console/page/network/HTTP diagnostics;
- screenshots and responsive viewport changes;
- popup/tab listing and switching.

## 2. `dsh-qa-testing`

A PR-aware QA orchestration plugin. It exposes `qa_pr` plus a progressively loaded `qa-testing` skill.

The QA skill instructs DeepSeek to:

1. inspect the actual PR body, diff, changed files, and adjacent code;
2. derive a concrete QA checklist;
3. append a machine-managed `## QA Testing` block at the bottom of the PR body if it does not exist;
4. update each item live as PENDING/RUNNING/PASS/FAIL/BLOCKED;
5. on FAIL, call a foreground `subagent_fork` coding agent with the exact failure evidence;
6. retest the failed item after the coding agent fixes it;
7. repeat the repair loop up to the configured per-check limit;
8. after any fixes, rerun the *entire* checklist against the final head;
9. only mark overall PASS when every item passes in one uninterrupted final sweep.

The PR body block stores hidden JSON state between markers so updates are deterministic and preserve the rest of the PR body. Failure/pass attempt history remains visible to reviewers.

## Installation

From this directory, install both bundles into the profile you use for coding (replace `tui` with your profile name):

```bash
dsh plugin --profile tui add ./browser-control
dsh plugin --profile tui add ./qa-testing
```

Verify composition:

```bash
dsh --profile tui --dump-config
```

The browser package installs Playwright. If Chromium was not downloaded by your package manager, run from the profile/environment where Playwright is installed:

```bash
npx playwright install chromium
```

The QA plugin expects the GitHub CLI (`gh`) to be installed and authenticated for the repository. DeepSeek Harness's base bundle already supplies `subagent_fork` in the standard profile composition; the repair loop uses it in foreground mode.

## Suggested invocation

Tell the coding agent:

> QA test the fixes in this PR. Build the QA checklist from the PR diff, put it on the PR, execute it, delegate any failures to a coding agent, and keep retesting until the final full sweep passes.

Because both plugins register Harness skills, shorter prompts such as `QA test this PR` should route into the same procedure once the `qa-testing` skill is discovered.

## Why this design is DeepSeek-friendly

- The browser API is one compact tool schema instead of a large Playwright MCP catalog.
- Detailed browser and QA policy lives in Harness skills, so the full instructions are loaded only when relevant.
- Browser calls are automatically available in Harness Code Mode; deterministic multi-step operations can be batched there without retaining every intermediate result in the parent prompt.
- PR-body mutation is deterministic code rather than model-generated Markdown editing.
- The QA agent coordinates; a separate coding subagent owns source fixes.

## Important behavior

The automatic fix loop is bounded by `maxFixAttemptsPerCheck` (default 3). The goal is still to reach all PASS; the bound prevents an infinite agent loop when a failure is environmental, ambiguous, or repeatedly unfixed. After the limit, the item becomes BLOCKED and the QA run stops with evidence.
