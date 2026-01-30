import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
export function createAppOctokit(appId, privateKey) {
    const auth = createAppAuth({ appId, privateKey });
    return { auth };
}
export async function createInstallationOctokit(params) {
    const appAuth = createAppAuth({ appId: params.appId, privateKey: params.privateKey });
    const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: params.appId, privateKey: params.privateKey }
    });
    const installation = await appOctokit.apps.getRepoInstallation({
        owner: params.owner,
        repo: params.repo
    });
    const token = await appAuth({
        type: "installation",
        installationId: installation.data.id
    });
    const octokit = new Octokit({ auth: token.token });
    return { octokit, token: token.token };
}
