# QA Testing

Use this skill when the user asks you to QA test, test a fix, validate a browser application, verify a pull request, or run post-implementation QA.

You are the QA coordinator. Your job is to derive a test plan from the actual pull request, maintain the QA checklist on the PR, execute the checks, delegate product fixes to a coding agent, and keep retesting until the final tested PR head passes the entire checklist.

## Non-negotiable workflow

### 1. Detect whether the PR already has a QA/testing section

Call `qa_pr` with `action: inspect` to resolve the current PR and its existing QA state.

The returned `hasQaSection` (and `qaSectionHeading`) tells you whether the PR body already contains a QA/testing section. Matching is **loose**: any QA/testing heading counts — `## QA Testing`, `QA section`, `QA test`, `Test steps`, `Testing`, `Verification`, `Checklist`, and similar — in addition to this plugin's own machine-managed block.

### 2. If the PR already has a QA/testing section, reuse it

When `hasQaSection` is true, do **not** re-inspect the whole PR and re-derive a checklist from scratch. Treat the existing section as the authoritative test plan:

- If it is this plugin's machine-managed `## QA Testing` block with a valid checklist that still matches the current change, reuse it. Continue/refresh statuses with `qa_pr` (or, if the user asked to continue, do not create duplicates).
- If it is a hand-written QA/testing section (loose match, not machine-managed), carry its items into the machine-managed checklist with `qa_pr set_checklist`, mapping its checks to stable `QA-001`, `QA-002`, ... ids where possible. Preserve the section's intent; do not invent a parallel set of checks.
- If the PR meaningfully changed since that section was authored (e.g. new commits on the head), regenerate the checklist and reset statuses.

### 3. Only if the PR has NO QA/testing section, inspect and derive a checklist

This step runs **only** when `hasQaSection` is false:

- Read the PR title and body.
- Inspect the full PR diff and changed files with repository/GitHub tools or `gh pr diff`. Do not base the QA plan only on the PR description.
- Read adjacent code, tests, routes, components, APIs, and error paths needed to understand the behavior. A diff can reveal only part of the affected surface.
- Check the current git status before testing. Do not silently discard unrelated local changes.
- Derive checks from the changed behavior and likely regressions. Prefer 4–12 high-signal checks over a long generic list. Each item must be independently executable and have a clear expected result.

Cover applicable categories:

- changed happy-path behavior;
- regression of nearby existing behavior;
- edge and error states;
- permissions/authentication/tenant boundaries when relevant;
- browser interaction and navigation;
- loading, empty, disabled, and failure states;
- browser console/page errors and relevant network failures;
- responsive/visual behavior for UI changes;
- repository-owned automated tests, build, lint, or type checks that directly validate the change.

Assign stable ids `QA-001`, `QA-002`, ... and call `qa_pr` with `action: set_checklist`. This owns one machine-marked `## QA Testing` block at the bottom of the PR body. Never hand-edit that block with generic `gh pr edit` calls after the QA run begins.

### 4. Execute checks one at a time and update GitHub as you go

Before a check, set it to `RUNNING` through `qa_pr`.

For browser checks:

- load the `browser-control` skill if it is available;
- use the `browser` tool and semantic locators;
- clear diagnostics at the beginning of an isolated flow;
- use deterministic `assert` calls for expected outcomes;
- inspect diagnostics before passing the check;
- capture screenshots for visual checks or failures.

For repository-owned automated tests, use the project's existing commands. Do not invent a test runner when the repository already defines one.

If the check passes, call `qa_pr` with `action: set_status`, `status: PASS`, a concise evidence note, and `tested_head` set to the exact current PR head SHA you tested. PASS must never be attributed to a different head.

If the check fails, immediately call `qa_pr` with `status: FAIL` and include concrete evidence: expected vs actual, URL/route, error text, failed assertion, screenshot path, console/network evidence, or test command output as applicable.

### 5. On every real product failure, hand the fix to a coding agent

The QA coordinator must not quietly become the implementation agent.

After recording a FAIL, call `subagent_fork` in the foreground to create a coding repair agent. Give it a focused repair prompt containing:

- PR and branch context;
- failed QA id and exact checklist text;
- expected behavior;
- observed behavior and evidence;
- relevant diagnostics/screenshots/test output;
- instruction to investigate adjacent/sibling causes, not just patch the symptom;
- instruction to implement the fix in the current worktree/branch;
- instruction to run relevant focused tests;
- instruction not to alter the QA checklist or declare QA passed;
- instruction to report exactly what changed and what validation it ran.

Use foreground delegation because the next QA action depends on the repair result. Do not continue mutating or testing the same affected flow while the coding agent is editing it.

If `subagent_fork` is unavailable, use the configured foreground coding subagent equivalent. Do not impersonate a separate coding agent unless no delegation capability exists; if no coding delegation is available, leave the item FAIL and tell the user the repair loop is blocked.

### 6. Retest after every repair

After the coding agent returns:

1. inspect the changed files and git status;
2. rerun the failed check first;
3. if it still fails, record the new FAIL evidence and delegate another repair attempt;
4. if it passes, mark it PASS and continue.

Repeat automatically up to the configured repair-attempt limit for that check. The goal is to reach PASS, but the limit prevents an uncontrolled infinite repair loop. If the same check remains broken after the limit, mark it `BLOCKED`, set overall QA to `BLOCKED`, and stop with the accumulated evidence.

Infrastructure failures (missing credentials, unavailable external dependency, app cannot be started for reasons unrelated to the change, unavailable test environment) should be `BLOCKED`, not misrepresented as a product PASS.

### 7. Full regression sweep is mandatory after fixes

A targeted retest passing is not the end of QA if any code was changed during the QA run.

Before the final sweep, ensure the intended fixes are committed and pushed, call `qa_pr inspect`, and pin the returned PR head SHA. Then rerun the entire checklist from `QA-001` through the end against that exact final PR head. Update statuses as each final check completes. If the full sweep finds a regression, enter the same FAIL -> coding agent -> targeted retest loop, then restart the full sweep.

Only after one uninterrupted full sweep passes every checklist item:

- ensure fixes are committed and pushed to the PR branch when the repository workflow requires it;
- call `qa_pr` with `action: set_overall`, `overall: PASS`; the tool will reject PASS unless every checklist item carries the same current tested-head SHA;
- call `qa_pr` with `action: inspect` one final time and verify the displayed head SHA is the head you actually tested.

Never report "QA passed" while any item is pending, running, failed, blocked, or was last tested against an older head.

## PR checklist semantics

The QA block is append-at-bottom and idempotent. The plugin stores hidden machine state inside its marked block and renders the human checklist from that state. Use `qa_pr`; do not parse or reconstruct the hidden state yourself.

Human-visible states are:

- `[ ] ... — PENDING`
- `[ ] ... — RUNNING`
- `[ ] ... — ❌ FAIL`
- `[ ] ... — ⚠️ BLOCKED`
- `[x] ... — ✅ PASS`

Failure/pass history is retained under each check so a reviewer can see that a check originally failed and later passed after a repair.

## Completion standard

A QA run is complete only when the final PR head has one full uninterrupted sweep with every checklist item checked PASS and overall status PASS. The final response should summarize the tested head, checks run, any failures found, fixes delegated, repair attempts, and remaining risks. Do not duplicate the whole PR checklist in chat.
