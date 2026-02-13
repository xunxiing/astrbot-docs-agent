import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { run } from "./process.js"
import { runDocsUpdateAgent } from "./langchain-agent.js"
import type { LlmConfig } from "./llm.js"
import { createChatModel } from "./llm.js"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { env } from "./env.js"

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function gitRetryDelayMs(attempt: number) {
  const base = Number(process.env.GIT_RETRY_BASE_MS ?? "2000") // Increased base delay
  const max = Number(process.env.GIT_RETRY_MAX_MS ?? "30000") // Increased max delay
  const pow = Math.min(10, Math.max(0, attempt))
  const exp = base * Math.pow(2, pow)
  const jitter = Math.floor(Math.random() * 800) // Increased jitter
  const ms = Math.min(max, exp) + jitter
  return Number.isFinite(ms) ? ms : 2000
}

function isRetryableGit(stderr: string, stdout: string) {
  const s = `${stderr}\n${stdout}`.toLowerCase()
  return (
    s.includes("could not resolve host") ||
    s.includes("failed to connect") ||
    s.includes("connection timed out") ||
    s.includes("connection reset") ||
    s.includes("network is unreachable") ||
    s.includes("tls") ||
    s.includes("gnutls") ||
    s.includes("ssl") ||
    s.includes("http 429") ||
    s.includes("http 5") ||
    s.includes("rpc failed") ||
    s.includes("http2") ||
    s.includes("stream error")
  )
}

function proxyEnv(): NodeJS.ProcessEnv {
  if (!env.useProxy) {
    return {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*"
    }
  }

  const p =
    process.env.PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  const np = process.env.NO_PROXY || process.env.no_proxy
  const out: NodeJS.ProcessEnv = {}
  if (p) {
    out.HTTP_PROXY = p
    out.HTTPS_PROXY = p
    out.ALL_PROXY = p
    out.http_proxy = p
    out.https_proxy = p
    out.all_proxy = p
  }
  if (np) {
    out.NO_PROXY = np
    out.no_proxy = np
  }
  return out
}

async function runGit(args: string[], opts: { cwd?: string; timeoutMs: number }) {
  const maxRetries = Math.max(0, Math.min(Number(process.env.GIT_MAX_RETRIES ?? "5"), 10)) // Increased max retries
  let last = await run("git", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: proxyEnv() })
  for (let attempt = 0; attempt < maxRetries && last.code !== 0 && isRetryableGit(last.stderr, last.stdout); attempt++) {
    const ms = gitRetryDelayMs(attempt)
    console.log(`Git command failed, retrying in ${ms}ms... (attempt ${attempt + 1}/${maxRetries})`)
    await sleep(ms)
    last = await run("git", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: proxyEnv() })
  }
  return last
}

