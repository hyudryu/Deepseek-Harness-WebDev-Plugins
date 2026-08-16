import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const name = 'qa-testing'
export const inject = ['tools', 'skills']

const SKILL_CONTENT = readFileSync(new URL('./skills/qa-testing.md', import.meta.url), 'utf8')
const START = '<!-- dsh-qa:start -->'
const END = '<!-- dsh-qa:end -->'
const STATE_PREFIX = '<!-- dsh-qa-state:'
const STATE_SUFFIX = ' -->'

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function normalizeConfig(input = {}) {
  return {
    maxFixAttemptsPerCheck: positiveInt(input.maxFixAttemptsPerCheck, 3, 'maxFixAttemptsPerCheck'),
    maxPrBodyChars: positiveInt(input.maxPrBodyChars, 24_000, 'maxPrBodyChars'),
  }
}

function cwdFor(exec) {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function runGh(args, { cwd, input, signal, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('gh command aborted'))
    const child = spawn('gh', args, {
      cwd,
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
      if (stdout.length + stderr.length > maxBytes) {
        child.kill()
      }
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.on('error', error => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      reject(new Error(`failed to start gh: ${error.message}`))
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
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function targetArgs(pr) {
  return typeof pr === 'string' && pr.trim() !== '' ? [pr.trim()] : []
}

async function getPr(pr, exec) {
  const stdout = await runGh([
    'pr', 'view', ...targetArgs(pr),
    '--json', 'number,url,title,body,headRefName,baseRefName,headRefOid',
  ], { cwd: cwdFor(exec), signal: exec.signal })
  const parsed = JSON.parse(stdout)
  if (!Number.isInteger(parsed.number)) throw new Error('gh returned an invalid pull request number')
  return parsed
}

function newState(headSha, checks, maxFixAttemptsPerCheck) {
  return {
    version: 1,
    headSha,
    overall: 'IN_PROGRESS',
    maxFixAttemptsPerCheck,
    checks: checks.map((check, index) => ({
      id: check.id || `QA-${String(index + 1).padStart(3, '0')}`,
      text: check.text,
      status: 'PENDING',
      attempts: 0,
      note: '',
      history: [],
      testedHead: '',
    })),
  }
}

function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('set_checklist requires at least one check')
  const seen = new Set()
  for (const check of checks) {
    if (!check || typeof check !== 'object') throw new Error('each checklist item must be an object')
    if (typeof check.text !== 'string' || check.text.trim() === '') throw new Error('each checklist item needs non-empty text')
    if (typeof check.id !== 'string' || !/^QA-\d{3,}$/.test(check.id)) throw new Error(`invalid checklist id ${JSON.stringify(check.id)}; expected QA-001 style`)
    if (seen.has(check.id)) throw new Error(`duplicate checklist id ${check.id}`)
    seen.add(check.id)
  }
}

function parseState(body) {
  const start = body.indexOf(START)
  const end = body.indexOf(END)
  if (start < 0 || end < start) return undefined
  const block = body.slice(start, end + END.length)
  const stateStart = block.indexOf(STATE_PREFIX)
  if (stateStart < 0) return undefined
  const jsonStart = stateStart + STATE_PREFIX.length
  const jsonEnd = block.indexOf(STATE_SUFFIX, jsonStart)
  if (jsonEnd < 0) return undefined
  try {
    const state = JSON.parse(block.slice(jsonStart, jsonEnd))
    if (state?.version !== 1 || !Array.isArray(state.checks)) return undefined
    return state
  } catch {
    return undefined
  }
}

function escapeInline(text) {
  return String(text).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('`', "'").trim()
}

// Loose detection of a QA/testing section in a PR body. Matches any markdown
// heading whose text indicates QA/testing intent, so both the plugin's own
// machine-managed "## QA Testing" block and hand-written sections like
// "QA section", "QA test", or "Test steps" satisfy the condition.
const QA_HEADING_RE = /\b(qa|quality\s+assurance|test|testing|tests|test\s+plan|test\s+steps|verification|checklist)\b/i

function qaSectionInfo(body) {
  if (typeof body !== 'string') return { hasQaSection: false, heading: null }
  const headings = body.match(/^[ \t]*#{1,6}[ \t]+[^\n]*$/gm)
  if (!headings) return { hasQaSection: false, heading: null }
  for (const line of headings) {
    const heading = line.replace(/^[ \t]*#{1,6}[ \t]+/, '').trim()
    if (QA_HEADING_RE.test(heading)) {
      return { hasQaSection: true, heading }
    }
  }
  return { hasQaSection: false, heading: null }
}

function statusLabel(status) {
  if (status === 'PASS') return '✅ PASS'
  if (status === 'FAIL') return '❌ FAIL'
  if (status === 'BLOCKED') return '⚠️ BLOCKED'
  if (status === 'RUNNING') return 'RUNNING'
  return 'PENDING'
}

function renderBlock(state) {
  const lines = [
    START,
    '## QA Testing',
    '',
    `**PR head:** \`${escapeInline(state.headSha || 'unknown')}\`  `,
    `**Overall:** ${escapeInline(state.overall)}`,
    '',
  ]

  for (const check of state.checks) {
    const checkbox = check.status === 'PASS' ? '[x]' : '[ ]'
    const note = check.note ? ` — ${escapeInline(check.note)}` : ''
    lines.push(`- ${checkbox} \`${escapeInline(check.id)}\` ${escapeInline(check.text)} — ${statusLabel(check.status)}${note}`)
    for (const history of check.history ?? []) {
      lines.push(`  - Attempt ${history.attempt}: ${statusLabel(history.status)}${history.note ? ` — ${escapeInline(history.note)}` : ''}`)
    }
  }

  const encoded = JSON.stringify(state).replaceAll('-->', '--\\u003e')
  lines.push('', `${STATE_PREFIX}${encoded}${STATE_SUFFIX}`, END)
  return lines.join('\n')
}

function upsertBlock(body, block) {
  const start = body.indexOf(START)
  const end = body.indexOf(END)
  let base = body
  if (start >= 0 && end >= start) {
    base = `${body.slice(0, start)}${body.slice(end + END.length)}`
  }
  base = base.trimEnd()
  return base.length === 0 ? block : `${base}\n\n${block}`
}

async function writeState(pr, state, exec, expectedHeadSha) {
  const current = await getPr(pr, exec)
  if (expectedHeadSha !== undefined && current.headRefOid !== expectedHeadSha) {
    throw new Error(`PR head changed during QA update: expected ${expectedHeadSha}, current ${current.headRefOid}; re-inspect and retest against the new head`)
  }
  state.headSha = current.headRefOid
  const nextBody = upsertBlock(current.body ?? '', renderBlock(state))
  await runGh(['pr', 'edit', ...targetArgs(pr), '--body-file', '-'], {
    cwd: cwdFor(exec),
    input: nextBody,
    signal: exec.signal,
  })
  return current
}

function publicState(state) {
  if (!state) return { overall: 'NOT_STARTED', checks: [] }
  return {
    overall: state.overall,
    headSha: state.headSha,
    maxFixAttemptsPerCheck: state.maxFixAttemptsPerCheck,
    checks: state.checks.map(check => ({
      id: check.id,
      text: check.text,
      status: check.status,
      attempts: check.attempts,
      note: check.note,
      history: check.history,
      testedHead: check.testedHead ?? '',
    })),
  }
}

function qaOutput(operation, pr, state, body, maxPrBodyChars) {
  const qaSection = qaSectionInfo(pr.body ?? '')
  const result = {
    ok: true,
    operation,
    prNumber: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    overall: state?.overall ?? 'NOT_STARTED',
    checks: publicState(state).checks,
    hasQaSection: qaSection.hasQaSection,
    qaSectionHeading: qaSection.heading,
  }
  if (body !== undefined) {
    result.body = body.length <= maxPrBodyChars
      ? body
      : `${body.slice(0, maxPrBodyChars)}\n…[PR body truncated]`
  }
  return result
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'operation', 'prNumber', 'url', 'title', 'headSha', 'headRefName', 'baseRefName', 'overall', 'checks'],
  properties: {
    ok: { type: 'boolean' },
    operation: { type: 'string' },
    prNumber: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    headSha: { type: 'string' },
    headRefName: { type: 'string' },
    baseRefName: { type: 'string' },
    overall: { type: 'string' },
    body: { type: 'string' },
    hasQaSection: { type: 'boolean' },
    qaSectionHeading: { type: ['string', 'null'] },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
  },
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  ctx.effect(() => ctx.skills.register({
    name: 'qa-testing',
    description: 'Plan and execute PR-aware QA, append/update a live checklist in the PR body, delegate failed checks to a coding subagent, retest fixes, and run a final full sweep before passing.',
    source: 'runtime',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'qa_pr',
    description: 'Own the machine-managed QA checklist block at the bottom of the current GitHub PR body. Inspect PR state (reporting whether the PR body already contains a QA/testing section via hasQaSection), create/reset checklist items, update one item status with audit history, or set overall QA status. Refetches the PR before every mutation and preserves all non-QA PR body content.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['inspect', 'set_checklist', 'set_status', 'set_overall'] },
        pr: { type: 'string', description: 'Optional PR number or URL. Omit to resolve the PR for the current branch.' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'text'],
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        check_id: { type: 'string' },
        status: { type: 'string', enum: ['PENDING', 'RUNNING', 'PASS', 'FAIL', 'BLOCKED'] },
        note: { type: 'string' },
        tested_head: { type: 'string', description: 'For PASS, the exact PR head SHA that was tested.' },
        overall: { type: 'string', enum: ['IN_PROGRESS', 'PASS', 'FAIL', 'BLOCKED'] },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const pr = await getPr(args.pr, exec)
      const existing = parseState(pr.body ?? '')

      if (args.action === 'inspect') {
        return qaOutput('inspect', pr, existing, pr.body ?? '', config.maxPrBodyChars)
      }

      if (args.action === 'set_checklist') {
        validateChecks(args.checks)
        const state = newState(pr.headRefOid, args.checks, config.maxFixAttemptsPerCheck)
        const latest = await writeState(args.pr, state, exec)
        return qaOutput('set_checklist', latest, state, undefined, config.maxPrBodyChars)
      }

      if (!existing) throw new Error('QA checklist does not exist; call qa_pr set_checklist first')

      if (args.action === 'set_status') {
        if (typeof args.check_id !== 'string' || args.check_id.trim() === '') throw new Error('set_status requires check_id')
        if (!['PENDING', 'RUNNING', 'PASS', 'FAIL', 'BLOCKED'].includes(args.status)) throw new Error('set_status requires a valid status')
        const check = existing.checks.find(item => item.id === args.check_id)
        if (!check) throw new Error(`unknown QA checklist item ${args.check_id}`)
        const note = typeof args.note === 'string' ? args.note.trim() : ''
        if (['FAIL', 'BLOCKED'].includes(args.status) && note === '') {
          throw new Error(`${args.status} requires a concrete evidence note`)
        }
        if (args.status === 'FAIL' && check.attempts >= existing.maxFixAttemptsPerCheck) {
          throw new Error(`${check.id} already reached maxFixAttemptsPerCheck=${existing.maxFixAttemptsPerCheck}; mark it BLOCKED instead`)
        }
        check.status = args.status
        check.note = note
        if (args.status !== 'PASS') check.testedHead = ''
        if (args.status === 'FAIL') {
          check.attempts += 1
          check.history.push({ attempt: check.attempts, status: 'FAIL', note })
          existing.overall = 'IN_PROGRESS'
        } else if (args.status === 'PASS') {
          if (typeof args.tested_head !== 'string' || args.tested_head.trim() === '') {
            throw new Error('PASS requires tested_head: the exact PR head SHA that was tested')
          }
          if (args.tested_head !== pr.headRefOid) {
            throw new Error(`cannot mark ${check.id} PASS: tested_head ${args.tested_head} is not current PR head ${pr.headRefOid}`)
          }
          check.testedHead = args.tested_head
          const attempt = Math.max(1, check.attempts + 1)
          check.history.push({ attempt, status: 'PASS', note })
        } else if (args.status === 'BLOCKED') {
          check.history.push({ attempt: Math.max(1, check.attempts), status: 'BLOCKED', note })
          existing.overall = 'BLOCKED'
        } else if (args.status === 'RUNNING') {
          existing.overall = 'IN_PROGRESS'
        }
        const latest = await writeState(args.pr, existing, exec, args.status === 'PASS' ? pr.headRefOid : undefined)
        return qaOutput('set_status', latest, existing, undefined, config.maxPrBodyChars)
      }

      if (args.action === 'set_overall') {
        if (!['IN_PROGRESS', 'PASS', 'FAIL', 'BLOCKED'].includes(args.overall)) throw new Error('set_overall requires a valid overall value')
        if (args.overall === 'PASS') {
          if (existing.checks.some(check => check.status !== 'PASS')) {
            throw new Error('cannot set overall PASS while any checklist item is not PASS')
          }
          const stale = existing.checks.filter(check => check.testedHead !== pr.headRefOid)
          if (stale.length > 0) {
            throw new Error(`cannot set overall PASS: these checks were not tested against current PR head ${pr.headRefOid}: ${stale.map(check => check.id).join(', ')}`)
          }
        }
        existing.overall = args.overall
        const latest = await writeState(args.pr, existing, exec, args.overall === 'PASS' ? pr.headRefOid : undefined)
        return qaOutput('set_overall', latest, existing, undefined, config.maxPrBodyChars)
      }

      throw new Error(`unsupported qa_pr action ${args.action}`)
    },
  }))
}

export const __test = { parseState, renderBlock, upsertBlock, newState, qaSectionInfo }
