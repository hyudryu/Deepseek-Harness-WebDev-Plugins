# Browser Control

Use this skill whenever you need to operate or inspect a browser-based application.

## Core rules

1. Prefer the `browser` tool for browser interaction. Do not improvise raw browser automation with shell scripts unless the browser tool is unavailable or a repository-owned Playwright test suite must be run.
2. Start by opening the target URL and taking a semantic snapshot.
3. Prefer semantic locators in this order: role + accessible name, label, placeholder, visible text, test id. Use CSS selectors only as a last resort.
4. After an interaction that materially changes UI state, take another semantic snapshot or use a deterministic assertion. Never infer success merely because a click/fill call returned successfully.
5. Use `browser` action `assert` for pass/fail decisions. A browser action completing is not itself a QA pass.
6. Clear diagnostics before an isolated test flow. Inspect diagnostics after the flow and treat unexpected page errors, console errors, failed network requests, and relevant HTTP 4xx/5xx responses as evidence to investigate.
7. Capture a screenshot on visual checks and failures. Do not generate screenshots after every routine interaction.
8. For responsive behavior, set the viewport explicitly and repeat the relevant assertion at each required size.
9. Keep one browser context alive through a coherent test flow so authentication/session state is preserved. Use `close` only when the flow is complete or you need a clean context.
10. Never use arbitrary JavaScript evaluation to force the application into a passing state. Exercise the public UI like a user unless the QA plan explicitly calls for lower-level verification.

## DeepSeek Harness optimization

The browser capability is intentionally one compact tool instead of many MCP tools. In Code Mode, visible registered tools are callable through `tools.browser(...)`. When several deterministic browser operations can be performed together without model judgment between them, batch them in Code Mode and return only the concise findings needed for the next decision. Do not hide a failed assertion or diagnostics inside the batch.

## Typical flow

- `open` the app.
- `snapshot` to understand the current accessible UI.
- `clear_diagnostics`.
- perform semantic `click`, `fill`, `press`, `select`, `check`, or `uncheck` actions.
- use `assert` for the expected state.
- call `diagnostics`.
- call `screenshot` if the check is visual or failed.

When a locator is ambiguous, take another snapshot and choose a more specific semantic locator rather than guessing a brittle selector.
