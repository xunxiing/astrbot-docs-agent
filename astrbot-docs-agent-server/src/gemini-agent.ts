import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type Part,
  type EnhancedGenerateContentResponse,
  SchemaType
} from "@google/generative-ai"

import { createRepoTools } from "./repo-tools.js"

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function getErrorStatus(err: any): number | undefined {
  if (!err) return undefined
  const status = err.status ?? err.statusCode ?? err.code
  if (typeof status === "number") return status
  if (typeof status === "string") {
    const n = Number(status)
    if (Number.isFinite(n)) return n
  }
  const msg = String(err.message ?? "")
  const m = msg.match(/\b(429|500|502|503|504)\b/)
  return m ? Number(m[1]) : undefined
}

function shouldRetry(err: any) {
  const status = getErrorStatus(err)
  if (!status) return false
  if (status === 429) return true
  if (status >= 500 && status <= 504) return true
  return false
}

function retryDelayMs(attempt: number) {
  const base = Number(process.env.GEMINI_RETRY_BASE_MS ?? "2000")
  const max = Number(process.env.GEMINI_RETRY_MAX_MS ?? "60000")
  const pow = Math.min(10, Math.max(0, attempt))
  const exp = base * Math.pow(2, pow)
  const jitter = Math.floor(Math.random() * 500)
  const ms = Math.min(max, exp) + jitter
  return Number.isFinite(ms) ? ms : 2000
}

function extractText(resp: EnhancedGenerateContentResponse): string {
  try {
    const t = resp.text()
    return typeof t === "string" ? t : ""
  } catch {
    // Fallback: join all text parts
    const c = resp.candidates?.[0]?.content
    const parts = c?.parts ?? []
    return parts.map((p: any) => (p?.text ? String(p.text) : "")).filter(Boolean).join("\n")
  }
}

function extractFunctionCalls(content: Content): Array<{ name: string; args: unknown; partIndex: number }> {
  const out: Array<{ name: string; args: unknown; partIndex: number }> = []
  const parts = (content.parts ?? []) as any[]
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const fc = p?.functionCall
    if (!fc?.name) continue
    out.push({ name: String(fc.name), args: fc.args ?? {}, partIndex: i })
  }
  return out
}

function safeParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function normalizeToolResult(result: unknown) {
  if (typeof result === "string") {
    const parsed = safeParseJson(result)
    return parsed ?? { result: result.slice(0, 20000) }
  }
  return result
}

function geminiFunctionDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "list_directory",
      description: "List entries in a directory (relative to repo root).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          path: { type: SchemaType.STRING, description: "Relative directory path." },
          maxEntries: { type: SchemaType.INTEGER, description: "Max entries to return." }
        },
        required: ["path"]
      }
    },
    {
      name: "find_files",
      description: "Recursively find files under a directory (relative to repo root).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          path: { type: SchemaType.STRING },
          extensions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } as any } as any,
          maxResults: { type: SchemaType.INTEGER },
          maxDepth: { type: SchemaType.INTEGER }
        },
        required: ["path"]
      }
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file (relative to repo root).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          path: { type: SchemaType.STRING },
          maxChars: { type: SchemaType.INTEGER }
        },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file (relative to repo root). Allowed paths: *.md/*.mdx and .vitepress/*.(js|mjs|ts|json).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          path: { type: SchemaType.STRING },
          content: { type: SchemaType.STRING }
        },
        required: ["path", "content"]
      }
    }
  ]
}

export async function runGeminiDocsUpdateAgent(params: {
  repoRoot: string
  apiKey: string
  model: string
  baseUrl?: string
  apiVersion?: string
  temperature?: number
  prContextMarkdown: string
  log?: (line: string) => void
  maxTurns?: number
}) {
  const tools = createRepoTools(params.repoRoot)
  const toolMap = new Map<string, any>(tools.map((t: any) => [t.name as string, t]))

  const systemPrompt = [
    "You are a careful documentation maintainer.",
    "You will update the current docs repository based on the upstream PR context.",
    "",
    "Rules:",
    "- Prefer editing existing docs; create new docs pages only when necessary.",
    "- Allowed to write: *.md/*.mdx and VitePress config under .vitepress/ (js/mjs/ts/json).",
    "- Do NOT modify CI, workflows, dependencies, or unrelated code.",
    "- Avoid guessing. If info is missing, add TODO/NOTE in docs instead of inventing.",
    "- IMPORTANT i18n: if you change or add a user-facing doc page, update BOTH zh/ and en/ versions (or add TODO notes in both languages).",
    "- Keep docs meaningful: DO NOT add generic/obvious sections that do not help users (e.g. redundant 'result feedback' sections).",
    "- Prefer concise, actionable content aligned with existing docs style.",
    "- Use function calling tools to read/list/write files and make changes in the repo.",
    "- When finished, respond with a concise Markdown summary in Chinese (bullets)."
  ].join("\n")

  const genAI = new GoogleGenerativeAI(params.apiKey)
  const requestOptions = {
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.apiVersion ? { apiVersion: params.apiVersion } : {})
  }

  const model = genAI.getGenerativeModel(
    {
      model: params.model,
      systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
      tools: [{ functionDeclarations: geminiFunctionDeclarations() }]
    } as any,
    requestOptions as any
  )

  const contents: Content[] = [
    {
      role: "user",
      parts: [
        {
          text: [
            "Upstream PR context:",
            "",
            params.prContextMarkdown,
            "",
            "Task:",
            "1) Update docs to reflect user-visible changes in this PR.",
            "2) If a changelog/release-notes file exists, add an entry.",
            "3) Ensure navigation/sidebar is updated if you add new docs pages.",
            "",
            "Start by exploring the repo structure before editing."
          ].join("\n")
        }
      ]
    }
  ]

  const maxTurns = Math.max(1, Math.min(params.maxTurns ?? 20, 60))
  for (let turn = 0; turn < maxTurns; turn++) {
    params.log?.(`[agent] turn=${turn + 1}`)
    const maxRetries = Math.max(0, Math.min(Number(process.env.GEMINI_MAX_RETRIES ?? "6"), 20))
    let result: any
    for (let attempt = 0; ; attempt++) {
      try {
        result = await model.generateContent({
          contents,
          generationConfig: {
            temperature: params.temperature ?? 1.0
          }
        } as any)
        break
      } catch (e: any) {
        if (!shouldRetry(e) || attempt >= maxRetries) throw e
        const ms = retryDelayMs(attempt)
        const status = getErrorStatus(e)
        params.log?.(`[gemini] retryable error${status ? ` ${status}` : ""}; sleeping ${ms}ms (attempt ${attempt + 1}/${maxRetries})`)
        await sleep(ms)
      }
    }

    const resp = result.response
    const candidateContent = resp.candidates?.[0]?.content
    if (!candidateContent) {
      return { summary: extractText(resp) || "No candidate content returned." }
    }

    // IMPORTANT: push the model content back verbatim (preserves thoughtSignature / order)
    contents.push(candidateContent as any)

    const calls = extractFunctionCalls(candidateContent as any)
    if (calls.length === 0) {
      const text = extractText(resp).trim()
      return { summary: text || "Done." }
    }

    for (const call of calls) {
      const tool = toolMap.get(call.name)
      if (!tool) {
        contents.push({
          role: "function",
          parts: [{ functionResponse: { name: call.name, response: { error: "tool not found" } } } as any]
        })
        continue
      }
      try {
        params.log?.(`[tool] ${call.name} ${JSON.stringify(call.args).slice(0, 500)}`)
        const toolRes = await tool.invoke(call.args as any)
        const responseObj = normalizeToolResult(toolRes)
        contents.push({
          role: "function",
          parts: [{ functionResponse: { name: call.name, response: responseObj as any } } as any]
        })
      } catch (e: any) {
        contents.push({
          role: "function",
          parts: [{ functionResponse: { name: call.name, response: { error: String(e?.message ?? e) } } } as any]
        })
      }
    }
  }

  return { summary: "Agent stopped: max turns reached." }
}
