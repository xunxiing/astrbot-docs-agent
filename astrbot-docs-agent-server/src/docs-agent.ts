import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { run } from "./process.js"

function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/", 2)
  if (!owner || !repo) throw new Error(`Invalid repo: ${full}`)
  return { owner, repo }
}

function toAuthGitUrl(token: string, repoFull: string) {
  return `https://x-access-token:${token}@github.com/${repoFull}.git`
}

export async function generateDocsForPr(params: {
  docsRepo: string
  docsToken: string
  codeRepo: string
  prNumber: number
  prTitle: string
  prBody: string
  prUrl: string
  prFiles: string[]
  prPatch: string
  dataDir: string
  timeoutMs: number
  opencode: {
    baseUrl: string
    apiKey: string
    model: string
  }
}) {
  const { owner: docsOwner, repo: docsName } = parseRepo(params.docsRepo)
  const workRoot = path.join(params.dataDir, "runs", `${docsOwner}-${docsName}`, `pr-${params.prNumber}`)

  await mkdir(workRoot, { recursive: true })

  const checkoutDir = path.join(workRoot, "docs")
  await rm(checkoutDir, { recursive: true, force: true })

  const cloneUrl = toAuthGitUrl(params.docsToken, params.docsRepo)

  const clone = await run("git", ["clone", "--depth=1", cloneUrl, checkoutDir], { timeoutMs: params.timeoutMs })
  if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr}`)

  await mkdir(path.join(checkoutDir, ".opencode"), { recursive: true })

  const contextMd = [
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

  await writeFile(path.join(checkoutDir, ".opencode", "pr_context.md"), contextMd, "utf-8")

  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "my-thirdparty": {
        npm: "@ai-sdk/openai-compatible",
        name: "My ThirdParty",
        options: {
          baseURL: "{env:OPENCODE_BASE_URL}",
          apiKey: "{env:MY_API_KEY}"
        },
        models: {
          "my-model": { name: "My Large Model" }
        }
      }
    },
    model: params.opencode.model
  }

  const prompt = [
    "你是一个严谨的文档维护者。",
    "",
    "你将收到一份来自代码仓库 PR 的上下文（标题、描述、改动文件列表、diff 截断）。",
    "请在当前文档仓库中：",
    "1) 找到最合适的文档位置并更新（或新增）Markdown 文档来覆盖此次 PR 的用户可见变更。",
    "2) 如果仓库存在 changelog / release notes / 版本记录，请补充一条对应内容。",
    "3) 避免臆测：仅根据上下文与仓库现有内容输出；若信息不足，请在文档中注明 TODO/待确认点，而不是编造。",
    "4) 只修改文档仓库内的文档内容（例如 *.md/*.mdx），不要改 CI、脚本、依赖。",
    "",
    "输出以“直接修改文件”的方式完成（在仓库里落地改动），不要只给建议。"
  ].join("\n")

  const opencodeRun = await run(
    "opencode",
    // yargs 的 `--file/-f` 是 array，会吞掉后续参数；用 `--` 把 prompt 强制放到 args["--"] 里
    ["run", "-f", ".opencode/pr_context.md", "--", prompt],
    {
      cwd: checkoutDir,
      timeoutMs: params.timeoutMs,
      env: {
        MY_API_KEY: params.opencode.apiKey,
        OPENCODE_BASE_URL: params.opencode.baseUrl,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig)
      }
    }
  )
  if (opencodeRun.code !== 0) throw new Error(`opencode failed: ${opencodeRun.stderr || opencodeRun.stdout}`)

  const status = await run("git", ["status", "--porcelain=v1"], { cwd: checkoutDir, timeoutMs: params.timeoutMs })
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr}`)

  const changed = status.stdout.trim().length > 0
  return { checkoutDir, workRoot, changed }
}

export async function commitAndPushDocsBranch(params: {
  docsRepo: string
  docsToken: string
  checkoutDir: string
  baseBranch: string
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

  // Ensure origin uses token
  const setOrigin = await run("git", ["remote", "set-url", "origin", originUrl], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (setOrigin.code !== 0) throw new Error(setOrigin.stderr)

  // Fetch base and create branch
  const fetch = await run("git", ["fetch", "origin", params.baseBranch], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (fetch.code !== 0) throw new Error(fetch.stderr)

  const checkoutBase = await run("git", ["checkout", params.baseBranch], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (checkoutBase.code !== 0) throw new Error(checkoutBase.stderr)

  const resetBase = await run("git", ["reset", "--hard", `origin/${params.baseBranch}`], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (resetBase.code !== 0) throw new Error(resetBase.stderr)

  const checkoutBranch = await run("git", ["checkout", "-B", params.branch], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (checkoutBranch.code !== 0) throw new Error(checkoutBranch.stderr)

  const add = await run("git", ["add", "-A"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (add.code !== 0) throw new Error(add.stderr)

  const commit = await run("git", ["commit", "-m", params.commitMessage], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs })
  if (commit.code !== 0) throw new Error(commit.stderr)

  const push = await run("git", ["push", "--force", "--set-upstream", "origin", params.branch], {
    cwd: params.checkoutDir,
    timeoutMs: params.timeoutMs
  })
  if (push.code !== 0) throw new Error(push.stderr)
}
