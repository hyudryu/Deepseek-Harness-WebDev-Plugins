# DeepSeek Harness Browser + QA Plugins

> **⚠️ Disclaimer:** These are **not** official DeepSeek plugins. They are my own personal collection of plugins that I use myself for development. Use them at your own discretion.

> **🤖 Also note:** All of these tools were coded with **DeepSeek-V4-Flash**, served on **2× DGX Sparks** using **DeepSeek Harness**.

Three installable DeepSeek Harness bundles designed for coding-agent workflows.

## 1. `dsh-browser-control`

<details>
<summary><b>Compact Playwright browser-control plugin</b> — click to expand</summary>

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

</details>

## 2. `dsh-qa-testing`

<details>
<summary><b>PR-aware QA orchestration plugin</b> — click to expand</summary>

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

</details>

## 3. `dsh-personal-assistant`

<details>
<summary><b>Global personal-assistant supervisor plugin</b> — click to expand</summary>

A global personal-assistant supervisor (one per Harness profile). It owns a dedicated control session titled "Personal Assistant" and watches every coding session through a Strands Agents SDK reasoning loop: it surfaces completions, failures, and questions from your sessions, routes your answers back to the right session, operates interactive TUI menus cross-session, and keeps persistent GitHub/Codex PR review watches. It is a control plane, not a coding worker — it never writes or edits code itself.

Capabilities include:

- session discovery with deterministic friendly names (derived from the first task, repo, or branch; explicit renames win forever);
- completion classification — idle is never equated with done; a deterministic classifier distinguishes COMPLETED / INPUT_REQUIRED / FAILED / BLOCKED from the session's own output;
- cross-session messaging: followup when idle, inject when running, steer when urgent;
- an owner-fenced TUI bridge (`tui_snapshot` / `tui_select` / `tui_keypress`, named keys only, ambiguous menus refused rather than guessed);
- a compact `github_pr_review_state` tool: Codex thumbs-up detection on the main post, timeline-aware latest activity (latest comment ≠ latest activity — a newer commit means Codex has not reviewed the latest state);
- persistent review watches riding on durable Harness schedules, with an in-process timer fallback when scheduling is unavailable;
- dedupe everywhere, so nothing is ever announced twice — including across restarts;
- Level-2 permissions enforced outside the prompt: every supervisor tool is policy-wrapped, and destructive or unlisted actions refuse with `approval_required` until an approval UI exists;
- personality presets (`friendly`/`playful`/`professional`/`serious`/`minimal`/`custom`) that change phrasing only, never behavior.

**Prerequisites:**

- the GitHub CLI (`gh`), installed and authenticated, for PR review watches;
- an OpenAI-compatible model endpoint for the supervisor loop (configured via `strands.baseUrl` / `strands.model`; the API key is read at runtime from the env var named by `strands.apiKeyEnv`, never stored in config).

The package installs its runtime dependencies (`@strands-agents/sdk` and `openai`) through your package manager, just like browser-control installs Playwright.

**Configuration** (defaults from `cordis.patch.yml`):

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | `false` registers nothing but the skill |
| `strands.modelProvider` | `openai-compatible` | only supported provider |
| `strands.model` | `deepseek-v4-flash` | supervisor model id |
| `strands.baseUrl` | `http://localhost:8000/v1` | OpenAI-compatible endpoint |
| `strands.apiKeyEnv` | `ASSISTANT_API_KEY` | name of the env var holding the key |
| `strands.maxTurnsPerInvocation` | `8` | supervisor loop bound |
| `personality.preset` | `friendly` | style only; `custom` requires `personality.customPrompt` |
| `notifications.*` | all `true` except `ciPassed: false` | per-kind toggles (completed, inputRequired, failed, blocked, reviewReceived, ciFailed, ciPassed) |
| `github.codexActorLogins` | `[codex]` | exact, case-insensitive login match |
| `github.defaultWatchIntervalSeconds` | `300` | minimum 300 |
| `permissions.autonomyLevel` | `2` | Level-2: acts autonomously, destructive actions refuse |

**State file:** friendly names, PR associations, the dedupe cache, and durable watches persist in `.dsh/personal-assistant-state.json` (override with the `DSH_PERSONAL_ASSISTANT_STATE` env var).

**Not yet implemented:** voice/TTS/STT, vision perception, a settings UI, and an approval UI (planned spec phases) are not present in this version.

</details>

## Installation

From this directory, install the bundles into the profile you use for coding (replace `tui` with your profile name):

```bash
dsh plugin --profile tui add ./browser-control
dsh plugin --profile tui add ./qa-testing
dsh plugin --profile tui add ./personal-assistant
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
