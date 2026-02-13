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

/**
 * Get file content from repository using GitHub API
 */
export async function getFileContent(params: {
  octokit: Octokit
  owner: string
  repo: string
  path: string
  ref?: string
}): Promise<{ content: string; sha: string } | null> {
  const { octokit, owner, repo, path, ref } = params

  return withRetry(
    async () => {
      try {
        const response = await octokit.repos.getContent({
          owner,
          repo,
          path,
          ...(ref ? { ref } : {})
        })

        if (Array.isArray(response.data)) return null // Directory
        if (!("content" in response.data)) return null

        const content = Buffer.from(response.data.content, "base64").toString("utf-8")
        return { content, sha: response.data.sha }
      } catch (e: any) {
        if (e.status === 404) return null
        throw e
      }
    },
    { maxRetries: 3 }
  )
}

/**
 * Create or update file content using GitHub API
 */
export async function createOrUpdateFile(params: {
  octokit: Octokit
  owner: string
  repo: string
  path: string
  message: string
  content: string
  branch: string
  sha?: string
}) {
  const { octokit, owner, repo, path, message, content, branch, sha } = params
  return withRetry(
    async () => {
      return await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString("base64"),
        branch,
        sha
      })
    },
    { maxRetries: 3 }
  )
}

/**
 * Update multiple files in a single commit using the Git Data API
 * This is more robust than multiple createOrUpdateFile calls
 */
export async function commitFilesViaApi(params: {
  octokit: Octokit
  owner: string
  repo: string
  branch: string
  baseBranch: string
  message: string
  files: { path: string; content: string }[]
}) {
  const { octokit, owner, repo, branch, baseBranch, message, files } = params

  return withRetry(async () => {
    // 1. Get the latest commit SHA of the base branch
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    })
    const baseSha = baseRef.data.object.sha

    // 2. Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const blob = await octokit.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64"
        })
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.data.sha
        }
      })
    )

    // 3. Create a new tree
    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseSha,
      tree: treeItems
    })

    // 4. Create a commit
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.data.sha,
      parents: [baseSha]
    })

    // 5. Create or update the branch reference
    try {
      // Try to update existing branch
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: true
      })
    } catch (e: any) {
      if (e.status === 404) {
        // Create new branch
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: commit.data.sha
        })
      } else {
        throw e
      }
    }

    return { sha: commit.data.sha }
  })
}

