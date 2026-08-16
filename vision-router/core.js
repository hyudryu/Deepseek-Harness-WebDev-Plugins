// core.js — dependency-free routing logic for the dsh-vision-router plugin.
//
// This module is deliberately free of any @deepseek-ai import so the unit
// tests can run with plain `node --test` and no harness packages installed.
// The harness wiring in index.js is the only place that touches the `llm`,
// `settings`, and agent-event services; everything here is plain JavaScript
// that maps a model request onto a routed request using only the configured
// models, image detection, and the injected `generate` vision callback.

export const DEFAULTS = Object.freeze({
  enabled: true,
  visionProvider: '',
  visionModel: '',
  visionPrompt:
    'You are the vision-capable first stage of a two-stage router. Analyze the image(s) and return a thorough written description of everything visible that could matter for answering the user\'s question, including text, layout, UI elements, colors, and visual state. Do not answer the user\'s question yourself; only produce the visual analysis the second (text) stage will consume.',
  textProvider: '',
  textModel: '',
  maxAnalysisChars: 20_000,
})

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error(`vision-router: ${name} must be a positive integer`)
  return value
}

function optionalString(value, name) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`vision-router: ${name} must be a string`)
  return value.trim()
}

// Normalize and validate the resolved configuration. The vision target is
// required for routing to activate; the text target is optional and each field
// inherits from the incoming request (the session-selected model) when unset.
export function normalizeConfig(input = {}) {
  const enabled = input.enabled ?? DEFAULTS.enabled
  if (typeof enabled !== 'boolean') throw new Error('vision-router: enabled must be a boolean')

  const visionProvider = optionalString(input.visionProvider, 'visionProvider')
  const visionModel = optionalString(input.visionModel, 'visionModel')
  if (visionProvider === '') throw new Error('vision-router: visionProvider is required (the provider of the vision-capable model)')
  if (visionModel === '') throw new Error('vision-router: visionModel is required (the vision-capable model id)')

  const textProvider = optionalString(input.textProvider, 'textProvider')
  const textModel = optionalString(input.textModel, 'textModel')

  const visionPrompt =
    typeof input.visionPrompt === 'string' && input.visionPrompt.trim() !== ''
      ? input.visionPrompt
      : DEFAULTS.visionPrompt

  const maxAnalysisChars = positiveInt(input.maxAnalysisChars, DEFAULTS.maxAnalysisChars, 'maxAnalysisChars')

  return Object.freeze({
    enabled,
    visionProvider,
    visionModel,
    visionPrompt,
    textProvider,
    textModel,
    maxAnalysisChars,
  })
}

// True when typed content contains an image block, recursing into nested
// tool-result content (mirrors the harness `contentHasImage` contract without
// importing it).
export function contentHasImage(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      (block != null && block.type === 'image') ||
      (block != null && block.type === 'tool-result' && contentHasImage(block.content)),
  )
}

export function messagesHaveImage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message != null && contentHasImage(message.content))
}

// Collect every image block, walking nested tool-result content, in document order.
export function collectImages(content, out = []) {
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (block == null) continue
    if (block.type === 'image') out.push(block)
    else if (block.type === 'tool-result') collectImages(block.content, out)
  }
  return out
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block != null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

// The newest non-empty user text, so the vision stage answers in context.
export function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message == null || message.role !== 'user') continue
    const text = textOf(message.content)
    if (text.trim() !== '') return text
  }
  return ''
}

// Build the messages for the vision sub-call: any system message retained for
// task context, then a single user message carrying the prompt plus every
// image from the original request.
export function visionMessagesFor(messages, visionPrompt) {
  const images = []
  for (const message of messages || []) collectImages(message && message.content, images)
  const userText = latestUserText(messages || [])
  const text = userText.trim() !== '' ? `${visionPrompt}\n\nUser question:\n${userText}` : visionPrompt
  const system = (messages || []).find((message) => message != null && message.role === 'system')
  const result = []
  if (system != null) result.push(system)
  result.push({ role: 'user', content: [{ type: 'text', text }, ...images] })
  return result
}

