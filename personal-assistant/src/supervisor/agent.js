import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

// The API key is read from the configured env var at construction time and
// handed to the SDK; it is never stored on the normalized config.
export function createSupervisorAgent(config, { systemPrompt, tools } = {}) {
  const apiKey = process.env[config.strands.apiKeyEnv]
  const model = new OpenAIModel({
    api: 'chat',
    modelId: config.strands.model,
    ...(apiKey ? { apiKey } : {}),
    clientConfig: { baseURL: config.strands.baseUrl },
  })
  return new Agent({ model, systemPrompt, tools })
}

// Thin wrapper: invoke once and return the final text (AgentResult.toString()
// extracts text blocks, or serialized structured output when present).
export async function invoke(agent, prompt, maxTurnsPerInvocation) {
  const result = await agent.invoke(prompt, { limits: { turns: maxTurnsPerInvocation } })
  return result.toString()
}
