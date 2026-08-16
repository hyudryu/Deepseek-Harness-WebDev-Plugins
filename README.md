# DeepSeek Harness Plugins

> **⚠️ Disclaimer:** These are **not** official DeepSeek plugins. They are my own personal collection of plugins that I use myself for development. Use them at your own discretion.

> **🤖 Also note:** All of these tools were coded with **DeepSeek-V4-Flash**, served on **2× DGX Sparks** using **DeepSeek Harness**.

Three installable DeepSeek Harness bundles for coding-agent workflows.

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

## 3. `dsh-vision-router`

<details>
<summary><b>Two-stage vision router</b> — click to expand</summary>

A transparent model router that selects which model handles vision-capable requests versus text-only requests.

How it routes every model request:

1. If the request has **no image**, it is routed to the configured **text model** (or the session's selected model if none is configured).
2. If the request **contains an image**, the router first sends the image to the configured **vision model**, which returns a written analysis; that analysis is then handed to the **text model** along with the original request. The text model never sees raw image bytes, so you can pair a strong text-only model with a separate vision model.

Configuration is settings-level: add a `vision-router:` section to `$DSH_HOME/settings.yaml` (hot-reloaded, no restart):

```yaml
vision-router:
  visionProvider: pi-ai          # provider of the vision-capable model
  visionModel: pi-vision-2       # vision-capable model id
  textProvider: deepseek         # optional; unset inherits the session model
  textModel: deepseek-v4-flash   # optional; unset inherits the session model
  visionPrompt: ''               # optional; empty = built-in default (the instruction to the vision model)
  maxAnalysisChars: 20000        # cap on the vision analysis injected as text
```

The same fields can be set in `cordis.patch.yml` as composition defaults. Routing activates once a `visionProvider`/`visionModel` is configured; until then the router is off — text requests pass through unchanged, but a request that contains an image **fails loudly** because the router cannot analyze it without a configured vision target. Invalid router settings (for example a bad `maxAnalysisChars`) fail any request with an actionable error rather than silently disabling routing, and a configured image request whose vision stage fails is reported loudly instead of degrading. The vision analysis is delivered both at the user message and inside each image-bearing tool result, preserving the link between a tool call and its visual output.

To set a custom `visionPrompt`, provide the instruction the vision model receives when it analyzes images, for example:

```yaml
vision-router:
  visionProvider: pi-ai
  visionModel: pi-vision-2
  visionPrompt: Describe the image in detail, including any text, UI elements, and layout.
```

This is a router, not a tool — there is no `vision_router` tool to call. A `vision-router` skill keeps the agent aware that images are analyzed by a separate model and delivered as text.

</details>

## Installation

From this directory, install these bundles into the profile you use for coding (replace `tui` with your profile name):

```bash
dsh plugin --profile tui add ./browser-control
dsh plugin --profile tui add ./qa-testing
dsh plugin --profile tui add ./vision-router
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