function cap(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, max)}\n…[analysis truncated]`
}

// Replace every image block in one content array with a text block carrying
// the vision analysis, recursing into nested tool-result content. Each
// tool-result therefore keeps the vision description tied to its own content
// instead of being emptied, preserving the association between a tool call and
// its visual output.
function replaceImagesWithAnalysis(content, analysisText) {
  if (!Array.isArray(content)) return content
  let changed = false
  const out = []
  for (const block of content) {
    if (block == null) continue
    if (block.type === 'image') {
      changed = true
      if (analysisText !== '') out.push({ type: 'text', text: analysisText })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = replaceImagesWithAnalysis(block.content, analysisText)
      if (inner !== block.content) {
        changed = true
        out.push({ ...block, content: inner })
      } else {
        out.push(block)
      }
      continue
    }
    out.push(block)
  }
  return changed ? out : content
}

// Rewrite the request so the text stage never sees a raw image: every image
// block is replaced in place by the vision analysis (inside tool results this
// keeps each analysis associated with its own tool call rather than emptying
// the result), and the same analysis is reflected at the newest user message
// for overall context.
export function withVisionAnalysis(messages, analysis, maxAnalysisChars) {
  const analysisText = `[Vision analysis]\n${cap(String(analysis ?? ''), maxAnalysisChars)}`
  const transformed = (messages || []).map((message) => {
    if (message == null || !Array.isArray(message.content)) return message
    const content = replaceImagesWithAnalysis(message.content, analysisText)
    return content === message.content ? message : { ...message, content }
  })
  for (let i = transformed.length - 1; i >= 0; i -= 1) {
    const message = transformed[i]
    if (message == null || message.role !== 'user' || !Array.isArray(message.content)) continue
    transformed[i] = {
      ...message,
      content: [{ type: 'text', text: analysisText }, ...message.content],
    }
    return transformed
  }
  transformed.push({ role: 'user', content: [{ type: 'text', text: analysisText }] })
  return transformed
}

// Assemble the vision model's output text from an async chunk stream. Chunks
// follow the harness `llm/stream` vocabulary: text deltas carry visible text;
// a `finish` chunk with an error/aborted reason fails the call loudly.
export async function assembleVisionText(chunks) {
  let text = ''
  for await (const chunk of chunks || []) {
    if (chunk == null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason != null) {
      if (chunk.reason.kind === 'error') {
        const failure = chunk.reason.failure || {}
        throw new Error(
          `vision-router: vision model call failed (${failure.code ?? 'ERROR'}): ${failure.message ?? 'unknown'}`,
        )
      }
      if (chunk.reason.kind === 'aborted') throw new Error('vision-router: vision model call was aborted')
    }
  }
  if (text.trim() === '') {
    throw new Error('vision-router: vision model returned no analysis text (an empty result is treated as a vision-stage failure)')
  }
  return text
}

// The plain (no-image) route: apply the configured text target, inheriting any
// unset side from the incoming request (the session-selected model).
export function textRoute(resolved, config) {
  return {
    ...resolved,
    ...(config.textProvider !== '' ? { provider: config.textProvider } : {}),
    ...(config.textModel !== '' ? { model: config.textModel } : {}),
  }
}

// Route one resolved request. When it carries an image the vision stage runs
// first (via the injected `generate` callback) and its analysis replaces the
// images before the text route applies; otherwise it routes straight to the
// text target. `config.enabled === false` passes the request through untouched.
export async function routeRequest(resolved, config, generate) {
  if (!config.enabled) return resolved
  if (!messagesHaveImage(resolved && resolved.messages)) return textRoute(resolved, config)

  const visionMessages = visionMessagesFor(resolved.messages, config.visionPrompt)
  const analysis = await generate({
    provider: config.visionProvider,
    model: config.visionModel,
    messages: visionMessages,
    signal: resolved && resolved.signal,
  })
  const messages = withVisionAnalysis(resolved.messages, analysis, config.maxAnalysisChars)
  return textRoute({ ...resolved, messages }, config)
}
