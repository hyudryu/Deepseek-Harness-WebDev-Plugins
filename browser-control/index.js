import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { chromium } from 'playwright'

export const name = 'browser-control'
export const inject = ['tools', 'skills']

const SKILL_CONTENT = readFileSync(new URL('./skills/browser-control.md', import.meta.url), 'utf8')

const DEFAULTS = Object.freeze({
  headless: true,
  defaultTimeoutMs: 10_000,
  navigationTimeoutMs: 30_000,
  maxSnapshotChars: 24_000,
  maxDiagnostics: 100,
  artifactDir: '.dsh/qa-artifacts',
})

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function normalizeConfig(input = {}) {
  return {
    headless: input.headless ?? DEFAULTS.headless,
    defaultTimeoutMs: positiveInt(input.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, 'defaultTimeoutMs'),
    navigationTimeoutMs: positiveInt(input.navigationTimeoutMs, DEFAULTS.navigationTimeoutMs, 'navigationTimeoutMs'),
    maxSnapshotChars: positiveInt(input.maxSnapshotChars, DEFAULTS.maxSnapshotChars, 'maxSnapshotChars'),
    maxDiagnostics: positiveInt(input.maxDiagnostics, DEFAULTS.maxDiagnostics, 'maxDiagnostics'),
    artifactDir: typeof input.artifactDir === 'string' && input.artifactDir.trim() !== ''
      ? input.artifactDir
      : DEFAULTS.artifactDir,
  }
}

function sessionKey(exec) {
  return exec.agent?.id ?? 'agentless'
}

function workspaceRoot(exec) {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function limitPush(array, value, max) {
  array.push(value)
  if (array.length > max) array.splice(0, array.length - max)
}

function emptyDiagnostics() {
  return { console: [], pageErrors: [], requestFailures: [], httpErrors: [] }
}

function attachPage(state, page, maxDiagnostics) {
  if (state.attached.has(page)) return
  state.attached.add(page)

  page.on('console', message => {
    const type = message.type()
    if (!['error', 'warning'].includes(type)) return
    limitPush(state.diagnostics.console, {
      type,
      text: message.text(),
    }, maxDiagnostics)
  })

  page.on('pageerror', error => {
    limitPush(state.diagnostics.pageErrors, { message: error.message }, maxDiagnostics)
  })

  page.on('requestfailed', request => {
    limitPush(state.diagnostics.requestFailures, {
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText ?? 'request failed',
    }, maxDiagnostics)
  })

  page.on('response', response => {
    if (response.status() < 400) return
    limitPush(state.diagnostics.httpErrors, {
      status: response.status(),
      url: response.url(),
    }, maxDiagnostics)
  })
}

function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`browser action ${args.action}: ${key} is required`)
  }
  return value
}

function resolveLocator(page, args) {
  if (typeof args.selector === 'string' && args.selector.trim() !== '') {
    return page.locator(args.selector)
  }
  if (typeof args.role === 'string' && args.role.trim() !== '') {
    const options = {}
    if (typeof args.name === 'string') options.name = args.name
    if (typeof args.exact === 'boolean') options.exact = args.exact
    return page.getByRole(args.role, options)
  }
  if (typeof args.label === 'string' && args.label.trim() !== '') {
    return page.getByLabel(args.label, { exact: args.exact ?? false })
  }
  if (typeof args.placeholder === 'string' && args.placeholder.trim() !== '') {
    return page.getByPlaceholder(args.placeholder, { exact: args.exact ?? false })
  }
  if (typeof args.test_id === 'string' && args.test_id.trim() !== '') {
    return page.getByTestId(args.test_id)
  }
  if (typeof args.text === 'string' && args.text.trim() !== '') {
    return page.getByText(args.text, { exact: args.exact ?? false })
  }
  throw new Error(`browser action ${args.action}: provide a semantic locator (role/name, label, placeholder, test_id, text) or selector`)
}

function compactText(value, max) {
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `${value.slice(0, max)}\n…[truncated]`, truncated: true }
}

async function pollAssertion(fn, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw new Error('browser assertion aborted')
    try {
      const result = await fn()
      last = result.actual
      if (result.passed) return result
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
  }
  return { passed: false, actual: last === undefined ? 'timed out' : String(last) }
}

function asString(value) {
  return value === null || value === undefined ? '' : String(value)
}

function outputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'action'],
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      snapshot: { type: 'string' },
      truncated: { type: 'boolean' },
      passed: { type: 'boolean' },
      actual: { type: 'string' },
      screenshotPath: { type: 'string' },
      activePage: { type: 'integer' },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'url', 'title'],
          properties: {
            index: { type: 'integer' },
            url: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
      diagnostics: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const states = new Map()
  let browserPromise

  async function browser() {
    if (!browserPromise) browserPromise = chromium.launch({ headless: config.headless })
    return browserPromise
  }

  async function createState(exec) {
    const instance = await browser()
    const context = await instance.newContext()
    context.setDefaultTimeout(config.defaultTimeoutMs)
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs)
    const state = {
      context,
      page: undefined,
      diagnostics: emptyDiagnostics(),
      attached: new WeakSet(),
    }
    context.on('page', page => {
      attachPage(state, page, config.maxDiagnostics)
      state.page = page
    })
    state.page = await context.newPage()
    attachPage(state, state.page, config.maxDiagnostics)
    states.set(sessionKey(exec), state)
    return state
  }

  async function getState(exec) {
    const key = sessionKey(exec)
    const existing = states.get(key)
    if (existing && !existing.context.isClosed()) return existing
    return createState(exec)
  }

  async function closeState(key) {
    const state = states.get(key)
    if (!state) return
    states.delete(key)
    await state.context.close().catch(() => {})
  }

  ctx.effect(() => {
    return async () => {
      await Promise.all([...states.keys()].map(closeState))
      const instance = browserPromise ? await browserPromise.catch(() => undefined) : undefined
      if (instance) await instance.close().catch(() => {})
    }
  })

  ctx.effect(() => ctx.skills.register({
    name: 'browser-control',
    description: 'Operate and inspect browser applications with semantic Playwright locators, deterministic assertions, diagnostics, responsive viewports, and screenshots. Load for browser interaction or browser QA.',
    source: 'runtime',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'browser',
    description: 'Control a persistent Playwright Chromium context for the current agent. Prefer semantic locators. Use snapshot to inspect UI, assert for deterministic pass/fail, diagnostics for console/network failures, and screenshot for visual evidence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'reload', 'back', 'snapshot', 'click', 'fill', 'press', 'select', 'check', 'uncheck', 'assert', 'diagnostics', 'clear_diagnostics', 'screenshot', 'viewport', 'pages', 'switch_page', 'close'],
        },
        url: { type: 'string' },
        role: { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string' },
        placeholder: { type: 'string' },
        text: { type: 'string' },
        test_id: { type: 'string' },
        selector: { type: 'string' },
        exact: { type: 'boolean' },
        value: { type: 'string' },
        key: { type: 'string' },
        assertion: {
          type: 'string',
          enum: ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'text_contains', 'text_equals', 'value_equals', 'url_contains', 'url_equals', 'count_equals'],
        },
        expected: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        timeout_ms: { type: 'number' },
        full_page: { type: 'boolean' },
        path: { type: 'string' },
        include_boxes: { type: 'boolean' },
        depth: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        page_index: { type: 'integer' },
      },
    },
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('browser call aborted')
      const action = args.action
      if (action === 'close') {
        await closeState(sessionKey(exec))
        return { ok: true, action }
      }

      const state = await getState(exec)
      const page = state.page
      const timeoutMs = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
        ? Math.floor(args.timeout_ms)
        : config.defaultTimeoutMs

      switch (action) {
        case 'open': {
          const url = requireString(args, 'url')
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
          return { ok: true, action, url: page.url(), title: await page.title() }
        }
        case 'reload':
          await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
          return { ok: true, action, url: page.url(), title: await page.title() }
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
          return { ok: true, action, url: page.url(), title: await page.title() }
        case 'snapshot': {
          const depth = Number.isInteger(args.depth) && args.depth > 0 ? args.depth : 12
          const yaml = await page.locator('body').ariaSnapshot({
            mode: 'ai',
            depth,
            boxes: args.include_boxes ?? false,
            timeout: timeoutMs,
          })
          const snapshot = compactText(yaml, config.maxSnapshotChars)
          return { ok: true, action, url: page.url(), snapshot: snapshot.text, truncated: snapshot.truncated }
        }
        case 'click':
          await resolveLocator(page, args).click({ timeout: timeoutMs })
          return { ok: true, action, url: page.url() }
        case 'fill':
          await resolveLocator(page, args).fill(requireString(args, 'value'), { timeout: timeoutMs })
          return { ok: true, action, url: page.url() }
        case 'press': {
          const key = requireString(args, 'key')
          const hasLocator = ['selector', 'role', 'label', 'placeholder', 'test_id', 'text'].some(k => typeof args[k] === 'string' && args[k] !== '')
          if (hasLocator) await resolveLocator(page, args).press(key, { timeout: timeoutMs })
          else await page.keyboard.press(key)
          return { ok: true, action, url: page.url() }
        }
        case 'select':
          await resolveLocator(page, args).selectOption(requireString(args, 'value'), { timeout: timeoutMs })
          return { ok: true, action, url: page.url() }
        case 'check':
          await resolveLocator(page, args).check({ timeout: timeoutMs })
          return { ok: true, action, url: page.url() }
        case 'uncheck':
          await resolveLocator(page, args).uncheck({ timeout: timeoutMs })
          return { ok: true, action, url: page.url() }
        case 'assert': {
          const assertion = requireString(args, 'assertion')
          const result = await pollAssertion(async () => {
            if (assertion === 'url_contains') {
              const expected = asString(args.expected)
              const actual = page.url()
              return { passed: actual.includes(expected), actual }
            }
            if (assertion === 'url_equals') {
              const expected = asString(args.expected)
              const actual = page.url()
              return { passed: actual === expected, actual }
            }
            const locator = resolveLocator(page, args)
            if (assertion === 'visible') return { passed: await locator.isVisible(), actual: String(await locator.isVisible()) }
            if (assertion === 'hidden') return { passed: !(await locator.isVisible()), actual: String(await locator.isVisible()) }
            if (assertion === 'enabled') return { passed: await locator.isEnabled(), actual: String(await locator.isEnabled()) }
            if (assertion === 'disabled') return { passed: !(await locator.isEnabled()), actual: String(await locator.isEnabled()) }
            if (assertion === 'checked') return { passed: await locator.isChecked(), actual: String(await locator.isChecked()) }
            if (assertion === 'unchecked') return { passed: !(await locator.isChecked()), actual: String(await locator.isChecked()) }
            if (assertion === 'text_contains') {
              const actual = (await locator.textContent()) ?? ''
              return { passed: actual.includes(asString(args.expected)), actual }
            }
            if (assertion === 'text_equals') {
              const actual = ((await locator.textContent()) ?? '').trim()
              return { passed: actual === asString(args.expected).trim(), actual }
            }
            if (assertion === 'value_equals') {
              const actual = await locator.inputValue()
              return { passed: actual === asString(args.expected), actual }
            }
            if (assertion === 'count_equals') {
              const actualCount = await locator.count()
              const expectedCount = Number(args.expected)
              return { passed: Number.isFinite(expectedCount) && actualCount === expectedCount, actual: String(actualCount) }
            }
            throw new Error(`unsupported assertion ${assertion}`)
          }, timeoutMs, exec.signal)
          return { ok: true, action, url: page.url(), passed: result.passed, actual: asString(result.actual) }
        }
        case 'diagnostics':
          return { ok: true, action, url: page.url(), diagnostics: structuredClone(state.diagnostics) }
        case 'clear_diagnostics':
          state.diagnostics = emptyDiagnostics()
          return { ok: true, action, url: page.url() }
        case 'screenshot': {
          const root = workspaceRoot(exec)
          const artifactDir = isAbsolute(config.artifactDir) ? config.artifactDir : resolve(root, config.artifactDir)
          await mkdir(artifactDir, { recursive: true })
          const filename = typeof args.path === 'string' && args.path.trim() !== ''
            ? args.path
            : `browser-${Date.now()}.png`
          const screenshotPath = isAbsolute(filename) ? filename : resolve(artifactDir, filename)
          await mkdir(dirname(screenshotPath), { recursive: true })
          await page.screenshot({ path: screenshotPath, fullPage: args.full_page ?? true })
          return { ok: true, action, url: page.url(), screenshotPath }
        }
        case 'viewport': {
          const width = args.width
          const height = args.height
          if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
            throw new Error('browser action viewport: width and height must be positive integers')
          }
          await page.setViewportSize({ width, height })
          return { ok: true, action, url: page.url() }
        }
        case 'pages': {
          const pages = await Promise.all(state.context.pages().map(async (candidate, index) => ({
            index,
            url: candidate.url(),
            title: await candidate.title().catch(() => ''),
          })))
          const activePage = Math.max(0, state.context.pages().indexOf(state.page))
          return { ok: true, action, pages, activePage }
        }
        case 'switch_page': {
          const pages = state.context.pages()
          if (!Number.isInteger(args.page_index) || args.page_index < 0 || args.page_index >= pages.length) {
            throw new Error(`browser action switch_page: page_index must be between 0 and ${Math.max(0, pages.length - 1)}`)
          }
          state.page = pages[args.page_index]
          await state.page.bringToFront()
          return { ok: true, action, url: state.page.url(), title: await state.page.title(), activePage: args.page_index }
        }
        default:
          throw new Error(`unsupported browser action: ${action}`)
      }
    },
  }))
}
