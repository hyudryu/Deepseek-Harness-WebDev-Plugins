import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

test('QA block is appended once and moved to bottom on update', () => {
  const state = __test.newState('abc123', [{ id: 'QA-001', text: 'Loads dashboard' }], 3)
  const block = __test.renderBlock(state)
  const once = __test.upsertBlock('## Summary\nhello', block)
  const twice = __test.upsertBlock(`${once}\n\nextra`, block)
  assert.equal((twice.match(/<!-- dsh-qa:start -->/g) ?? []).length, 1)
  assert.ok(twice.endsWith('<!-- dsh-qa:end -->'))
  assert.ok(twice.includes('extra'))
})

test('machine state round trips through rendered block', () => {
  const state = __test.newState('abc123', [{ id: 'QA-001', text: 'Loads dashboard' }], 3)
  const block = __test.renderBlock(state)
  const parsed = __test.parseState(block)
  assert.equal(parsed.headSha, 'abc123')
  assert.equal(parsed.checks[0].id, 'QA-001')
  assert.equal(parsed.checks[0].status, 'PENDING')
})

test('qaSectionInfo loosely detects existing QA/testing sections', () => {
  const cases = [
    ['## Summary\nplain body', false],
    ['## QA Testing', true],
    ['## QA section', true],
    ['## QA test', true],
    ['## Test steps', true],
    ['## Testing', true],
    ['### Verification', true],
    ['## Checklist', true],
    ['## My PR title\nSome text', false],
    ['## Notes\nno test here', false],
  ]
  for (const [body, expected] of cases) {
    assert.equal(__test.qaSectionInfo(body).hasQaSection, expected, JSON.stringify(body))
  }
  // The plugin's own rendered block counts as an existing QA/testing section.
  const state = __test.newState('abc123', [{ id: 'QA-001', text: 'x' }], 3)
  assert.equal(__test.qaSectionInfo(__test.renderBlock(state)).hasQaSection, true)
})

test('qaSectionInfo ignores QA-looking lines inside fenced and indented code blocks', () => {
  const fenced = '## Summary\n```\n## Testing\nfunc()\n```\nreal text'
  const indented = '## Summary\n    ## Testing\n    let x = 1\nreal text'
  assert.equal(__test.qaSectionInfo(fenced).hasQaSection, false)
  assert.equal(__test.qaSectionInfo(indented).hasQaSection, false)
  // A real heading after the code blocks is still detected.
  const fencedThenReal = '## Summary\n```\n## Testing\n```\n## QA test\nitem'
  assert.equal(__test.qaSectionInfo(fencedThenReal).hasQaSection, true)
  assert.equal(__test.qaSectionInfo(fencedThenReal).heading, 'QA test')
})

test('qaSectionInfo extracts the section content and stops at the next heading', () => {
  const body = '## Summary\nthe change\n\n## Test steps\n- open page\n- click signup\n\n## Notes\nother'
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.equal(info.heading, 'Test steps')
  assert.ok(info.content.includes('- open page'))
  assert.ok(info.content.includes('- click signup'))
  assert.ok(!info.content.includes('other'))
  // Content is still returned even when the full body would be truncated.
  const longBody = `## Summary\n${'x'.repeat(30_000)}\n## Testing\nreal check here`
  const longInfo = __test.qaSectionInfo(longBody)
  assert.equal(longInfo.hasQaSection, true)
  assert.ok(longInfo.content.includes('real check here'))
})
