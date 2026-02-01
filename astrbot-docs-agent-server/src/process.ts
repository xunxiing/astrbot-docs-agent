import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const FALLBACK_BIN: Record<string, string[]> = {
  git: ["/usr/bin/git", "/bin/git"],
  opencode: ["/usr/local/bin/opencode", "/usr/bin/opencode", "/bin/opencode"],
}

export async function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
    /**
     * Keep at most this many characters of stdout/stderr in memory (tail).
     * This prevents large subprocess outputs (e.g. opencode) from exhausting memory.
     *
     * Can be overridden via env `PROCESS_MAX_CAPTURE_CHARS` (default 200000).
     */
    maxCaptureChars?: number
  } = {}
) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const fullEnv = { ...process.env, ...opts.env }

    const defaultMaxCaptureChars = (() => {
      const raw = process.env.PROCESS_MAX_CAPTURE_CHARS
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200_000
    })()
    const maxCaptureChars = opts.maxCaptureChars ?? defaultMaxCaptureChars

    const appendCapped = (current: string, chunk: string) => {
      if (maxCaptureChars <= 0) return current
      const next = current + chunk
      if (next.length <= maxCaptureChars) return next
      return next.slice(-maxCaptureChars)
    }

    const spawnOnce = (command: string) =>
      spawn(command, args, {
        cwd: opts.cwd,
        env: fullEnv,
        stdio: ["ignore", "pipe", "pipe"]
      })

    let child = spawnOnce(cmd)
    let stdout = ""
    let stderr = ""
    const attach = () => {
      child.stdout.on("data", (d) => {
        const s = d.toString()
        stdout = appendCapped(stdout, s)
        opts.onStdout?.(s)
      })
      child.stderr.on("data", (d) => {
        const s = d.toString()
        stderr = appendCapped(stderr, s)
        opts.onStderr?.(s)
      })
    }
    attach()

    let retried = false
    child.on("error", (err: any) => {
      if (!retried && err && err.code === "ENOENT") {
        const fallbacks = FALLBACK_BIN[cmd] ?? []
        const fallback = fallbacks.find((p) => existsSync(p))
        if (fallback) {
          retried = true
          child = spawnOnce(fallback)
          attach()
          child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }))
          child.on("error", reject)
          return
        }
      }
      reject(err)
    })

    const timeoutMs = opts.timeoutMs ?? 0
    let timeout: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }, timeoutMs)
    }

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout)
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}
