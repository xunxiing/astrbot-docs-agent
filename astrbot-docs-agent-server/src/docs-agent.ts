import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { run } from "./process.js"
import { runDocsUpdateAgent } from "./langchain-agent.js"
import type { LlmConfig } from "./llm.js"

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function gitRetryDelayMs(attempt: number) {
  const base = Number(process.env.GIT_RETRY_BASE_MS ?? "1500")
  const max = Number(process.env.GIT_RETRY_MAX_MS ?? "15000")
  const pow = Math.min(10, Math.max(0, attempt))
  const exp = base * Math.pow(2, pow)
  const jitter = Math.floor(Math.random() * 400)
  const ms = Math.min(max, exp) + jitter
  return Number.isFinite(ms) ? ms : 1500
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
  const p =
    process.env.PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  const np = process.env.NO_PROXY || process.env.no_proxy
  const env: NodeJS.ProcessEnv = {}
  if (p) {
    env.HTTP_PROXY = p
    env.HTTPS_PROXY = p
    env.ALL_PROXY = p
    env.http_proxy = p
    env.https_proxy = p
    env.all_proxy = p
  }
  if (np) {
    env.NO_PROXY = np
    env.no_proxy = np
  }
  return env
}

async function runGit(args: string[], opts: { cwd?: string; timeoutMs: number }) {
  const maxRetries = Math.max(0, Math.min(Number(process.env.GIT_MAX_RETRIES ?? "3"), 10))
  let last = await run("git", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: proxyEnv() })
  for (let attempt = 0; attempt < maxRetries && last.code !== 0 && isRetryableGit(last.stderr, last.stdout); attempt++) {
    const ms = gitRetryDelayMs(attempt)
    await sleep(ms)
    last = await run("git", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: proxyEnv() })
  }
  return last
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
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`)
  }

  // Ensure we're on the correct base branch BEFORE running the agent.
  const fetchBase = await runGit(["fetch", "origin", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (fetchBase.code !== 0) throw new Error(`git fetch failed: ${fetchBase.stderr || fetchBase.stdout}`)

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

  return {
    checkoutDir,
    workRoot,
    changed: changedDocs,
    summary: (agentRes.summary ?? "").trim()
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
