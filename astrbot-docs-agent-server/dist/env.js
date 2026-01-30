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
    codeRepo: required("CODE_REPO"),
    docsRepo: required("DOCS_REPO"),
    opencodeBaseUrl: required("OPENCODE_BASE_URL"),
    myApiKey: required("MY_API_KEY"),
    opencodeModel: optional("OPENCODE_MODEL") ?? "my-thirdparty/my-model",
    dataDir: optional("DATA_DIR") ?? "/data"
};