function parseJsonObject(text: string): any | undefined {
  const t = (text ?? "").trim()
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf("{")
    const end = t.lastIndexOf("}")
    if (start >= 0 && end > start) {
      const slice = t.slice(start, end + 1)
      try {
        return JSON.parse(slice)
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

async function generateDocsPrMeta(params: {
  llm: LlmConfig
  upstreamRepo: string
  upstreamPrNumber: number
  upstreamPrTitle: string
  changedFiles: string[]
  rawAgentSummary: string
}) {
  const model = createChatModel(params.llm)
  const sys = new SystemMessage(
    [
      "你是一个严谨的文档维护者。",
      "请为“文档更新 PR”生成中文标题与中文改动摘要。",
      "",
      "要求：",
      "- 输出必须是严格 JSON（不要 markdown，不要多余文字）。",
      "- title：一行中文标题，<= 60 字，描述文档更新主题。",
      "- summary：中文要点列表（用 \\n- ... 形式），内容聚焦用户可见变更与文档位置；不要总结无意义的背景段落。",
      "- 如果新增了页面且涉及导航/侧边栏，请在 summary 中提到。",
      "- 如果存在 i18n（zh/en）对应更新，请在 summary 中提到；若缺失请写 TODO。"
    ].join("\n")
  )
  const user = new HumanMessage(
    [
      `上游仓库：${params.upstreamRepo}`,
      `上游 PR：#${params.upstreamPrNumber}`,
      `上游 PR 标题：${params.upstreamPrTitle}`,
      "",
      "本次文档仓库改动文件：",
      ...(params.changedFiles.length ? params.changedFiles.map((f) => `- ${f}`) : ["- (none)"]),
      "",
      "Agent 原始摘要（可能为英文）：",
      params.rawAgentSummary || "(empty)",
      "",
      '请输出 JSON，例如：{"title":"...","summary":"- ...\\n- ..."}'
    ].join("\n")
  )
  const resp: any = await (model as any).invoke([sys, user])
  const content = typeof resp?.content === "string" ? resp.content : String(resp?.content ?? "")
  const obj = parseJsonObject(content) ?? {}
  const title = typeof obj.title === "string" ? obj.title.trim() : ""
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  return { title, summary }
}

function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/", 2)
  if (!owner || !repo) throw new Error(`Invalid repo: ${full}`)
  return { owner, repo }
}

function toAuthGitUrl(token: string, repoFull: string) {
  return `https://x-access-token:${token}@github.com/${repoFull}.git`
}

function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // porcelain v1: XY <path> (rename: XY old -> new)
      const parts = l.split(/\s+/)
      const p = parts.slice(1).join(" ")
      return p.includes("->") ? p.split("->").pop()!.trim() : p.trim()
    })
    .filter(Boolean)
}

