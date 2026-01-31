import { spawn } from "node:child_process";
export async function run(cmd, args, opts = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        const timeoutMs = opts.timeoutMs ?? 0;
        let timeout;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    // ignore
                }
            }, timeoutMs);
        }
        child.on("close", (code) => {
            if (timeout)
                clearTimeout(timeout);
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}
