import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { ChatOpenAI } from "@langchain/openai"

export type LlmProvider = "openai-compatible" | "gemini"

export type LlmConfig = {
  provider: LlmProvider
  apiKey: string
  model: string
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or https://your-newapi/v1 */
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
      temperature
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