export async function generateDocsForPr(params: {
  docsRepo: string
  docsToken: string
  baseBranch: string
  branch: string
  codeRepo: string
  prNumber: number
  prTitle: string
  prBody: string
  prUrl: string
  prFiles: string[]
  prPatch: string
  manualInstruction?: string
  triggerSource?: "pr_merged" | "pr_comment"
  dataDir: string
  timeoutMs: number
  logAgent?: boolean
  llm: LlmConfig
}) {
  const { owner: docsOwner, repo: docsName } = parseRepo(params.docsRepo)
  const workRoot = path.join(params.dataDir, "runs", `${docsOwner}-${docsName}`, `pr-${params.prNumber}`)
  await mkdir(workRoot, { recursive: true })

  const checkoutDir = path.join(workRoot, "docs")
  const cloneUrl = toAuthGitUrl(params.docsToken, params.docsRepo)

  const isDir = await stat(checkoutDir)
    .then((s) => s.isDirectory())
    .catch(() => false)

  const ensureRepoOk = await (async () => {
    if (!isDir) return false
    try {
      const r = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
      return r.code === 0
    } catch {
      return false
    }
  })()

  if (!ensureRepoOk) {
    const clone = await runGit(["clone", "--depth=1", cloneUrl, checkoutDir], { timeoutMs: params.timeoutMs })
    if (clone.code !== 0) {
      console.warn(`git clone failed: ${clone.stderr || clone.stdout}. This might be a network issue.`)
      // We continue because we might be able to use GitHub API later if GITHUB_TOKEN is provided,
      // but current implementation still relies on local git for agent tools.
      throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`)
    }
  }

  // Ensure we're on the correct base branch BEFORE running the agent.
  const fetchBase = await runGit(["fetch", "origin", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (fetchBase.code !== 0) {
    console.warn(`git fetch failed: ${fetchBase.stderr || fetchBase.stdout}.`)
    // If fetch fails and we have a GITHUB_TOKEN, we could potentially fallback,
    // but the LangChain agent currently expects a local git repo to work with.
    throw new Error(`git fetch failed: ${fetchBase.stderr || fetchBase.stdout}`)
  }

  const checkoutBase = await runGit(["checkout", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (checkoutBase.code !== 0) throw new Error(`git checkout failed: ${checkoutBase.stderr || checkoutBase.stdout}`)

  const resetBase = await runGit(["reset", "--hard", `origin/${params.baseBranch}`], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (resetBase.code !== 0) throw new Error(`git reset failed: ${resetBase.stderr || resetBase.stdout}`)

  const clean = await runGit(["clean", "-fdx"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (clean.code !== 0) throw new Error(`git clean failed: ${clean.stderr || clean.stdout}`)

  const checkoutBranch = await runGit(["checkout", "-B", params.branch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (checkoutBranch.code !== 0) throw new Error(`git checkout -B failed: ${checkoutBranch.stderr || checkoutBranch.stdout}`)

  const prContextMarkdown = [
    "# PR Context",
    "",
    `- Trigger source: ${params.triggerSource ?? "pr_merged"}`,
    `- Repo: ${params.codeRepo}`,
    `- PR: #${params.prNumber}`,
    "",
    "## Title",
    params.prTitle ?? "",
    "",
    "## URL",
    params.prUrl ?? "",
    "",
    "## Description (Body)",
    params.prBody ?? "",
    "",
    "## Files",
    ...(params.prFiles.length ? params.prFiles : ["(none)"]),
    "",
    "## Diff (truncated)",
    "```diff",
    params.prPatch ?? "",
    "```",
    "",
    "## Manual Instruction",
    params.manualInstruction?.trim() ? params.manualInstruction.trim() : "(none)",
    ""
  ].join("\n")

  const agentRes = await runDocsUpdateAgent({
    repoRoot: checkoutDir,
    llm: params.llm,
    prContextMarkdown,
    maxSteps: 24,
    ...(params.logAgent
      ? {
          log: (line: string) => console.log(line)
        }
      : {})
  })

  const status = await runGit(["status", "--porcelain=v1"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr}`)

  const changedPaths = parsePorcelainPaths(status.stdout)
  const changedDocs = changedPaths.some((p) => p.endsWith(".md") || p.endsWith(".mdx"))

  const changedFilesRes = await runGit(["diff", "--name-only"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  const changedFiles = (changedFilesRes.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const meta = await generateDocsPrMeta({
    llm: params.llm,
    upstreamRepo: params.codeRepo,
    upstreamPrNumber: params.prNumber,
    upstreamPrTitle: params.prTitle,
    changedFiles,
    rawAgentSummary: (agentRes.summary ?? "").trim()
  }).catch(() => ({ title: "", summary: "" }))

  return {
    checkoutDir,
    workRoot,
    changed: changedDocs,
    summary: (meta.summary || agentRes.summary || "").trim(),
    docsPrTitle: meta.title || ""
  }
}

export async function commitAndPushDocsBranch(params: {
  docsRepo: string
  docsToken: string
  checkoutDir: string
  branch: string
  commitMessage: string
  timeoutMs: number
}) {
  const originUrl = toAuthGitUrl(params.docsToken, params.docsRepo)

  const setUser = await runGit(["config", "user.name", "astrbot-docs-agent[bot]"], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setUser.code !== 0) throw new Error(setUser.stderr)

  const setEmail = await runGit(["config", "user.email", "astrbot-docs-agent[bot]@users.noreply.github.com"], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setEmail.code !== 0) throw new Error(setEmail.stderr)

  const setOrigin = await runGit(["remote", "set-url", "origin", originUrl], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setOrigin.code !== 0) throw new Error(setOrigin.stderr)

  const add = await runGit(["add", "-A"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (add.code !== 0) throw new Error(add.stderr || add.stdout)

  const staged = await runGit(["diff", "--cached", "--name-only"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout)

  const stagedPaths = staged.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const stagedDocPaths = stagedPaths.filter((p) => p.endsWith(".md") || p.endsWith(".mdx"))
  if (stagedDocPaths.length === 0) throw new Error("No staged docs changes (only non-doc files changed).")

  const commit = await runGit(["commit", "-m", params.commitMessage], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout)

  const push = await runGit(["push", "--force", "--set-upstream", "origin", params.branch], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (push.code !== 0) throw new Error(push.stderr || push.stdout)
}
