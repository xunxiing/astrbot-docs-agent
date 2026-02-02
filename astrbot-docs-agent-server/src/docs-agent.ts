import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { run } from "./process.js"
import { runDocsUpdateAgent } from "./langchain-agent.js"
import type { LlmConfig } from "./llm.js"

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
      const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
      return r.code === 0
    } catch {
      return false
    }
  })()

  if (!ensureRepoOk) {
    const clone = await run("git", ["clone", "--depth=1", cloneUrl, checkoutDir], { timeoutMs: params.timeoutMs })
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`)
  }

  // Ensure we're on the correct base branch BEFORE running the agent.
  const fetchBase = await run("git", ["fetch", "origin", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (fetchBase.code !== 0) throw new Error(`git fetch failed: ${fetchBase.stderr || fetchBase.stdout}`)

  const checkoutBase = await run("git", ["checkout", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (checkoutBase.code !== 0) throw new Error(`git checkout failed: ${checkoutBase.stderr || checkoutBase.stdout}`)

  const resetBase = await run("git", ["reset", "--hard", `origin/${params.baseBranch}`], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (resetBase.code !== 0) throw new Error(`git reset failed: ${resetBase.stderr || resetBase.stdout}`)

  const clean = await run("git", ["clean", "-fdx"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (clean.code !== 0) throw new Error(`git clean failed: ${clean.stderr || clean.stdout}`)

  const checkoutBranch = await run("git", ["checkout", "-B", params.branch], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
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

  const status = await run("git", ["status", "--porcelain=v1"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
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

  const setUser = await run("git", ["config", "user.name", "astrbot-docs-agent[bot]"], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setUser.code !== 0) throw new Error(setUser.stderr)

  const setEmail = await run("git", ["config", "user.email", "astrbot-docs-agent[bot]@users.noreply.github.com"], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setEmail.code !== 0) throw new Error(setEmail.stderr)

  const setOrigin = await run("git", ["remote", "set-url", "origin", originUrl], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setOrigin.code !== 0) throw new Error(setOrigin.stderr)

  const add = await run("git", ["add", "-A"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (add.code !== 0) throw new Error(add.stderr || add.stdout)

  const staged = await run("git", ["diff", "--cached", "--name-only"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout)

  const stagedPaths = staged.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const stagedDocPaths = stagedPaths.filter((p) => p.endsWith(".md") || p.endsWith(".mdx"))
  if (stagedDocPaths.length === 0) throw new Error("No staged docs changes (only non-doc files changed).")

  const commit = await run("git", ["commit", "-m", params.commitMessage], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout)

  const push = await run("git", ["push", "--force", "--set-upstream", "origin", params.branch], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (push.code !== 0) throw new Error(push.stderr || push.stdout)
}

