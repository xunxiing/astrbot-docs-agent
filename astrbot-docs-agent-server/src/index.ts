import express from "express"
import { Webhooks } from "@octokit/webhooks"
import { env } from "./env.js"
import { createInstallationOctokit } from "./github.js"
import { createLogger } from "./log.js"
import { commitAndPushDocsBranch, generateDocsForPr } from "./docs-agent.js"

const log = createLogger(env.logLevel as any)

type Job = { key: string; startedAt?: number; run: () => Promise<void> }

const pending = new Map<string, Job>()
const inflight = new Set<string>()
let running = 0

function enqueue(job: Job) {
  if (inflight.has(job.key)) return { ok: true, deduped: true }
  if (pending.has(job.key)) pending.delete(job.key) // move to end (newest wins)
  if (!pending.has(job.key) && pending.size >= env.maxQueueSize) return { ok: false, reason: "queue_full" as const }
  pending.set(job.key, job)
  pump()
  return { ok: true, deduped: false }
}

function pump() {
  while (running < env.maxConcurrentJobs && pending.size > 0) {
    const [key, job] = pending.entries().next().value as [string, Job]
    pending.delete(key)
    inflight.add(key)
    running += 1
    job.startedAt = Date.now()
    void job
      .run()
      .catch((e) => log.error("Job failed", { key, err: String(e?.message ?? e) }))
      .finally(() => {
        running -= 1
        inflight.delete(key)
        pump()
      })
  }
}

function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/", 2)
  if (!owner || !repo) throw new Error(`Invalid repo: ${full}`)
  return { owner, repo }
}

function truncateLines(text: string, maxLines: number) {
  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join("\n") + `\n\n# --- truncated (${lines.length - maxLines} more lines) ---\n`
}

async function getDefaultBranch(octokit: any, owner: string, repo: string) {
  const r = await octokit.repos.get({ owner, repo })
  return r.data.default_branch
}

async function ensureDocsPr(params: {
  octokit: any
  docsOwner: string
  docsRepo: string
  head: string
  base: string
  title: string
  body: string
}) {
  const list = await params.octokit.pulls.list({
    owner: params.docsOwner,
    repo: params.docsRepo,
    state: "open",
    head: `${params.docsOwner}:${params.head}`
  })
  if (list.data.length > 0) return list.data[0].html_url as string

  const pr = await params.octokit.pulls.create({
    owner: params.docsOwner,
    repo: params.docsRepo,
    head: params.head,
    base: params.base,
    title: params.title,
    body: params.body
  })
  return pr.data.html_url as string
}

const webhooks = new Webhooks({ secret: env.githubWebhookSecret })

webhooks.on("pull_request.opened", handlePullRequest)
webhooks.on("pull_request.reopened", handlePullRequest)
webhooks.on("pull_request.synchronize", handlePullRequest)
webhooks.on("pull_request.edited", handlePullRequest)

async function handlePullRequest(event: any) {
  const repoFull = event.payload.repository?.full_name as string
  const prNumber = event.payload.pull_request?.number as number

  if (!repoFull || !prNumber) {
    log.warn("Webhook missing repo/pr", { repoFull, prNumber })
    return
  }

  if (!env.codeRepos.includes(repoFull)) {
    // GitHub App webhooks fire for every installed repo. It's normal to receive events from DOCS_REPO too.
    if (repoFull === env.docsRepo) log.info("Ignored docs repo event", { repoFull })
    else log.warn("Ignored repo (not allowlisted)", { repoFull, allow: env.codeRepos })
    return
  }

  const action = event.payload.action as string
  log.info("PR event received", { repo: repoFull, prNumber, action })

  const key = `${repoFull}#${prNumber}`
  const enq = enqueue({
    key,
    run: async () => {
      const start = Date.now()
      log.info("Job start", { key })
      try {
        const m0 = process.memoryUsage()
        log.info("Job memory (start)", {
          key,
          rss: m0.rss,
          heapUsed: m0.heapUsed,
          heapTotal: m0.heapTotal,
          external: m0.external
        })
        await processPullRequest(repoFull, prNumber)
        const m1 = process.memoryUsage()
        log.info("Job memory (end)", {
          key,
          rss: m1.rss,
          heapUsed: m1.heapUsed,
          heapTotal: m1.heapTotal,
          external: m1.external
        })
      } finally {
        log.info("Job done", { key, ms: Date.now() - start })
      }
    }
  })

  if (!enq.ok) {
    log.warn("Queue full; dropping event", { key })
    return
  }
  if (enq.deduped) log.info("Deduped event (already running)", { key })
  else log.info("Enqueued job", { key, pending: pending.size, running })
}

