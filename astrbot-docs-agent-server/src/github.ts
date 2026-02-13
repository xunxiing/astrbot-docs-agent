import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"

export function createAppOctokit(appId: string, privateKey: string) {
  const auth = createAppAuth({ appId, privateKey })
  return { auth }
}

export async function createInstallationOctokit(params: {
  appId: string
  privateKey: string
  owner: string
  repo: string
}) {
  const appAuth = createAppAuth({ appId: params.appId, privateKey: params.privateKey })

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: params.appId, privateKey: params.privateKey }
  })

  const installation = await appOctokit.apps.getRepoInstallation({
    owner: params.owner,
    repo: params.repo
  })

  const token = await appAuth({
    type: "installation",
    installationId: installation.data.id
  })

  const octokit = new Octokit({ auth: token.token })
  return { octokit, token: token.token }
}

/**
 * Retry wrapper for GitHub API calls with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    baseDelayMs?: number
    maxDelayMs?: number
    isRetryable?: (error: any) => boolean
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 30000

  const defaultIsRetryable = (error: any): boolean => {
    const status = error?.status
    // Retry on rate limit, server errors, and network issues
    if (status === 429 || (status >= 500 && status < 600)) return true
    // Retry on network/timeout errors
    if (error?.code === "ETIMEDOUT" || error?.code === "ENOTFOUND" || error?.code === "ECONNRESET") return true
    // Check for specific error messages
    const msg = String(error?.message || "").toLowerCase()
    if (msg.includes("rate limit") || msg.includes("timeout") || msg.includes("network")) return true
    return false
  }

  const isRetryable = options.isRetryable ?? defaultIsRetryable

  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < maxRetries && isRetryable(error)) {
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
        const jitter = Math.random() * 500
        await new Promise((r) => setTimeout(r, delayMs + jitter))
        continue
      }
      throw error
    }
  }
  throw lastError
}

