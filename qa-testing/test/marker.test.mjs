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

test('qaSectionInfo detects setext headings and ignores code blocks and html comments', () => {
  const section = [
    '# Title',
    '',
    '```',
    '## Testing',
    '- [ ] ignored',
    '```',
    '',
    '<!--',
    '## Testing',
    '- [ ] ignored',
    '-->',
    '',
    'Implementation notes',
    '===',
    '- [ ] ignored',
  ].join('\n')
  const body = section + '\n\nTesting\n---\n- [ ] real check\n'
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.equal(info.heading, 'Testing')
  assert.match(info.content, /- \[ \] real check/)
})

test('qaSectionInfo prefers testing headings over generic checklist sections', () => {
  const body = [
    '## Checklist',
    '- [ ] repo check',
    '',
    '## Testing',
    '- [ ] real test',
    '- [ ] follow-up',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.equal(info.heading, 'Testing')
  assert.equal(info.content.includes('repo check'), false)
  assert.equal(info.content.includes('real test'), true)
})

test('qaSectionInfo treats headings without actionable checkboxes as absent', () => {
  const body = [
    '## Testing',
    'Not tested',
    '',
    'N/A',
    '',
    '## Notes',
    'No checklist here',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, false)
  assert.equal(info.heading, null)
  assert.match(info.content, /Not tested/)
  assert.equal(info.content.includes('No checklist here'), false)
})

test('qaSectionInfo keeps a 4+ backtick fence open over inner triple-backtick lines', () => {
  const body = [
    '````',
    '```',
    '## Testing',
    '- [ ] ignored',
    '```',
    '````',
    '',
    '## Testing',
    '- [ ] real',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.equal(info.heading, 'Testing')
  assert.match(info.content, /real/)
  assert.doesNotMatch(info.content, /ignored/)
})

test('qaSectionInfo keeps a 4+ tilde fence open over inner triple-tilde lines', () => {
  const body = [
    '~~~~',
    '~~~',
    '## Testing',
    '- [ ] ignored',
    '~~~',
    '~~~~',
    '',
    '## Verification',
    '- [ ] real',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.equal(info.heading, 'Verification')
  assert.match(info.content, /real/)
  assert.doesNotMatch(info.content, /ignored/)
})

test('qaSectionInfo ignores comment markers inside fenced code', () => {
  const body = [
    '```',
    '<!--',
    'still code, not a comment',
    '```',
    '',
    '## Testing',
    '- [ ] real',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.match(info.content, /real/)
})

test('qaSectionInfo ignores headings in indented code blocks', () => {
  const body = [
    'example:',
    '',
    '    ## Testing',
    '    - [ ] ignored',
    '',
    '## Testing',
    '- [ ] real',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.match(info.content, /real/)
  assert.doesNotMatch(info.content, /ignored/)
})

test('qaSectionInfo ends the section at the next non-QA heading of equal rank', () => {
  const body = [
    '## Testing',
    '- [ ] real',
    '',
    '## Notes',
    '- [ ] unrelated',
  ].join('\n')
  const info = __test.qaSectionInfo(body)
  assert.equal(info.hasQaSection, true)
  assert.match(info.content, /real/)
  assert.doesNotMatch(info.content, /unrelated/)
})

test('qaOutput reflects the written body after set_checklist', () => {
  const state = __test.newState('sha', [{ id: 'QA-001', text: 'Loads dashboard' }], 3)
  const body = __test.upsertBlock('## Summary\nhello', __test.renderBlock(state))
  const pr = { number: 1, url: 'u', title: 't', headRefOid: 'sha', headRefName: 'h', baseRefName: 'main', body }
  const result = __test.qaOutput('set_checklist', pr, state, undefined, 24_000)
  assert.equal(result.hasQaSection, true)
  assert.equal(result.qaSectionHeading, 'QA Testing')
  assert.equal('body' in result, false)
})

test('qaOutput returns QA content that sits beyond the truncation limit', () => {
  const filler = 'x'.repeat(200)
  const body = `${filler}\n\n## Testing\n- [ ] late check\n`
  const pr = { number: 1, url: 'u', title: 't', headRefOid: 'sha', headRefName: 'h', baseRefName: 'main', body }
  const result = __test.qaOutput('inspect', pr, undefined, body, 100)
  assert.equal(result.hasQaSection, true)
  assert.ok(result.body.length < body.length)
  assert.equal(result.body.includes('late check'), false)
  assert.match(result.qaSectionContent, /late check/)
})

test('qaOutput surfaces section text even when it has no actionable checks', () => {
  const pr = { number: 1, url: 'u', title: 't', headRefOid: 'sha', headRefName: 'h', baseRefName: 'main', body: '## Testing\nNot tested\n' }
  const result = __test.qaOutput('inspect', pr, undefined, pr.body, 24_000)
  assert.equal(result.hasQaSection, false)
  assert.equal(result.qaSectionHeading, null)
  assert.match(result.qaSectionContent, /Not tested/)
})
