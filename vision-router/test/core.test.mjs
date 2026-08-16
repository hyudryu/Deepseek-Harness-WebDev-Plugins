import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  normalizeConfig,
  contentHasImage,
  messagesHaveImage,
  collectImages,
  latestUserText,
  visionMessagesFor,
  withVisionAnalysis,
  assembleVisionText,
  textRoute,
  routeRequest,
} from '../core.js'

const VISION = { visionProvider: 'pi-ai', visionModel: 'pi-vision' }

test('normalizeConfig fills defaults and freezes', () => {
  const config = normalizeConfig({ visionProvider: 'p', visionModel: 'm' })
  assert.equal(config.enabled, true)
  assert.equal(config.textProvider, '')
  assert.equal(config.textModel, '')
  assert.equal(config.maxAnalysisChars, DEFAULTS.maxAnalysisChars)
  assert.equal(config.visionPrompt, DEFAULTS.visionPrompt)
  assert.ok(Object.isFrozen(config))
})

test('normalizeConfig requires a vision target', () => {
  assert.throws(() => normalizeConfig({}), /visionProvider is required/)
  assert.throws(() => normalizeConfig({ visionProvider: 'p' }), /visionModel is required/)
})

test('normalizeConfig validates types', () => {
  assert.throws(() => normalizeConfig({ visionProvider: 'p', visionModel: 'm', enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => normalizeConfig({ visionProvider: 'p', visionModel: 'm', maxAnalysisChars: 0 }), /positive integer/)
  assert.throws(() => normalizeConfig({ visionProvider: 5, visionModel: 'm' }), /visionProvider must be a string/)
})

test('contentHasImage recurses into tool results', () => {
  assert.equal(contentHasImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(contentHasImage([{ type: 'image', data: 'x' }]), true)
  assert.equal(
    contentHasImage([{ type: 'tool-result', content: [{ type: 'image' }] }]),
    true,
  )
  assert.equal(contentHasImage([{ type: 'tool-result', content: [{ type: 'text', text: 't' }] }]), false)
  assert.equal(contentHasImage(undefined), false)
})

test('messagesHaveImage scans every message', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }]
  assert.equal(messagesHaveImage(messages), false)
  const withImage = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'tool', content: [{ type: 'image' }] },
  ]
  assert.equal(messagesHaveImage(withImage), true)
  assert.equal(messagesHaveImage(undefined), false)
})

test('collectImages gathers nested images in order', () => {
  const content = [
    { type: 'image', src: 'a' },
    { type: 'tool-result', content: [{ type: 'image', src: 'b' }, { type: 'text', text: 't' }] },
  ]
  assert.deepEqual(collectImages(content).map((b) => b.src), ['a', 'b'])
})

test('latestUserText returns the newest non-empty user text', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: [{ type: 'text', text: '  ' }] },
    { role: 'user', content: [] },
  ]
  assert.equal(latestUserText(messages), 'first')
  assert.equal(latestUserText([]), '')
})

test('visionMessagesFor keeps system context and sends prompt + images', () => {
  const system = { role: 'system', content: [{ type: 'text', text: 'sys' }] }
  const messages = [
    system,
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', src: 'i' }] },
  ]
  const vision = visionMessagesFor(messages, 'ANALYZE')
  assert.equal(vision[0], system)
  assert.equal(vision[1].role, 'user')
  const blocks = vision[1].content
  assert.match(blocks[0].text, /ANALYZE/)
  assert.match(blocks[0].text, /what is this\?/)
  assert.deepEqual(blocks[1], { type: 'image', src: 'i' })
})

test('withVisionAnalysis strips images and prepends analysis to newest user message', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
  ]
  const out = withVisionAnalysis(messages, 'the picture shows X', 1000)
  // No image blocks anywhere.
  assert.equal(JSON.stringify(out).includes('"type":"image"'), false)
  const lastUser = out[out.length - 1]
  assert.equal(lastUser.content[0].type, 'text')
  assert.match(lastUser.content[0].text, /\[Vision analysis\]/m)
  assert.match(lastUser.content[0].text, /the picture shows X/)
  assert.equal(lastUser.content[1].text, 'follow up')
})

test('withVisionAnalysis truncates long analyses', () => {
  const out = withVisionAnalysis([{ role: 'user', content: [{ type: 'image' }] }], 'x'.repeat(5000), 100)
  assert.match(out[0].content[0].text, /truncated/)
})

test('assembleVisionText joins deltas and fails loudly on error/abort', async () => {
  const ok = (async function* () {
    yield { type: 'text-delta', text: 'hel' }
    yield { type: 'text-delta', text: 'lo' }
    yield { type: 'finish', reason: { kind: 'success' } }
  })()
  assert.equal(await assembleVisionText(ok), 'hello')

  const err = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'nope' } } }
  })()
  await assert.rejects(() => assembleVisionText(err), /NO_ADAPTER.*nope/)

  const abort = (async function* () {
    yield { type: 'finish', reason: { kind: 'aborted' } }
  })()
  await assert.rejects(() => assembleVisionText(abort), /aborted/)
})

test('textRoute inherits unset sides from the request', () => {
  const config = normalizeConfig({ visionProvider: 'p', visionModel: 'm', textModel: 't' })
  const routed = textRoute({ provider: 'orig-p', model: 'orig-m', messages: [] }, config)
  assert.equal(routed.provider, 'orig-p') // textProvider unset -> inherit
  assert.equal(routed.model, 't') // textModel set -> override
})

test('routeRequest passes through when disabled', async () => {
  const config = normalizeConfig({ visionProvider: 'p', visionModel: 'm', enabled: false })
  const resolved = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'image' }] }] }
  const out = await routeRequest(resolved, config, () => {
    throw new Error('should not run')
  })
  assert.equal(out, resolved)
})

test('routeRequest no-image routes to the text target without calling vision', async () => {
  const config = normalizeConfig(VISION)
  const resolved = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }
  let called = false
  const out = await routeRequest(resolved, config, () => {
    called = true
    return ''
  })
  assert.equal(called, false)
  assert.equal(out.provider, 'p')
  assert.equal(out.model, 'm')
})

test('routeRequest with an image runs the vision cascade and passes analysis to the text route', async () => {
  const config = normalizeConfig({ ...VISION, textProvider: 'deepseek', textModel: 'v4' })
  const resolved = {
    provider: 'deepseek',
    model: 'v4',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', src: 'i' }] }],
  }
  let visionOptions
  const generate = async (options) => {
    visionOptions = options
    return 'TOKEN_ANALYSIS'
  }
  const out = await routeRequest(resolved, config, generate)
  assert.equal(visionOptions.provider, VISION.visionProvider)
  assert.equal(visionOptions.model, VISION.visionModel)
  // Vision request carried the prompt + the image.
  assert.equal(visionOptions.messages[0].content.some((b) => b.type === 'image'), true)
  // Text route points at the configured text model, with no images left.
  assert.equal(out.provider, 'deepseek')
  assert.equal(out.model, 'v4')
  assert.equal(JSON.stringify(out.messages).includes('"type":"image"'), false)
  assert.match(JSON.stringify(out.messages), /TOKEN_ANALYSIS/)
})

test('routeRequest propagates a vision failure loudly', async () => {
  const config = normalizeConfig(VISION)
  const resolved = {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image' }] }],
  }
  await assert.rejects(
    () => routeRequest(resolved, config, async () => {
      throw new Error('vision boom')
    }),
    /vision boom/,
  )
})
