# AGENTS.md — Contributor Guide for AI Agents

This file gives autonomous coding agents (and human contributors) the context they need to work on this repository safely and consistently. Read it fully before making changes.

> **Keep the README in sync — this is a hard rule.** See [README maintenance](#readme-maintenance).

## What this repository is

A collection of personal DeepSeek Harness plugins that the owner maintains and uses for development. **These are not official DeepSeek plugins.** They are packaged as installable Harness bundles.

Every plugin here is entirely coded with **DeepSeek-V4-Flash**, served on **2× DGX Sparks** using **DeepSeek Harness**.

## Repository layout

```
DSH-Plugins/
├── AGENTS.md           ← this file
├── README.md           ← user-facing docs; MUST stay in sync with the plugins (see below)
├── .gitignore          ← node_modules/, .dsh/, OS/editor files
├── browser-control/    ← plugin 1: dsh-browser-control
├── qa-testing/         ← plugin 2: dsh-qa-testing
├── vision-router/      ← plugin 3: dsh-vision-router
└── personal-assistant/ ← plugin 4: dsh-personal-assistant
```

Each plugin directory is a self-contained Harness **bundle** (installable with `dsh plugin add ./<name>`). Larger plugins (personal-assistant) additionally keep a `src/` module tree under the same conventions — `index.js` stays the thin entry point.

## Plugin bundle structure (convention)

Every plugin in this repo follows this layout:

```
<plugin>/
├── index.js            ← ESM plugin entry point (exports `name` and `inject`)
├── package.json        ← bundle metadata + `dsh.bundle.patch` pointer
├── cordis.patch.yml    ← Harness composition patch (registers the plugin + defaults)
├── skills/
│   └── <plugin>.md     ← Harness skill: usage policy, loaded only when relevant
└── test/
    └── *.test.mjs      ← Node test runner unit tests
```

### Per-file conventions

- **`index.js`** — ESM module (`"type": "module"`). Must export:
  - `name` — the plugin id (matches the directory name).
  - `inject` — the list of Harness injection points the plugin uses (e.g. `['tools', 'skills']`).
  - Skill content is loaded at startup via `readFileSync(new URL('./skills/<plugin>.md', import.meta.url), 'utf8')`.
  - Config is normalized centrally in a `normalizeConfig(input)` helper with `DEFAULTS` and explicit per-field validation (see `positiveInt` in both existing plugins). Keep config strict and fail fast on invalid values.
  - No config fields are invented ad hoc — every accepted field must be documented and have a default.

- **`package.json`** — `"type": "module"`, a concise `description`, `license: "MIT"`, and a `files` array that lists exactly what ships (source + patch + skill). The `dsh.bundle.patch` field must point to `./cordis.patch.yml`. If the plugin adds runtime `dependencies` (like Playwright), list them here.

- **`cordis.patch.yml`** — one `insert` per plugin registering its id, package name, and default config. Config here must stay consistent with `DEFAULTS`/`normalizeConfig` in `index.js` and with the README description of the plugin.

- **`skills/<plugin>.md`** — Harness skill start with a `# <Skill Name>` heading and the trigger conditions ("Use this skill when…"). Keep the policy and workflow rules here, not in `index.js`.

- **`test/*.test.mjs`** — unit tests for the pure logic in `index.js` (config normalization, output schemas, marker/state round-trips). Run with the Node test runner (`node --test`). Keep tests dependency-free — no external framework.

## Coding standards

- **Language / runtime:** Plain modern JavaScript — ESM only. No TypeScript, no build step, no bundler. Node.js with native module support.
- **Style:** 2-space indentation, single quotes for strings, trailing commas, `const` preferred; `function` declarations for named helpers. Match the existing files' style rather than imposing a different one.
- **No transitive codegen:** Do not add a framework or template layers. Keep plugins small and self-contained.
- **Determinism:** Prefer deterministic code over model-generated editing (see how qa-testing mutates PR bodies with stable markers, or how config is normalized upfront).
- **Comments:** Prefer self-explanatory, well-named code. Add comments only where the "why" is non-obvious.
- **Errors:** Validate inputs and throw explicit, actionable errors. Fail fast rather than silently degrading.
- **Node modules:** Never commit `node_modules/` — it is gitignored. Update `pnpm-lock.yaml` only when dependency versions change, and do so intentionally.

## README maintenance (REQUIRED)

The README is the user-facing home for every plugin. Keep it accurate:

1. **Whenever you build or add a NEW plugin**, you MUST add it to the README — package/plugin intro, what it does, its capabilities, and installation steps — in the same style as the existing entries (each tool section is wrapped in a collapsible `<details>`/`<summary>` block).
2. **Whenever you make changes to an existing plugin**, check the README and update it if the plugin's info is no longer accurate. In particular:
   - changed capabilities / exposed tools / skills;
   - renamed plugin ids or package names;
   - new or removed config fields and their defaults (keep `cordis.patch.yml`, `index.js` defaults, and the README description consistent);
   - dependency changes that affect installation (e.g. new runtime deps to install);
   - new prerequisites (e.g. a required CLI like `gh`).

The README also carries a disclaimer and attribution note at the top. Do not remove or weaken the disclaimer that these are unofficial, personal plugins, or the note that all tools are coded with DeepSeek-V4-Flash on 2× DGX Sparks via DeepSeek Harness.

## Testing and verification

- Run the full test suite before declaring work complete:
  ```bash
  # from each plugin directory
  node --test
  ```
- After changing a plugin, verify it still loads the way a user would — `dsh plugin --profile <profile> add ./<plugin>` and `dsh --profile <profile> --dump-config` succeed with the expected composition.
- Update or add unit tests whenever you change config normalization, output schemas, or marker/state handling.

## Git hygiene

- Work in the repo at the top level; each plugin directory tracks its own files.
- Do **not** commit `node_modules/`, `.dsh/`, OS/editor files, or lock-file noise.
- Keep commits focused: one logical change per commit, with a clear message.

## Pull requests (REQUIRED)

Whenever you complete a non-trivial change (a change to an existing plugin, a new plugin, or doc/code updates such as `README.md`/`AGENTS.md`), open a pull request to merge it into `main`:

1. Create a dedicated branch from `main` with a descriptive name, e.g. `agent/<short-change-summary>`.
2. Commit your changes on that branch with a clear message.
3. Push the branch: `git push -u origin <branch>`.
4. Open the PR against `main` with `gh pr create` (GitHub CLI must be installed and authenticated), giving it a concise title and body that summarizes the change.
5. Confirm the PR was created by reading back the returned PR URL before reporting completion.

Keep the branch scoped to the change you were asked to make; do not fold unrelated work into the PR.
