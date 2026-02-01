import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";
function parseRepo(full) {
    const [owner, repo] = full.split("/", 2);
    if (!owner || !repo)
        throw new Error(`Invalid repo: ${full}`);
    return { owner, repo };
}
function toAuthGitUrl(token, repoFull) {
    return `https://x-access-token:${token}@github.com/${repoFull}.git`;
}
export async function generateDocsForPr(params) {
    const { owner: docsOwner, repo: docsName } = parseRepo(params.docsRepo);
    const workRoot = path.join(params.dataDir, "runs", `${docsOwner}-${docsName}`, `pr-${params.prNumber}`);
    await mkdir(workRoot, { recursive: true });
    const checkoutDir = path.join(workRoot, "docs");
    // Keep the previous checkout dir if it exists; this allows re-runs without re-downloading everything.
    // We still reset git to the correct branch below.
    const cloneUrl = toAuthGitUrl(params.docsToken, params.docsRepo);
    const ensureRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (ensureRepo.code !== 0) {
        const clone = await run("git", ["clone", "--depth=1", cloneUrl, checkoutDir], { timeoutMs: params.timeoutMs });
        if (clone.code !== 0)
            throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
    }
    // Ensure we're on the correct base branch BEFORE running opencode (otherwise later reset/checkout would drop changes).
    const fetchBase = await run("git", ["fetch", "origin", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (fetchBase.code !== 0)
        throw new Error(`git fetch failed: ${fetchBase.stderr || fetchBase.stdout}`);
    const checkoutBase = await run("git", ["checkout", params.baseBranch], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (checkoutBase.code !== 0)
        throw new Error(`git checkout failed: ${checkoutBase.stderr || checkoutBase.stdout}`);
    const resetBase = await run("git", ["reset", "--hard", `origin/${params.baseBranch}`], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (resetBase.code !== 0)
        throw new Error(`git reset failed: ${resetBase.stderr || resetBase.stdout}`);
    const checkoutBranch = await run("git", ["checkout", "-B", params.branch], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (checkoutBranch.code !== 0)
        throw new Error(`git checkout -B failed: ${checkoutBranch.stderr || checkoutBranch.stdout}`);
    const runtimeDir = path.join(workRoot, "runtime");
    await mkdir(runtimeDir, { recursive: true });
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
    ].join("\n");
    const prContextPath = path.join(runtimeDir, "pr_context.md");
    await writeFile(prContextPath, contextMd, "utf-8");
    const resolveModel = () => {
        const raw = params.opencode.modelRaw.trim();
        if (raw.includes("/")) {
            const [providerId, modelId] = raw.split("/", 2);
            if (!providerId || !modelId)
                throw new Error(`Invalid OPENCODE_MODEL: "${raw}" (expected provider/model)`);
            return { providerId, modelId };
        }
        // Treat as model id
        return { providerId: params.opencode.providerId, modelId: raw };
    };
    const { providerId, modelId } = resolveModel();
    const baseUrlNormalized = params.opencode.baseUrl.trim().replace(/\/$/, "");
    const apiUrl = (params.opencode.apiUrl && params.opencode.apiUrl.trim()) || undefined;
    // Write an external config file (outside the git repo) and load via OPENCODE_CONFIG.
    // This avoids committing opencode runtime files into the docs repo.
    const runtimeOpencodeConfig = {
        $schema: "https://opencode.ai/config.json",
        provider: {
            [providerId]: {
                npm: "@ai-sdk/openai-compatible",
                name: providerId,
                options: {
                    baseURL: baseUrlNormalized,
                    apiKey: "{env:MY_API_KEY}"
                },
                models: {
                    [modelId]: { name: modelId }
                }
            }
        },
        model: `${providerId}/${modelId}`
    };
    if (apiUrl) {
        // @ts-expect-error - optional field supported by opencode config schema (Provider.api)
        runtimeOpencodeConfig.provider[providerId].api = apiUrl;
    }
    const opencodeConfigPath = path.join(runtimeDir, "opencode.runtime.json");
    await writeFile(opencodeConfigPath, JSON.stringify(runtimeOpencodeConfig, null, 2), "utf-8");
    const prompt = [
        "你是一个严谨的文档维护者。",
        "",
        "你将收到一份来自代码仓库 PR 的上下文（标题、描述、改动文件列表、diff 截断）。",
        "请在当前文档仓库中：",
        "1) 找到最合适的文档位置并更新（或新增）Markdown 文档来覆盖此次 PR 的用户可见变更。",
        "2) 如果仓库存在 changelog / release notes / 版本记录，请补充一条对应内容。",
        "3) 避免臆测：仅根据上下文与仓库现有内容输出；若信息不足，请在文档中注明 TODO/待确认点，而不是编造。",
        "4) 只修改文档仓库内的文档内容（例如 *.md/*.mdx），不要改 CI、脚本、依赖。",
        "5) 不要创建占位文件（例如 `docs.md`、`content.md`），也不要改动任何 CI/脚本/依赖配置。",
        "",
        "输出以“直接修改文件”的方式完成（在仓库里落地改动），不要只给建议。"
    ].join("\n");
    const prefixer = (prefix) => {
        let buffer = "";
        return (chunk) => {
            buffer += chunk;
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() ?? "";
            for (const line of parts)
                console.log(`${prefix}${line}`);
        };
    };
    const opencodeRun = await run("opencode", 
    // yargs 的 `--file/-f` 是 array，会吞掉后续参数；用 `--` 把 prompt 强制放到 args["--"] 里
    ["run", "--model", `${providerId}/${modelId}`, "--variant", params.opencode.variant, "-f", prContextPath, "--", prompt], {
        cwd: checkoutDir,
        timeoutMs: params.timeoutMs,
        env: {
            MY_API_KEY: params.opencode.apiKey,
            OPENCODE_BASE_URL: baseUrlNormalized,
            OPENCODE_CONFIG: opencodeConfigPath,
            OPENCODE_DISABLE_PROJECT_CONFIG: "true"
        },
        ...(params.logOpencode
            ? {
                onStdout: prefixer("[opencode] "),
                onStderr: prefixer("[opencode:err] ")
            }
            : {})
    });
    if (opencodeRun.code !== 0)
        throw new Error(`opencode failed: ${opencodeRun.stderr || opencodeRun.stdout}`);
    const status = await run("git", ["status", "--porcelain=v1"], { cwd: checkoutDir, timeoutMs: params.timeoutMs });
    if (status.code !== 0)
        throw new Error(`git status failed: ${status.stderr}`);
    const changed = status.stdout.trim().length > 0;
    return { checkoutDir, workRoot, changed };
}
export async function commitAndPushDocsBranch(params) {
    const originUrl = toAuthGitUrl(params.docsToken, params.docsRepo);
    const setUser = await run("git", ["config", "user.name", "astrbot-docs-agent[bot]"], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    });
    if (setUser.code !== 0)
        throw new Error(setUser.stderr);
    const setEmail = await run("git", ["config", "user.email", "astrbot-docs-agent[bot]@users.noreply.github.com"], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    });
    if (setEmail.code !== 0)
        throw new Error(setEmail.stderr);
    // Ensure origin uses token
    const setOrigin = await run("git", ["remote", "set-url", "origin", originUrl], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    });
    if (setOrigin.code !== 0)
        throw new Error(setOrigin.stderr);
    const add = await run("git", ["add", "-A"], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs });
    if (add.code !== 0)
        throw new Error(add.stderr);
    // Safety: never include opencode runtime files even if they exist in the docs repo.
    await run("git", ["reset", "--", "opencode.json", ".opencode", "docs.md", "content.md"], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    });
    // Also revert them in the working tree to avoid leaving the checkout dirty (ignore errors if paths don't exist).
    await run("git", ["checkout", "--", "opencode.json", ".opencode", "docs.md", "content.md"], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    }).catch(() => undefined);
    const commit = await run("git", ["commit", "-m", params.commitMessage], { cwd: params.checkoutDir, timeoutMs: params.timeoutMs });
    if (commit.code !== 0)
        throw new Error(commit.stderr || commit.stdout);
    const push = await run("git", ["push", "--force", "--set-upstream", "origin", params.branch], {
        cwd: params.checkoutDir,
        timeoutMs: params.timeoutMs
    });
    if (push.code !== 0)
        throw new Error(push.stderr);
}
