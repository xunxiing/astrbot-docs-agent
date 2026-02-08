import { readFileSync } from "node:fs"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export const env = {
  port: Number(optional("PORT") ?? "8787"),
  logLevel: optional("LOG_LEVEL") ?? "info",

  githubAppId: required("GITHUB_APP_ID"),
  githubAppPrivateKey: (() => {
    const file = optional("GITHUB_APP_PRIVATE_KEY_FILE")
    if (file) return readFileSync(file, "utf-8")
    return required("GITHUB_APP_PRIVATE_KEY")
  })(),
  githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),

  // One or more code repos that can trigger jobs.
  // Prefer CODE_REPOS="owner1/repo1,owner2/repo2" if you want multiple.
  codeRepos: (() => {
    const raw = optional("CODE_REPOS") ?? required("CODE_REPO")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  })(),
  docsRepo: required("DOCS_REPO"),
  botMention: optional("BOT_MENTION") ?? "AstrBot-Doc-Agent",

  // LLM provider: "openai-compatible" (default) or "gemini"
  llmProvider: (optional("LLM_PROVIDER") ?? "openai-compatible") as "openai-compatible" | "gemini",
  llmApiKey: (() => {
    // Back-compat: MY_API_KEY was previously used for OpenCode. Keep it working.
    const v = optional("LLM_API_KEY") ?? optional("MY_API_KEY") ?? optional("GEMINI_API_KEY")
    if (!v) throw new Error("Missing env: LLM_API_KEY (or MY_API_KEY / GEMINI_API_KEY)")
    return v
  })(),
  llmBaseUrl: (() => {
    const provider = (optional("LLM_PROVIDER") ?? "openai-compatible") as "openai-compatible" | "gemini"
    const raw =
      provider === "gemini"
        ? optional("GEMINI_BASE_URL") ?? optional("LLM_BASE_URL")
        : optional("OPENAI_BASE_URL") ?? optional("LLM_BASE_URL") ?? optional("OPENCODE_BASE_URL") ?? "https://api.openai.com/v1"
    return (raw ?? "").trim().replace(/\/$/, "")
  })(),
  llmModel: (() => {
    const provider = (optional("LLM_PROVIDER") ?? "openai-compatible") as "openai-compatible" | "gemini"
    const raw =
      optional("LLM_MODEL") ??
      (provider === "gemini" ? optional("GEMINI_MODEL") : optional("OPENAI_MODEL")) ??
      optional("OPENCODE_MODEL") ??
      (provider === "gemini" ? "gemini-1.5-pro" : "gpt-4o-mini")
    const trimmed = (raw ?? "").trim()
    // Back-compat: OPENCODE_MODEL may be "provider/model" – keep only the model id.
    return trimmed.includes("/") ? trimmed.split("/").pop()! : trimmed
  })(),
  llmTemperature: (() => {
    const n = Number(optional("LLM_TEMPERATURE") ?? "0.2")
    return Number.isFinite(n) ? n : 0.2
  })(),
  // Debug: stream agent steps + tool calls into server logs (can be noisy).
  logAgent: optional("LOG_AGENT") === "1" || optional("LOG_AGENT") === "true",

  // Optional outbound proxy (useful for git clone/push from within Docker in CN networks).
  // Recommended for Docker Desktop: http://host.docker.internal:<port>
  proxyUrl:
    optional("PROXY_URL") ??
    optional("HTTP_PROXY") ??
    optional("http_proxy") ??
    optional("HTTPS_PROXY") ??
    optional("https_proxy") ??
    optional("ALL_PROXY") ??
    optional("all_proxy"),
  noProxy: optional("NO_PROXY") ?? optional("no_proxy"),

  dataDir: optional("DATA_DIR") ?? "/data",

  // Controls to prevent VPS overload
  maxConcurrentJobs: Number(optional("MAX_CONCURRENT_JOBS") ?? "1"),
  maxQueueSize: Number(optional("MAX_QUEUE_SIZE") ?? "10"),
  jobTimeoutSeconds: Number(optional("JOB_TIMEOUT_SECONDS") ?? "900"),
  maxPatchLines: Number(optional("MAX_PATCH_LINES") ?? "1200")
}
