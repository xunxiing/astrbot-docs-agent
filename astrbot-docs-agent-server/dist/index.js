import express from "express";
import { Webhooks } from "@octokit/webhooks";
import { env } from "./env.js";
import { createInstallationOctokit } from "./github.js";
import { createLogger } from "./log.js";
import { commitAndPushDocsBranch, generateDocsForPr } from "./docs-agent.js";
const log = createLogger(env.logLevel);
const pending = new Map();
const inflight = new Set();
let running = 0;
function enqueue(job) {
    if (inflight.has(job.key))
        return { ok: true, deduped: true };
    if (pending.has(job.key))
        pending.delete(job.key); // move to end (newest wins)
    if (!pending.has(job.key) && pending.size >= env.maxQueueSize)
        return { ok: false, reason: "queue_full" };
    pending.set(job.key, job);
    pump();
    return { ok: true, deduped: false };
}
function pump() {
    while (running < env.maxConcurrentJobs && pending.size > 0) {
        const [key, job] = pending.entries().next().value;
        pending.delete(key);
        inflight.add(key);
        running += 1;
        job.startedAt = Date.now();
        void job
            .run()
            .catch((e) => log.error("Job failed", { key, err: String(e?.message ?? e) }))
            .finally(() => {
            running -= 1;
            inflight.delete(key);
            pump();
        });
    }
}
function parseRepo(full) {
    const [owner, repo] = full.split("/", 2);
    if (!owner || !repo)
        throw new Error(`Invalid repo: ${full}`);
    return { owner, repo };
}
function truncateLines(text, maxLines) {
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines)
        return text;
    return lines.slice(0, maxLines).join("\n") + `\n\n# --- truncated (${lines.length - maxLines} more lines) ---\n`;
}
async function getDefaultBranch(octokit, owner, repo) {
    const r = await octokit.repos.get({ owner, repo });
    return r.data.default_branch;
}
async function ensureDocsPr(params) {
    const list = await params.octokit.pulls.list({
        owner: params.docsOwner,
        repo: params.docsRepo,
        state: "open",
        head: `${params.docsOwner}:${params.head}`
    });
    if (list.data.length > 0)
        return list.data[0].html_url;
    const pr = await params.octokit.pulls.create({
        owner: params.docsOwner,
        repo: params.docsRepo,
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body
    });
    return pr.data.html_url;
}
const webhooks = new Webhooks({ secret: env.githubWebhookSecret });
webhooks.on("pull_request.opened", handlePullRequest);
webhooks.on("pull_request.reopened", handlePullRequest);
webhooks.on("pull_request.synchronize", handlePullRequest);
webhooks.on("pull_request.edited", handlePullRequest);
async function handlePullRequest(event) {
    const repoFull = event.payload.repository?.full_name;
    const prNumber = event.payload.pull_request?.number;
    if (!repoFull || !prNumber) {
        log.warn("Webhook missing repo/pr", { repoFull, prNumber });
        return;
    }
    if (repoFull !== env.codeRepo) {
        log.warn("Ignored repo (not allowlisted)", { repoFull, allow: env.codeRepo });
        return;
    }
    const action = event.payload.action;
    log.info("PR event received", { repo: repoFull, prNumber, action });
    const key = `${repoFull}#${prNumber}`;
    const enq = enqueue({
        key,
        run: async () => {
            const start = Date.now();
            log.info("Job start", { key });
            try {
                await processPullRequest(repoFull, prNumber);
            }
            finally {
                log.info("Job done", { key, ms: Date.now() - start });
            }
        }
    });
    if (!enq.ok) {
        log.warn("Queue full; dropping event", { key });
        return;
    }
    if (enq.deduped)
        log.info("Deduped event (already running)", { key });
    else
        log.info("Enqueued job", { key, pending: pending.size, running });
}
async function processPullRequest(repoFull, prNumber) {
    const timeoutMs = Math.max(1, env.jobTimeoutSeconds) * 1000;
    const { owner: codeOwner, repo: codeName } = parseRepo(env.codeRepo);
    const { owner: docsOwner, repo: docsName } = parseRepo(env.docsRepo);
    const codeInst = await createInstallationOctokit({
        appId: env.githubAppId,
        privateKey: env.githubAppPrivateKey,
        owner: codeOwner,
        repo: codeName
    });
    const docsInst = await createInstallationOctokit({
        appId: env.githubAppId,
        privateKey: env.githubAppPrivateKey,
        owner: docsOwner,
        repo: docsName
    });
    const pr = await codeInst.octokit.pulls.get({
        owner: codeOwner,
        repo: codeName,
        pull_number: prNumber
    });
    const files = await codeInst.octokit.pulls.listFiles({
        owner: codeOwner,
        repo: codeName,
        pull_number: prNumber,
        per_page: 100
    });
    const prFiles = files.data.map((f) => f.filename).filter(Boolean);
    const patchResp = await codeInst.octokit.pulls.get({
        owner: codeOwner,
        repo: codeName,
        pull_number: prNumber,
        mediaType: { format: "patch" }
    });
    const patch = truncateLines(String(patchResp.data ?? ""), env.maxPatchLines);
    const runRes = await generateDocsForPr({
        docsRepo: env.docsRepo,
        docsToken: docsInst.token,
        codeRepo: env.codeRepo,
        prNumber,
        prTitle: pr.data.title ?? "",
        prBody: pr.data.body ?? "",
        prUrl: pr.data.html_url ?? "",
        prFiles,
        prPatch: patch,
        dataDir: env.dataDir,
        timeoutMs,
        opencode: {
            baseUrl: env.opencodeBaseUrl,
            apiKey: env.myApiKey,
            model: env.opencodeModel
        }
    });
    if (!runRes.changed) {
        log.info("No docs changes; comment only", { prNumber });
        await codeInst.octokit.issues.createComment({
            owner: codeOwner,
            repo: codeName,
            issue_number: prNumber,
            body: `本次运行未生成文档变更（文档仓库无改动）。\n\nDocs repo: ${env.docsRepo}`
        });
        return;
    }
    const baseBranch = await getDefaultBranch(docsInst.octokit, docsOwner, docsName);
    const branch = `docs-agent/${codeOwner}-${codeName}-pr-${prNumber}`;
    await commitAndPushDocsBranch({
        docsRepo: env.docsRepo,
        docsToken: docsInst.token,
        checkoutDir: runRes.checkoutDir,
        baseBranch,
        branch,
        commitMessage: `docs: update for ${env.codeRepo}#${prNumber}`,
        timeoutMs
    });
    const docsPrUrl = await ensureDocsPr({
        octokit: docsInst.octokit,
        docsOwner,
        docsRepo: docsName,
        head: branch,
        base: baseBranch,
        title: `Docs: ${env.codeRepo}#${prNumber}`,
        body: `由 astrbot-docs-agent-server 自动生成。\n\n- 上游 PR: https://github.com/${env.codeRepo}/pull/${prNumber}\n\n请人工审核后合并。`
    });
    await codeInst.octokit.issues.createComment({
        owner: codeOwner,
        repo: codeName,
        issue_number: prNumber,
        body: `已为该 PR 生成文档更新 PR（待人工审核）：\n${docsPrUrl}`
    });
    log.info("Done", { prNumber, docsPrUrl });
}
const app = express();
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/queue", (_req, res) => {
    res.json({
        running,
        inflight: [...inflight.values()],
        pending: [...pending.keys()],
        maxConcurrentJobs: env.maxConcurrentJobs,
        maxQueueSize: env.maxQueueSize
    });
});
// Keep raw body for signature verification
app.post("/webhooks/github", express.raw({ type: "*/*" }), async (req, res) => {
    try {
        const id = req.header("x-github-delivery") ?? "";
        const name = req.header("x-github-event") ?? "";
        const signature = req.header("x-hub-signature-256") ?? "";
        await webhooks.verifyAndReceive({
            id,
            name,
            signature,
            payload: req.body.toString("utf-8")
        });
        res.status(202).send("accepted");
    }
    catch (e) {
        log.warn("Webhook rejected", { err: String(e?.message ?? e) });
        res.status(400).send("bad request");
    }
});
app.listen(env.port, "0.0.0.0", () => {
    log.info(`Listening on :${env.port}`);
});
