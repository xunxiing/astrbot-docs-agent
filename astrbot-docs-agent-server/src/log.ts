type Level = "debug" | "info" | "warn" | "error"

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(level: Level) {
  const min = order[level] ?? order.info
  const ok = (l: Level) => order[l] >= min
  const fmt = (l: Level, msg: string, extra?: unknown) => {
    const base = `${new Date().toISOString()} ${l.toUpperCase()} ${msg}`
    if (extra === undefined) return base
    try {
      return `${base} ${JSON.stringify(extra)}`
    } catch {
      return base
    }
  }
  return {
    debug: (msg: string, extra?: unknown) => ok("debug") && console.log(fmt("debug", msg, extra)),
    info: (msg: string, extra?: unknown) => ok("info") && console.log(fmt("info", msg, extra)),
    warn: (msg: string, extra?: unknown) => ok("warn") && console.warn(fmt("warn", msg, extra)),
    error: (msg: string, extra?: unknown) => ok("error") && console.error(fmt("error", msg, extra))
  }
}

