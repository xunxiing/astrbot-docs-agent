import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createRepoTools } from "./repo-tools.js"
import { createChatModel, type LlmConfig } from "./llm.js"
import { runGeminiDocsUpdateAgent } from "./gemini-agent.js"

type ToolCall = { id?: string; name: string; args: unknown }

function extractToolCalls(msg: unknown): ToolCall[] {
  const anyMsg: any = msg as any
  const calls = anyMsg?.tool_calls ?? anyMsg?.additional_kwargs?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls
    .map((c: any) => ({
      id: c.id ?? c.tool_call_id,
      name: c.name ?? c.function?.name,
      args: c.args ?? c.function?.arguments
    }))
    .filter((c: any) => typeof c.name === "string" && c.name.length > 0)
}

function parseArgs(args: unknown) {
  if (args && typeof args === "object") return args as Record<string, unknown>
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>
    } catch {
      return { raw: args }
    }
  }
  return {}
}

function msgText(msg: unknown): string {
  const anyMsg: any = msg as any
  const c = anyMsg?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n")
  return c ? String(c) : ""
}

export async function runDocsUpdateAgent(params: {
  repoRoot: string
  llm: LlmConfig
  prContextMarkdown: string
  log?: (line: string) => void
  maxSteps?: number
}) {
  if (params.llm.provider === "gemini") {
    // Use the official Gemini format (v1beta generateContent) to preserve thought signatures for tool calls.
    return await runGeminiDocsUpdateAgent({
      repoRoot: params.repoRoot,
      apiKey: params.llm.apiKey,
      model: params.llm.model,
      baseUrl: params.llm.baseUrl,
      apiVersion: process.env.GEMINI_API_VERSION || "v1beta",
      temperature: params.llm.temperature,
      prContextMarkdown: params.prContextMarkdown,
      log: params.log,
      maxTurns: params.maxSteps
    })
  }

  const tools = createRepoTools(params.repoRoot)
  const toolMap = new Map<string, any>(tools.map((t: any) => [t.name as string, t]))

  const model = createChatModel(params.llm)
  const boundModel: any = (model as any).bindTools ? (model as any).bindTools(tools) : model

  const system = new SystemMessage(
    [
      "You are a careful documentation maintainer.",
      "You will update the current docs repository based on the upstream PR context.",
      "",
      "Rules:",
      "- Prefer editing existing docs; create new docs pages only when necessary.",
      "- Allowed to write: *.md/*.mdx and VitePress config under .vitepress/ (js/mjs/ts/json).",
      "- Do NOT modify CI, workflows, dependencies, or unrelated code.",
      "- Avoid guessing. If info is missing, add TODO/NOTE in docs instead of inventing.",
      "- IMPORTANT i18n: if you change or add a user-facing doc page, update BOTH zh/ and en/ versions (or add TODO notes in both languages).",
      "- Keep docs meaningful: DO NOT add generic/obvious sections that do not help users (e.g. redundant '结果反馈' or verbose theory).",
      "- Prefer concise, actionable content aligned with existing docs style.",
      "- Use the provided tools to read/list/write files and make changes in the repo.",
      "- When finished, reply with a concise Markdown summary in Chinese (bullets)."
    ].join("\n")
  )

  const user = new HumanMessage(
    [
      "Upstream PR context:",
      "",
      params.prContextMarkdown,
      "",
      "Task:",
      "1) Update docs to reflect user-visible changes in this PR.",
      "2) If a changelog/release-notes file exists, add an entry.",
      "3) Ensure navigation/sidebar is updated if you add new docs pages.",
      "",
      "Start by using tools to explore the repo structure (list_directory/find_files) before editing."
    ].join("\n")
  )

  const messages: BaseMessage[] = [system, user]
  const maxSteps = Math.max(1, Math.min(params.maxSteps ?? 24, 60))

  for (let step = 0; step < maxSteps; step++) {
    const ai: AIMessage = await boundModel.invoke(messages)
    const content = msgText(ai).trim()

    const toolCalls = extractToolCalls(ai)
    params.log?.(`[agent] step=${step + 1} toolCalls=${toolCalls.length}`)
    if (content) params.log?.(`[agent] ${content}`)
    messages.push(ai)

    if (toolCalls.length === 0) return { summary: content }

    for (const call of toolCalls) {
      const tool = toolMap.get(call.name) as any
      const id = call.id ?? `${call.name}-${step}`
      if (!tool) {
        messages.push(new ToolMessage(`ERROR: tool not found: ${call.name}`, id))
        continue
      }
      const args = parseArgs(call.args)
      try {
        params.log?.(`[tool] ${call.name} ${JSON.stringify(args).slice(0, 500)}`)
        const res = await tool.invoke(args as any)
        const out = typeof res === "string" ? res : JSON.stringify(res)
        messages.push(new ToolMessage(out.slice(0, 50_000), id))
      } catch (e: any) {
        messages.push(new ToolMessage(`ERROR: ${String(e?.message ?? e)}`, id))
      }
    }
  }

  return { summary: "Agent stopped: max steps reached. (No final summary returned.)" }
}
