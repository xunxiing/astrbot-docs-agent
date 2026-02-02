import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { ChatOpenAI } from "@langchain/openai"

export type LlmProvider = "openai-compatible" | "gemini"

export type LlmConfig = {
  provider: LlmProvider
  apiKey: string
  model: string
  /** Provider base URL (optional). For OpenAI-compatible usually ends with `/v1`. For Gemini it overrides the default Google endpoint. */
  baseUrl?: string
  temperature?: number
}

export function createChatModel(cfg: LlmConfig) {
  const temperature = cfg.temperature ?? 0.2

  if (cfg.provider === "gemini") {
    // Keep types loose to reduce coupling to upstream LangChain option name changes.
    return new ChatGoogleGenerativeAI({
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {})
    } as any)
  }

  const options: any = {
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature
  }
  if (cfg.baseUrl) options.configuration = { baseURL: cfg.baseUrl }
  return new ChatOpenAI(options)
}
