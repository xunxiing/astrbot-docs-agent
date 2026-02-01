import { readFileSync } from "node:fs";
function required(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing env: ${name}`);
    return value;
}
function optional(name) {
    const value = process.env[name];
    return value && value.length > 0 ? value : undefined;
}
export const env = {
    port: Number(optional("PORT") ?? "8787"),
    logLevel: optional("LOG_LEVEL") ?? "info",
    githubAppId: required("GITHUB_APP_ID"),
    githubAppPrivateKey: (() => {
        const file = optional("GITHUB_APP_PRIVATE_KEY_FILE");
        if (file)
            return readFileSync(file, "utf-8");
        return required("GITHUB_APP_PRIVATE_KEY");
    })(),
    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    // One or more code repos that can trigger jobs.
    // Prefer CODE_REPOS="owner1/repo1,owner2/repo2" if you want multiple.
    codeRepos: (() => {
        const raw = optional("CODE_REPOS") ?? required("CODE_REPO");
        return raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    })(),
    docsRepo: required("DOCS_REPO"),
    opencodeBaseUrl: required("OPENCODE_BASE_URL"),
    myApiKey: required("MY_API_KEY"),
    // OpenCode model resolution:
    // - If OPENCODE_MODEL contains "/", it's treated as provider/model
    // - If OPENCODE_MODEL has no "/", it's treated as model id and combined with OPENCODE_PROVIDER_ID
    opencodeProviderId: optional("OPENCODE_PROVIDER_ID") ?? "my-thirdparty",
    opencodeModelRaw: optional("OPENCODE_MODEL") ?? "my-model",
    // Optional: override the full OpenAI-compatible chat/completions URL if your provider doesn't follow /v1.
    // Example: https://api.xxx.com/v1/chat/completions
    opencodeApiUrl: optional("OPENCODE_API_URL"),
    // OpenCode run variant. Use "minimal" to avoid providers that require reasoning_content when thinking is enabled.
    opencodeVariant: optional("OPENCODE_VARIANT") ?? "minimal",
    dataDir: optional("DATA_DIR") ?? "/data",
    // Controls to prevent VPS overload
    maxConcurrentJobs: Number(optional("MAX_CONCURRENT_JOBS") ?? "1"),
    maxQueueSize: Number(optional("MAX_QUEUE_SIZE") ?? "10"),
    jobTimeoutSeconds: Number(optional("JOB_TIMEOUT_SECONDS") ?? "900"),
    maxPatchLines: Number(optional("MAX_PATCH_LINES") ?? "1200")
};
