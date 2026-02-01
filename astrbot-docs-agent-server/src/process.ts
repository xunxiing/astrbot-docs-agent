import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const FALLBACK_BIN: Record<string, string[]> = {
  git: ["/usr/bin/git", "/bin/git"],
  opencode: ["/usr/local/bin/opencode", "/usr/bin/opencode", "/bin/opencode"],
}

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {}
) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const fullEnv = { ...process.env, ...opts.env }

    const spawnOnce = (command: string) =>
      spawn(command, args, {
        cwd: opts.cwd,
        env: fullEnv,
        stdio: ["ignore", "pipe", "pipe"]
      })

    let child = spawnOnce(cmd)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      const s = d.toString()
      stdout += s
      opts.onStdout?.(s)
    })
    child.stderr.on("data", (d) => {
      const s = d.toString()
      stderr += s
      opts.onStderr?.(s)
    })

    let retried = false
    child.on("error", (err: any) => {
      if (!retried && err && err.code === "ENOENT") {
        const fallbacks = FALLBACK_BIN[cmd] ?? []
        const fallback = fallbacks.find((p) => existsSync(p))
        if (fallback) {
          retried = true
          child = spawnOnce(fallback)
          child.stdout.on("data", (d) => {
            const s = d.toString()
            stdout += s
            opts.onStdout?.(s)
          })
          child.stderr.on("data", (d) => {
            const s = d.toString()
            stderr += s
            opts.onStderr?.(s)
          })
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
