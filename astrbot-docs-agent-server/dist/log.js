const order = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(level) {
    const min = order[level] ?? order.info;
    const ok = (l) => order[l] >= min;
    const fmt = (l, msg, extra) => {
        const base = `${new Date().toISOString()} ${l.toUpperCase()} ${msg}`;
        if (extra === undefined)
            return base;
        try {
            return `${base} ${JSON.stringify(extra)}`;
        }
        catch {
            return base;
        }
    };
    return {
        debug: (msg, extra) => ok("debug") && console.log(fmt("debug", msg, extra)),
        info: (msg, extra) => ok("info") && console.log(fmt("info", msg, extra)),
        warn: (msg, extra) => ok("warn") && console.warn(fmt("warn", msg, extra)),
        error: (msg, extra) => ok("error") && console.error(fmt("error", msg, extra))
    };
}