async function processPullRequest(repoFull: string, prNumber: number) {
  const timeoutMs = Math.max(1, env.jobTimeoutSeconds) * 1000

  const { owner: codeOwner, repo: codeName } = parseRepo(repoFull)
  const { owner: docsOwner, repo: docsName } = parseRepo(env.docsRepo)

  const codeInst = await createInstallationOctokit({
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
    owner: codeOwner,
    repo: codeName
  })

  const docsInst = await createInstallationOctokit({
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
    owner: docsOwner,
    repo: docsName
  })

  const pr = await codeInst.octokit.pulls.get({
    owner: codeOwner,
    repo: codeName,
    pull_number: prNumber
  })

  const files = await codeInst.octokit.pulls.listFiles({
    owner: codeOwner,
    repo: codeName,
    pull_number: prNumber,
    per_page: 100
  })

  const prFiles = files.data.map((f: any) => f.filename).filter(Boolean)

  const patchResp = await codeInst.octokit.pulls.get({
    owner: codeOwner,
    repo: codeName,
    pull_number: prNumber,
    mediaType: { format: "patch" }
  })

  const patch = truncateLines(String(patchResp.data ?? ""), env.maxPatchLines)

  const baseBranch = await getDefaultBranch(docsInst.octokit, docsOwner, docsName)
  const branch = `docs-agent/${codeOwner}-${codeName}-pr-${prNumber}`

  const runRes = await generateDocsForPr({
    docsRepo: env.docsRepo,
    docsToken: docsInst.token,
    baseBranch,
    branch,
    codeRepo: repoFull,
    prNumber,
    prTitle: pr.data.title ?? "",
    prBody: pr.data.body ?? "",
    prUrl: pr.data.html_url ?? "",
    prFiles,
    prPatch: patch,
    dataDir: env.dataDir,
    timeoutMs,
    logOpencode: env.logOpencode || env.logLevel === "debug",
    opencode: {
      baseUrl: env.opencodeBaseUrl,
      apiKey: env.myApiKey,
      providerId: env.opencodeProviderId,
      modelRaw: env.opencodeModelRaw,
      apiUrl: env.opencodeApiUrl,
      variant: env.opencodeVariant
    }
  })

  if (!runRes.changed) {
    log.info("No docs changes; comment only", { prNumber })
    await codeInst.octokit.issues.createComment({
      owner: codeOwner,
      repo: codeName,
      issue_number: prNumber,
      body: [
        "本次运行未生成文档变更（文档仓库无改动）。",
        "",
        `Docs repo: ${env.docsRepo}`,
        ...(runRes.summary
          ? [
              "",
              "---",
              "AI 改动摘要（未提交，仅供参考）：",
              "",
              runRes.summary.length > 3500 ? `${runRes.summary.slice(0, 3500)}\n\n(…truncated)` : runRes.summary
            ]
          : [])
      ].join("\n")
    })
    return
  }

  await commitAndPushDocsBranch({
    docsRepo: env.docsRepo,
    docsToken: docsInst.token,
    checkoutDir: runRes.checkoutDir,
    branch,
    commitMessage: `docs: update for ${repoFull}#${prNumber}`,
    timeoutMs
  })

  const docsPrUrl = await ensureDocsPr({
    octokit: docsInst.octokit,
    docsOwner,
    docsRepo: docsName,
    head: branch,
    base: baseBranch,
    title: `Docs: ${repoFull}#${prNumber}`,
    body: [
      "由 astrbot-docs-agent-server 自动生成。",
      "",
      `- 上游 PR: https://github.com/${repoFull}/pull/${prNumber}`,
      ...(runRes.summary
        ? [
            "",
            "---",
            "AI 改动摘要：",
            "",
            runRes.summary.length > 5000 ? `${runRes.summary.slice(0, 5000)}\n\n(…truncated)` : runRes.summary
          ]
        : []),
      "",
      "请人工审核后合并。"
    ].join("\n")
  })

  await codeInst.octokit.issues.createComment({
    owner: codeOwner,
    repo: codeName,
    issue_number: prNumber,
    body: [
      "已为该 PR 生成文档更新 PR（待人工审核）：",
      docsPrUrl,
      ...(runRes.summary
        ? [
            "",
            "---",
            "AI 改动摘要：",
            "",
            runRes.summary.length > 3500 ? `${runRes.summary.slice(0, 3500)}\n\n(…truncated)` : runRes.summary
          ]
        : [])
    ].join("\n")
  })

  log.info("Done", { prNumber, docsPrUrl })
}

const app = express()

app.get("/healthz", (_req, res) => res.status(200).send("ok"))
app.get("/queue", (_req, res) => {
  res.json({
    running,
    inflight: [...inflight.values()],
    pending: [...pending.keys()],
    maxConcurrentJobs: env.maxConcurrentJobs,
    maxQueueSize: env.maxQueueSize
  })
})

// Keep raw body for signature verification
app.post(
  "/webhooks/github",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const id = req.header("x-github-delivery") ?? ""
      const name = req.header("x-github-event") ?? ""
      const signature = req.header("x-hub-signature-256") ?? ""

      await webhooks.verifyAndReceive({
        id,
        name,
        signature,
        payload: (req.body as Buffer).toString("utf-8")
      })

      res.status(202).send("accepted")
    } catch (e: any) {
      log.warn("Webhook rejected", { err: String(e?.message ?? e) })
      res.status(400).send("bad request")
    }
  }
)

app.listen(env.port, "0.0.0.0", () => {
  log.info(`Listening on :${env.port}`)
  log.info("Allowlisted code repos", { codeRepos: env.codeRepos, docsRepo: env.docsRepo })
})
